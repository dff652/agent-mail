/** Durable, provider-owned new-identity enrollment for one Hub. */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { atomicWriteText, withFileLockSync } from "./atomic-file.js";
import {
  claimPairingForEnrollment,
  finalizePairingEnrollment,
  findPairingEnrollment,
  pairingStatus,
  PairingError,
  type PairingEnrollmentClaim,
  type PairingEnrollmentOwner,
} from "./pairing.js";
import {
  deleteTokenRecordIfCurrentLocked,
  hashToken,
  loadTokenRecords,
  mintPreparedTokenWithSnapshotLocked,
  withHubStateLock,
} from "./hub/auth.js";
import {
  ensureAgentLocked,
  loadRoster,
  removeAgentIfOwnedLocked,
  type AgentRecord,
} from "./roster.js";
import { validateAgentId } from "./ids.js";

export const DEFAULT_ENROLLMENT_TTL_SECONDS = 600;

export type EnrollmentState =
  | "preparing"
  | "pending_save"
  | "committed"
  | "cancelled"
  | "expired"
  | "cleanup_pending"
  | "cleanup_conflict";

type EnrollmentStage =
  | "prepared"
  | "credential_pending"
  | "credential_stored"
  | "roster_pending"
  | "roster_added"
  | "token_pending"
  | "token_minted"
  | "pending_save"
  | "committed"
  | "cleanup_pending";

type CleanupTarget = "cancelled" | "expired";

export type EnrollmentErrorCode =
  | "code_invalid_or_expired"
  | "identity_conflict"
  | "identity_mismatch"
  | "context_expired"
  | "idempotency_conflict"
  | "cleanup_pending"
  | "cleanup_conflict"
  | "management_denied"
  | "enrollment_unavailable";

export class EnrollmentError extends Error {
  readonly code: EnrollmentErrorCode;
  readonly status: number;

  constructor(code: EnrollmentErrorCode, status = defaultStatus(code)) {
    super(code);
    this.name = "EnrollmentError";
    this.code = code;
    this.status = status;
  }
}

export interface RedeemEnrollmentInput {
  code: string;
  request_id: string;
  recovery_proof: string;
}

export interface EnrollmentReferenceInput {
  enrollment_id: string;
  recovery_proof: string;
}

export interface RecoverEnrollmentInput {
  request_id: string;
  recovery_proof: string;
}

export interface CommitEnrollmentInput extends EnrollmentReferenceInput {
  commit_id: string;
}

export interface EnrollmentOperationOptions {
  now?: Date;
}

export interface EnrollmentCredentialResult {
  enrollment_id: string;
  agent_id: string;
  token: string;
  expires_at: string;
  state: "pending_save" | "committed";
}

export interface EnrollmentSafeState {
  enrollment_id: string;
  agent_id: string | null;
  expires_at: string;
  state: EnrollmentState;
  created_at: string;
  commit_id: string | null;
  token_available: boolean;
  cleanup_state: "none" | "pending" | "conflict";
}

export interface EnrollmentSweepCounts {
  scanned: number;
  pending_save: number;
  committed: number;
  expired: number;
  cancelled: number;
  cleanup_pending: number;
  cleanup_conflict: number;
}

interface EnrollmentRecord {
  schema_version: 1;
  enrollment_id: string;
  request_id: string;
  request_fingerprint: string;
  recovery_proof_hash: string;
  code_hash: string;
  pair_id: string | null;
  agent_id: string | null;
  label: string;
  created_at: string;
  expires_at: string;
  state: EnrollmentState;
  stage: EnrollmentStage;
  token_path: string | null;
  token_hash: string | null;
  token_created_at: string | null;
  roster_generation: string | null;
  roster_agent: AgentRecord | null;
  commit_id: string | null;
  cleanup_target: CleanupTarget | null;
}

const JOURNAL_SCHEMA_VERSION = 1;
const REQUEST_ID_RE = /^[\x21-\x7e]{1,256}$/;
const PROOF_RE = /^[\x21-\x7e]{32,512}$/;
const ENROLLMENT_ID_RE = /^enroll_[a-f0-9]{32}$/;
const COMMIT_ID_RE = /^[\x21-\x7e]{1,256}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const STAGES: readonly EnrollmentStage[] = [
  "prepared",
  "credential_pending",
  "credential_stored",
  "roster_pending",
  "roster_added",
  "token_pending",
  "token_minted",
  "pending_save",
  "committed",
  "cleanup_pending",
];
const STATES: readonly EnrollmentState[] = [
  "preparing",
  "pending_save",
  "committed",
  "cancelled",
  "expired",
  "cleanup_pending",
  "cleanup_conflict",
];

function defaultStatus(code: EnrollmentErrorCode): number {
  switch (code) {
    case "management_denied":
      return 403;
    case "code_invalid_or_expired":
      return 400;
    case "identity_conflict":
    case "idempotency_conflict":
    case "identity_mismatch":
    case "context_expired":
    case "cleanup_conflict":
      return 409;
    case "cleanup_pending":
    case "enrollment_unavailable":
      return 503;
  }
}

function journalPath(home: string): string {
  return path.join(path.resolve(home), "auth", "enrollments.json");
}

export function enrollmentJournalPath(home: string): string {
  return journalPath(home);
}

function authDirectory(home: string): string {
  const directory = path.dirname(journalPath(home));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  return directory;
}

function withJournalLock<T>(home: string, fn: () => T): T {
  authDirectory(home);
  return withFileLockSync(journalPath(home), fn);
}

function custodyDirectory(home: string): string {
  const directory = path.join(path.dirname(journalPath(home)), "enrollment-secrets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  return directory;
}

function custodyPath(home: string, enrollmentId: string): string {
  return path.join(custodyDirectory(home), `${enrollmentId}.token`);
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new EnrollmentError("enrollment_unavailable");
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nowFrom(options?: EnrollmentOperationOptions): Date {
  const now = options?.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new EnrollmentError("enrollment_unavailable");
  return now;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function proofHash(proof: string): string {
  return hashValue(proof);
}

function sameSecretHash(left: string, right: string): boolean {
  if (!HASH_RE.test(left) || !HASH_RE.test(right)) return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateRequest(requestId: string, proof: string): void {
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new EnrollmentError("management_denied");
  }
  if (!PROOF_RE.test(proof)) {
    throw new EnrollmentError("management_denied");
  }
}

function validateEnrollmentId(id: string): void {
  if (!ENROLLMENT_ID_RE.test(id)) throw new EnrollmentError("management_denied");
}

function validateCommitId(id: string): void {
  if (!COMMIT_ID_RE.test(id)) throw new EnrollmentError("management_denied");
}

function validateNowExpiry(record: EnrollmentRecord, now: Date): boolean {
  const expiry = Date.parse(record.expires_at);
  return Number.isFinite(expiry) && now.getTime() >= expiry;
}

function isAgentId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    validateAgentId(value);
    return true;
  } catch {
    return false;
  }
}

function readJournalUnlocked(home: string): EnrollmentRecord[] {
  const p = journalPath(home);
  if (!fs.existsSync(p)) return [];
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    throw new EnrollmentError("enrollment_unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  } catch {
    throw new EnrollmentError("enrollment_unavailable");
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).schema_version !== JOURNAL_SCHEMA_VERSION ||
    !Array.isArray((raw as Record<string, unknown>).enrollments)
  ) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  try {
    return ((raw as Record<string, unknown>).enrollments as unknown[]).map(
      parseRecord,
    );
  } catch (error) {
    if (error instanceof EnrollmentError) throw error;
    throw new EnrollmentError("enrollment_unavailable");
  }
}

function parseRecord(value: unknown): EnrollmentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  const stage = raw.stage;
  const cleanupTarget = raw.cleanup_target;
  if (
    raw.schema_version !== JOURNAL_SCHEMA_VERSION ||
    typeof raw.enrollment_id !== "string" ||
    !ENROLLMENT_ID_RE.test(raw.enrollment_id) ||
    typeof raw.request_id !== "string" ||
    !REQUEST_ID_RE.test(raw.request_id) ||
    typeof raw.request_fingerprint !== "string" ||
    !HASH_RE.test(raw.request_fingerprint) ||
    typeof raw.recovery_proof_hash !== "string" ||
    !HASH_RE.test(raw.recovery_proof_hash) ||
    typeof raw.code_hash !== "string" ||
    !HASH_RE.test(raw.code_hash) ||
    (raw.pair_id !== null &&
      (typeof raw.pair_id !== "string" || !/^pair_[a-f0-9]{32}$/.test(raw.pair_id))) ||
    (raw.agent_id !== null && !isAgentId(raw.agent_id)) ||
    typeof raw.label !== "string" ||
    typeof raw.created_at !== "string" ||
    !Number.isFinite(Date.parse(raw.created_at)) ||
    typeof raw.expires_at !== "string" ||
    !Number.isFinite(Date.parse(raw.expires_at)) ||
    typeof state !== "string" ||
    !(STATES as readonly string[]).includes(state) ||
    typeof stage !== "string" ||
    !(STAGES as readonly string[]).includes(stage) ||
    (raw.token_path !== null && typeof raw.token_path !== "string") ||
    (raw.token_hash !== null &&
      (typeof raw.token_hash !== "string" || !HASH_RE.test(raw.token_hash))) ||
    (raw.token_created_at !== null &&
      (typeof raw.token_created_at !== "string" ||
        !Number.isFinite(Date.parse(raw.token_created_at)))) ||
    (raw.roster_generation !== null &&
      (typeof raw.roster_generation !== "string" ||
        !ENROLLMENT_ID_RE.test(raw.roster_generation))) ||
    (raw.commit_id !== null && typeof raw.commit_id !== "string") ||
    (cleanupTarget !== null && cleanupTarget !== "cancelled" && cleanupTarget !== "expired")
  ) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  let rosterAgent: AgentRecord | null = null;
  if (raw.roster_agent !== null) {
    const agent = raw.roster_agent as Record<string, unknown>;
    if (
      !agent ||
      typeof agent !== "object" ||
      !isAgentId(agent.id) ||
      agent.id !== raw.agent_id ||
      agent.enrollment_generation !== raw.enrollment_id ||
      typeof agent.display_name !== "string" ||
      !Array.isArray(agent.skills) ||
      agent.skills.some((skill) => typeof skill !== "string")
    ) {
      throw new EnrollmentError("enrollment_unavailable");
    }
    rosterAgent = {
      id: agent.id,
      display_name: agent.display_name,
      skills: [...(agent.skills as string[])],
      enrollment_generation: raw.enrollment_id,
    };
  }
  return {
    schema_version: 1,
    enrollment_id: raw.enrollment_id,
    request_id: raw.request_id,
    request_fingerprint: raw.request_fingerprint,
    recovery_proof_hash: raw.recovery_proof_hash,
    code_hash: raw.code_hash,
    pair_id: raw.pair_id as string | null,
    agent_id: raw.agent_id as string | null,
    label: raw.label,
    created_at: raw.created_at,
    expires_at: raw.expires_at,
    state: state as EnrollmentState,
    stage: stage as EnrollmentStage,
    token_path: raw.token_path as string | null,
    token_hash: raw.token_hash as string | null,
    token_created_at: raw.token_created_at as string | null,
    roster_generation: raw.roster_generation as string | null,
    roster_agent: rosterAgent,
    commit_id: raw.commit_id as string | null,
    cleanup_target: cleanupTarget as CleanupTarget | null,
  };
}

function writeJournalUnlocked(home: string, records: EnrollmentRecord[]): void {
  authDirectory(home);
  atomicWriteText(
    journalPath(home),
    `${JSON.stringify({ schema_version: JOURNAL_SCHEMA_VERSION, enrollments: records }, null, 2)}\n`,
    0o600,
  );
}

function saveRecordUnlocked(home: string, records: EnrollmentRecord[], record: EnrollmentRecord): void {
  const index = records.findIndex((item) => item.enrollment_id === record.enrollment_id);
  if (index < 0) records.push(record);
  else records[index] = record;
  writeJournalUnlocked(home, records);
}

function removeRecordUnlocked(home: string, records: EnrollmentRecord[], enrollmentId: string): void {
  const next = records.filter((record) => record.enrollment_id !== enrollmentId);
  writeJournalUnlocked(home, next);
}

function findByRequest(records: EnrollmentRecord[], requestId: string): EnrollmentRecord | null {
  return records.find((record) => record.request_id === requestId) ?? null;
}

function findByEnrollment(records: EnrollmentRecord[], enrollmentId: string): EnrollmentRecord | null {
  return records.find((record) => record.enrollment_id === enrollmentId) ?? null;
}

function fingerprint(codeHash: string, requestId: string): string {
  return hashValue(`${codeHash}\0${requestId}`);
}

function verifyOwner(record: EnrollmentRecord, proof: string): void {
  if (!sameSecretHash(record.recovery_proof_hash, proofHash(proof))) {
    throw new EnrollmentError("management_denied");
  }
}

function safeState(record: EnrollmentRecord, home: string): EnrollmentSafeState {
  return {
    enrollment_id: record.enrollment_id,
    agent_id: record.agent_id,
    expires_at: record.expires_at,
    state: record.state,
    created_at: record.created_at,
    commit_id: record.commit_id,
    token_available:
      (record.state === "pending_save" || record.state === "committed") &&
      record.token_path !== null &&
      readCustodyToken(record, home) !== null,
    cleanup_state:
      record.state === "cleanup_conflict"
        ? "conflict"
        : record.state === "cleanup_pending"
          ? "pending"
          : "none",
  };
}

function credential(record: EnrollmentRecord, home: string): EnrollmentCredentialResult {
  if (
    !record.agent_id ||
    !record.token_path ||
    (record.state !== "pending_save" && record.state !== "committed")
  ) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  const token = readCustodyToken(record, home);
  if (!token) throw new EnrollmentError("enrollment_unavailable");
  return {
    enrollment_id: record.enrollment_id,
    agent_id: record.agent_id,
    token,
    expires_at: record.expires_at,
    state: record.state,
  };
}

function readCustodyToken(record: EnrollmentRecord, home: string): string | null {
  const p = record.token_path;
  if (!p || p !== custodyPath(home, record.enrollment_id)) return null;
  try {
    const stat = fs.lstatSync(p);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 32 ||
      stat.size > 512 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      return null;
    }
    const token = fs.readFileSync(p, "utf8").trim();
    if (!/^[\x21-\x7e]{32,512}$/.test(token)) return null;
    if (record.token_hash && !sameSecretHash(hashToken(token), record.token_hash)) return null;
    return token;
  } catch {
    return null;
  }
}

function storeCustodyToken(record: EnrollmentRecord, home: string, token: string): void {
  if (!record.token_path || record.token_path !== custodyPath(home, record.enrollment_id)) {
    throw new EnrollmentError("enrollment_unavailable");
  }
  try {
    atomicWriteText(record.token_path, `${token}\n`, 0o600);
  } catch {
    throw new EnrollmentError("enrollment_unavailable");
  }
}

function removeCustodyToken(record: EnrollmentRecord, home: string): boolean {
  if (!record.token_path) return true;
  if (!record.agent_id || record.token_path !== custodyPath(home, record.enrollment_id)) {
    return false;
  }
  try {
    const stat = fs.lstatSync(record.token_path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    fs.unlinkSync(record.token_path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function sameAgent(left: AgentRecord, right: AgentRecord): boolean {
  return isDeepStrictEqual(left, right);
}

/** Verify the exact credential and roster generation still belong to us. */
function ownsCurrentEnrollmentLocked(home: string, record: EnrollmentRecord): boolean {
  if (
    !record.agent_id ||
    !record.token_hash ||
    !record.token_created_at ||
    !record.roster_agent ||
    !record.roster_generation
  ) {
    return false;
  }
  const expectedAgent = record.roster_agent;
  const tokens = loadTokenRecords(home).filter((item) => item.agent_id === record.agent_id);
  if (
    tokens.length !== 1 ||
    tokens[0]?.token_hash !== record.token_hash ||
    tokens[0]?.created_at !== record.token_created_at
  ) {
    return false;
  }
  const roster = loadRoster(home);
  const current = roster.agents.find((agent) => agent.id === record.agent_id);
  return (
    current !== undefined &&
    current.enrollment_generation === record.roster_generation &&
    sameAgent(current, expectedAgent)
  );
}

function claimForRecord(
  home: string,
  record: EnrollmentRecord,
  code: string | null,
  now: Date,
): void {
  if (record.pair_id) return;
  const owner: PairingEnrollmentOwner = {
    enrollment_id: record.enrollment_id,
    request_id: record.request_id,
    request_fingerprint: record.request_fingerprint,
  };
  const recovered = findPairingEnrollment(home, owner);
  if (recovered) {
    record.pair_id = recovered.pair_id;
    record.agent_id = recovered.agent_id;
    record.label = recovered.label;
    const currentExpiry = Date.parse(record.expires_at);
    const pairingExpiry = Date.parse(recovered.expires_at);
    record.expires_at = new Date(
      Math.min(
        Number.isFinite(currentExpiry) ? currentExpiry : pairingExpiry,
        pairingExpiry,
      ),
    ).toISOString();
    return;
  }
  if (!code) throw new EnrollmentError("code_invalid_or_expired");
  let claim: PairingEnrollmentClaim;
  try {
    claim = claimPairingForEnrollment(home, code, owner, now);
  } catch (error) {
    if (error instanceof PairingError) {
      throw new EnrollmentError("code_invalid_or_expired");
    }
    throw new EnrollmentError("enrollment_unavailable");
  }
  record.pair_id = claim.pair_id;
  record.agent_id = claim.agent_id;
  record.label = claim.label;
  const currentExpiry = Date.parse(record.expires_at);
  const pairingExpiry = Date.parse(claim.expires_at);
  record.expires_at = new Date(
    Math.min(
      Number.isFinite(currentExpiry) ? currentExpiry : pairingExpiry,
      pairingExpiry,
    ),
  ).toISOString();
}

function markConflict(home: string, records: EnrollmentRecord[], record: EnrollmentRecord): never {
  // Do not touch pairing SQLite while holding the Hub lock: the legacy
  // redemption transaction takes those locks in the opposite order. Cleanup
  // after this throw performs the terminal pairing transition safely.
  record.state = "cleanup_pending";
  record.stage = "cleanup_pending";
  record.cleanup_target = "cancelled";
  saveRecordUnlocked(home, records, record);
  throw new EnrollmentError("identity_conflict");
}

function prepareRecordState(
  home: string,
  records: EnrollmentRecord[],
  record: EnrollmentRecord,
  now: Date,
): void {
  if (!record.agent_id) throw new EnrollmentError("enrollment_unavailable");
  const roster = loadRoster(home);
  const tokens = loadTokenRecords(home);

  const displayName = record.label.trim() || record.agent_id.split("@", 1)[0] || record.agent_id;
  const rosterAgent: AgentRecord = {
    id: record.agent_id,
    display_name: displayName,
    skills: ["paired"],
    enrollment_generation: record.enrollment_id,
  };
  if (!record.token_hash) {
    const token = randomBytes(32).toString("base64url");
    record.token_hash = hashToken(token);
    record.token_created_at = iso(now);
    record.token_path = custodyPath(home, record.enrollment_id);
    record.roster_agent = rosterAgent;
    record.roster_generation = record.enrollment_id;
    record.stage = "prepared";
    saveRecordUnlocked(home, records, record);
  }
  if (!record.token_path || !record.token_hash || !record.token_created_at || !record.roster_agent || !record.roster_generation) {
    throw new EnrollmentError("enrollment_unavailable");
  }

  const tokenRecords = tokens.filter((item) => item.agent_id === record.agent_id);
  const tokenOwned =
    tokenRecords.length === 1 &&
    tokenRecords[0]?.token_hash === record.token_hash &&
    tokenRecords[0]?.created_at === record.token_created_at;
  const currentAgent = roster.agents.find((agent) => agent.id === record.agent_id);
  const rosterOwned =
    currentAgent !== undefined &&
    currentAgent.enrollment_generation === record.roster_generation &&
    sameAgent(currentAgent, record.roster_agent);
  const tokenConflict = tokenRecords.length > 0 && !tokenOwned;
  const rosterConflict = currentAgent !== undefined && !rosterOwned;
  if (tokenConflict || rosterConflict) {
    const hasPartialState =
      record.token_path !== null ||
      record.stage !== "prepared" ||
      tokenOwned ||
      rosterOwned;
    if (!hasPartialState) markConflict(home, records, record);
    record.state = "cleanup_pending";
    record.stage = "cleanup_pending";
    record.cleanup_target = "cancelled";
    saveRecordUnlocked(home, records, record);
    throw new EnrollmentError("identity_conflict");
  }

  const token = readCustodyToken(record, home);
  if (!token) {
    if (tokenOwned) throw new EnrollmentError("enrollment_unavailable");
    const newToken = randomBytes(32).toString("base64url");
    if (hashToken(newToken) !== record.token_hash) {
      // The journal has only the hash by design; create the custody secret
      // once, then keep it stable for all retries.
      record.token_hash = hashToken(newToken);
    }
    record.stage = "credential_pending";
    saveRecordUnlocked(home, records, record);
    storeCustodyToken(record, home, newToken);
    record.stage = "credential_stored";
    saveRecordUnlocked(home, records, record);
  }

  record.stage = "roster_pending";
  saveRecordUnlocked(home, records, record);
  if (!rosterOwned) ensureAgentLocked(home, record.roster_agent, record.roster_generation);
  record.stage = "roster_added";
  saveRecordUnlocked(home, records, record);

  record.stage = "token_pending";
  saveRecordUnlocked(home, records, record);
  const custodyToken = readCustodyToken(record, home);
  if (!custodyToken) throw new EnrollmentError("enrollment_unavailable");
  if (!tokenOwned) {
    const minted = mintPreparedTokenWithSnapshotLocked(
      home,
      record.agent_id,
      record.label || "paired",
      custodyToken,
      record.token_created_at,
    );
    if (minted.issued_hash !== record.token_hash || minted.replaced.length !== 0) {
      throw new EnrollmentError("identity_conflict");
    }
  }
  record.stage = "token_minted";
  record.state = "pending_save";
  saveRecordUnlocked(home, records, record);
}

function resumeRecord(
  home: string,
  records: EnrollmentRecord[],
  record: EnrollmentRecord,
  now: Date,
  code: string | null,
): EnrollmentCredentialResult {
  if (record.state === "pending_save" || record.state === "committed") {
    if (record.state === "committed") return credential(record, home);
    if (validateNowExpiry(record, now)) {
      cleanupRecord(home, records, record, "expired");
      throw new EnrollmentError("context_expired");
    }
    return credential(record, home);
  }
  if (record.state === "cancelled" || record.state === "expired") {
    throw new EnrollmentError("context_expired");
  }
  if (record.state === "cleanup_conflict") throw new EnrollmentError("cleanup_conflict");
  if (record.state === "cleanup_pending") throw new EnrollmentError("cleanup_pending");
  if (validateNowExpiry(record, now)) {
    cleanupRecord(home, records, record, "expired");
    throw new EnrollmentError("code_invalid_or_expired");
  }
  claimForRecord(home, record, code, now);
  saveRecordUnlocked(home, records, record);
  try {
    return withHubStateLock(home, () => {
      try {
        prepareRecordState(home, records, record, now);
      } catch (error) {
        if (error instanceof EnrollmentError) throw error;
        throw new EnrollmentError("enrollment_unavailable");
      }
      return credential(record, home);
    });
  } catch (error) {
    // A restart can observe an enrollment-owned partial token/roster together
    // with a later independent mutation. Reconcile the owned portion after
    // releasing the Hub lock, then preserve the conflict in the journal.
    if (error instanceof EnrollmentError && error.code === "identity_conflict" && (record.state as EnrollmentState) === "cleanup_pending") {
      try {
        cleanupRecord(home, records, record, "cancelled");
      } catch {
        // sweepEnrollments will retry the durable cleanup state.
      }
    }
    throw error;
  }
}

function cleanupRecord(
  home: string,
  records: EnrollmentRecord[],
  record: EnrollmentRecord,
  target: CleanupTarget,
): EnrollmentSafeState {
  if (record.state === "committed") throw new EnrollmentError("idempotency_conflict");
  record.state = "cleanup_pending";
  record.stage = "cleanup_pending";
  record.cleanup_target = target;
  saveRecordUnlocked(home, records, record);
  let conflict = false;
  let tokenConflict = false;
  try {
    withHubStateLock(home, () => {
      const currentTokens = record.agent_id
        ? loadTokenRecords(home).filter((item) => item.agent_id === record.agent_id)
        : [];
      const tokenOwned =
        record.token_hash !== null &&
        currentTokens.length === 1 &&
        currentTokens[0]?.token_hash === record.token_hash &&
        currentTokens[0]?.created_at === record.token_created_at;
      tokenConflict = currentTokens.length > 0 && !tokenOwned;

      let rosterOwned = false;
      let rosterConflict = false;
      let currentRosterAgent: AgentRecord | undefined;
      const currentRoster = record.agent_id ? loadRoster(home) : null;
      if (currentRoster && record.agent_id) {
        currentRosterAgent = currentRoster.agents.find((agent) => agent.id === record.agent_id);
        rosterOwned =
          currentRosterAgent !== undefined &&
          record.roster_agent !== null &&
          record.roster_generation !== null &&
          currentRosterAgent.enrollment_generation === record.roster_generation &&
          sameAgent(currentRosterAgent, record.roster_agent);
        rosterConflict = currentRosterAgent !== undefined && !rosterOwned;
      }
      // Observe both files before mutating either. If an independent actor
      // changed one side, fail closed and preserve all usable state.
      if (tokenConflict || rosterConflict) {
        conflict = true;
        return;
      }
      if (record.token_hash && record.agent_id) {
        if (currentTokens.length === 0) {
          // Already gone is a successful cleanup.
        } else if (tokenOwned) {
          if (!deleteTokenRecordIfCurrentLocked(home, record.agent_id, record.token_hash, record.token_created_at ?? undefined)) {
            conflict = true;
            tokenConflict = true;
          }
        }
      }
      if (!tokenConflict && currentRoster && record.agent_id && record.roster_agent && record.roster_generation) {
        if (!currentRosterAgent) {
          // Already gone is a successful cleanup.
        } else if (rosterOwned) {
          if (!removeAgentIfOwnedLocked(home, record.agent_id, record.roster_generation, record.roster_agent)) {
            conflict = true;
          }
        }
      }
    });
  } catch {
    record.state = "cleanup_pending";
    saveRecordUnlocked(home, records, record);
    throw new EnrollmentError("cleanup_pending");
  }
  if (!removeCustodyToken(record, home)) conflict = true;
  if (record.pair_id) {
    try {
      const finalized = finalizePairingEnrollment(
        home,
        record.pair_id,
        target === "expired" ? "expired" : "rejected",
      );
      if (!finalized && pairingStatus(home, record.pair_id) === "enrollment_pending") {
        conflict = true;
      }
    } catch {
      conflict = true;
    }
  }
  record.state = conflict ? "cleanup_conflict" : target;
  record.stage = conflict ? "cleanup_pending" : target === "expired" ? "cleanup_pending" : "cleanup_pending";
  saveRecordUnlocked(home, records, record);
  return safeState(record, home);
}

function expireIfNeeded(
  home: string,
  records: EnrollmentRecord[],
  record: EnrollmentRecord,
  now: Date,
): void {
  if (
    (record.state === "preparing" || record.state === "pending_save" || record.state === "cleanup_pending" || record.state === "cleanup_conflict") &&
    validateNowExpiry(record, now)
  ) {
    cleanupRecord(home, records, record, "expired");
  }
}

export function redeemEnrollment(
  home: string,
  input: RedeemEnrollmentInput,
  options: EnrollmentOperationOptions = {},
): EnrollmentCredentialResult {
  validateRequest(input.request_id, input.recovery_proof);
  if (typeof input.code !== "string" || !input.code.trim()) {
    throw new EnrollmentError("code_invalid_or_expired");
  }
  const now = nowFrom(options);
  const codeHash = hashValue(input.code.trim().toUpperCase().replace(/\s+/g, ""));
  return withJournalLock(home, () => {
    const records = readJournalUnlocked(home);
    let record = findByRequest(records, input.request_id);
    if (record) {
      if (record.request_fingerprint !== fingerprint(codeHash, input.request_id)) {
        throw new EnrollmentError("idempotency_conflict");
      }
      verifyOwner(record, input.recovery_proof);
      return resumeRecord(home, records, record, now, input.code);
    }
    record = {
      schema_version: 1,
      enrollment_id: `enroll_${randomUUID().replace(/-/g, "")}`,
      request_id: input.request_id,
      request_fingerprint: fingerprint(codeHash, input.request_id),
      recovery_proof_hash: proofHash(input.recovery_proof),
      code_hash: codeHash,
      pair_id: null,
      agent_id: null,
      label: "",
      created_at: iso(now),
      expires_at: new Date(now.getTime() + DEFAULT_ENROLLMENT_TTL_SECONDS * 1000).toISOString(),
      state: "preparing",
      stage: "prepared",
      token_path: null,
      token_hash: null,
      token_created_at: null,
      roster_generation: null,
      roster_agent: null,
      commit_id: null,
      cleanup_target: null,
    };
    saveRecordUnlocked(home, records, record);
    try {
      return resumeRecord(home, records, record, now, input.code);
    } catch (error) {
      if (error instanceof EnrollmentError && error.code === "code_invalid_or_expired" && !record.pair_id) {
        removeRecordUnlocked(home, records, record.enrollment_id);
      }
      throw error;
    }
  });
}

export function getEnrollment(
  home: string,
  input: EnrollmentReferenceInput,
  options: EnrollmentOperationOptions = {},
): EnrollmentSafeState {
  validateEnrollmentId(input.enrollment_id);
  validateRequest(input.enrollment_id, input.recovery_proof);
  const now = nowFrom(options);
  return withJournalLock(home, () => {
    const records = readJournalUnlocked(home);
    const record = findByEnrollment(records, input.enrollment_id);
    if (!record) throw new EnrollmentError("management_denied");
    verifyOwner(record, input.recovery_proof);
    expireIfNeeded(home, records, record, now);
    return safeState(record, home);
  });
}

export function recoverEnrollment(
  home: string,
  input: RecoverEnrollmentInput,
  options: EnrollmentOperationOptions = {},
): EnrollmentCredentialResult {
  validateRequest(input.request_id, input.recovery_proof);
  const now = nowFrom(options);
  return withJournalLock(home, () => {
    const records = readJournalUnlocked(home);
    const record = findByRequest(records, input.request_id);
    if (!record) throw new EnrollmentError("management_denied");
    verifyOwner(record, input.recovery_proof);
    return resumeRecord(home, records, record, now, null);
  });
}

export function commitEnrollment(
  home: string,
  input: CommitEnrollmentInput,
  options: EnrollmentOperationOptions = {},
): EnrollmentSafeState {
  validateEnrollmentId(input.enrollment_id);
  validateRequest(input.enrollment_id, input.recovery_proof);
  validateCommitId(input.commit_id);
  const now = nowFrom(options);
  return withJournalLock(home, () => {
    const records = readJournalUnlocked(home);
    const record = findByEnrollment(records, input.enrollment_id);
    if (!record) throw new EnrollmentError("management_denied");
    verifyOwner(record, input.recovery_proof);
    if (record.state === "committed") {
      if (record.commit_id !== input.commit_id) throw new EnrollmentError("idempotency_conflict");
      return safeState(record, home);
    }
    if (record.state === "cancelled" || record.state === "expired") {
      throw new EnrollmentError("context_expired");
    }
    if (record.state === "cleanup_conflict") throw new EnrollmentError("cleanup_conflict");
    if (validateNowExpiry(record, now)) {
      cleanupRecord(home, records, record, "expired");
      throw new EnrollmentError("context_expired");
    }
    if (record.state !== "pending_save") {
      resumeRecord(home, records, record, now, null);
    }
    try {
      return withHubStateLock(home, () => {
        if (!ownsCurrentEnrollmentLocked(home, record)) {
          throw new EnrollmentError("cleanup_conflict");
        }
        if (record.pair_id) {
          try {
            finalizePairingEnrollment(home, record.pair_id, "redeemed");
            if (pairingStatus(home, record.pair_id) !== "redeemed") {
              throw new Error("pairing finalization incomplete");
            }
          } catch {
            throw new EnrollmentError("enrollment_unavailable");
          }
        }
        record.commit_id = input.commit_id;
        record.state = "committed";
        record.stage = "committed";
        saveRecordUnlocked(home, records, record);
        return safeState(record, home);
      });
    } catch (error) {
      if (error instanceof EnrollmentError && error.code === "cleanup_conflict") {
        try { cleanupRecord(home, records, record, "cancelled"); }
        catch { /* The journal retains the cleanup retry state. */ }
      }
      throw error;
    }
  });
}

export function cancelEnrollment(
  home: string,
  input: EnrollmentReferenceInput,
  options: EnrollmentOperationOptions = {},
): EnrollmentSafeState {
  validateEnrollmentId(input.enrollment_id);
  validateRequest(input.enrollment_id, input.recovery_proof);
  const now = nowFrom(options);
  return withJournalLock(home, () => {
    const records = readJournalUnlocked(home);
    const record = findByEnrollment(records, input.enrollment_id);
    if (!record) throw new EnrollmentError("management_denied");
    verifyOwner(record, input.recovery_proof);
    if (record.state === "committed") throw new EnrollmentError("idempotency_conflict");
    if (record.state === "cancelled") return safeState(record, home);
    if (record.state === "expired") return safeState(record, home);
    return cleanupRecord(home, records, record, validateNowExpiry(record, now) ? "expired" : "cancelled");
  });
}

export function sweepEnrollments(
  home: string,
  options: EnrollmentOperationOptions = {},
): EnrollmentSweepCounts {
  const now = nowFrom(options);
  return withJournalLock(home, () => {
    const records = readJournalUnlocked(home);
    const counts: EnrollmentSweepCounts = {
      scanned: records.length,
      pending_save: 0,
      committed: 0,
      expired: 0,
      cancelled: 0,
      cleanup_pending: 0,
      cleanup_conflict: 0,
    };
    for (const record of records) {
      try {
        if (record.state === "committed") {
          counts.committed += 1;
        } else if (record.state === "pending_save") {
          if (validateNowExpiry(record, now)) cleanupRecord(home, records, record, "expired");
          else counts.pending_save += 1;
        } else if (record.state === "preparing") {
          cleanupRecord(home, records, record, validateNowExpiry(record, now) ? "expired" : "cancelled");
        } else if (record.state === "cleanup_pending" || record.state === "cleanup_conflict") {
          cleanupRecord(home, records, record, record.cleanup_target ?? "expired");
        }
      } catch (error) {
        if (error instanceof EnrollmentError && error.code === "cleanup_conflict") {
          counts.cleanup_conflict += 1;
        } else {
          counts.cleanup_pending += 1;
        }
      }
    }
    for (const record of records) {
      if (record.state === "expired") counts.expired += 1;
      else if (record.state === "cancelled") counts.cancelled += 1;
      else if (record.state === "cleanup_pending") counts.cleanup_pending += 1;
      else if (record.state === "cleanup_conflict") counts.cleanup_conflict += 1;
    }
    return counts;
  });
}
