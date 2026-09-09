/**
 * Provider-side guarded enrollment manager for a DSH connection profile.
 *
 * The host that constructs this class supplies the already-authorized owner,
 * resolved profile home and approved Hub policy. Browser input is limited to
 * opaque handles, an explicit HTTPS endpoint and the one-time code. Bearers
 * and recovery proofs stay in protected host custody and never enter a result
 * DTO, log or ordinary connection setting.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  acquireFileLockSync,
  atomicWriteText,
  FileLockError,
  withFileLockSync,
  withPathLock,
} from "./atomic-file.js";
import {
  connectionRevision,
  ConnectionRevisionConflictError,
  loadConnection,
  loadConnectionSnapshot,
  readConnectionFileContents,
  restoreConnectionIfRevision,
  setConnectionIfRevision,
} from "./connection.js";
import {
  EnrollmentClientError,
  EnrollmentHubClient,
  normalizeEnrollmentEndpoint,
  type EnrollmentErrorCode,
  type EnrollmentHubValue,
  type EnrollmentTransport,
} from "./enrollment-client.js";
import { validateAgentId } from "./ids.js";

export type EnrollmentState =
  | "context_ready"
  | "redeem_in_progress"
  | "pending_save"
  | "commit_in_progress"
  | "saved"
  | "active"
  | "error"
  | "cleanup_pending"
  | "cleanup_conflict"
  | "cancelled"
  | "expired";

export type EnrollmentSaveState = "unsaved" | "saving" | "saved" | "error";
export type EnrollmentActivationState =
  | "pending"
  | "restart_required"
  | "active"
  | "error";
export type EnrollmentCleanupState = "none" | "pending" | "complete" | "conflict";

const SAFE_MESSAGES: Record<EnrollmentErrorCode, string> = {
  management_denied: "enrollment management is not authorized",
  target_not_allowed: "the selected Hub target is not allowed",
  tls_untrusted: "the Hub TLS certificate is not trusted",
  hub_unreachable: "the Hub could not be reached",
  code_invalid_or_expired: "the enrollment code is invalid or expired",
  rate_limited: "the Hub temporarily rate-limited enrollment",
  identity_conflict: "the selected identity is already enrolled",
  identity_mismatch: "the Hub identity did not match the enrollment",
  context_expired: "the enrollment context expired",
  idempotency_conflict: "the enrollment retry did not match its original request",
  config_conflict: "the connection configuration changed during enrollment",
  save_failed: "the new connection could not be saved",
  activation_failed: "the new connection could not be activated",
  cleanup_pending: "enrollment cleanup is still pending",
  cleanup_conflict: "enrollment cleanup could not safely remove its state",
  directory_failed: "the Hub directory could not be read",
  test_timeout: "the enrollment test timed out",
  protocol_error: "the Hub returned an invalid enrollment response",
  hub_request_failed: "the Hub rejected the enrollment request",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_RE = /^rev_[A-Za-z0-9_-]{8,160}$/;
const HANDLE_RE = /^(?:ctx|enr)_[0-9a-f]{32}$/;
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,127}$/;
const JOURNAL_SCHEMA_VERSION = 1;
const DEFAULT_CONTEXT_TTL_MS = 10 * 60_000;
const MAX_CONTEXT_TTL_MS = 24 * 60 * 60_000;
const OPERATION_LOCK_WAIT_MS = 30_000;

export class EnrollmentManagerError extends Error {
  readonly code: EnrollmentErrorCode;
  readonly stage: string;
  readonly retryable: boolean;
  readonly operation_id: string | null;
  readonly state: EnrollmentState | null;
  readonly unknown_outcome: boolean;

  constructor(
    code: EnrollmentErrorCode,
    options: {
      stage?: string;
      retryable?: boolean;
      operationId?: string | null;
      state?: EnrollmentState | null;
      unknownOutcome?: boolean;
    } = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "EnrollmentManagerError";
    this.code = code;
    this.stage = options.stage ?? "enrollment";
    this.retryable = options.retryable ?? false;
    this.operation_id = options.operationId ?? null;
    this.state = options.state ?? null;
    this.unknown_outcome = options.unknownOutcome ?? false;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      operation_id: this.operation_id,
      state: this.state,
      message: this.message,
    };
  }
}

export interface BeginEnrollmentInput {
  endpoint: string;
  target_profile_handle?: string;
  trust_profile_handle?: string;
}

export interface BeginEnrollmentResult {
  context_handle: string;
  target_label: string;
  endpoint: string;
  trust_profile_handle: string;
  tls_verified: boolean;
  expires_at: string;
  observed_config_revision: string;
  state: "context_ready";
}

export interface RedeemEnrollmentInput {
  context_handle: string;
  request_id: string;
  code: string;
}

export interface RedeemEnrollmentResult {
  enrollment_handle: string;
  agent_id: string;
  expires_at: string;
  verified_at: string;
  state: "pending_save";
  save_state: EnrollmentSaveState;
  activation_state: EnrollmentActivationState;
  cleanup_state: EnrollmentCleanupState;
}

export interface EnrollmentStatusInput {
  enrollment_handle: string;
}

export interface EnrollmentStatusResult {
  enrollment_handle: string;
  agent_id?: string;
  expires_at: string;
  state: EnrollmentState;
  save_state: EnrollmentSaveState;
  activation_state: EnrollmentActivationState;
  cleanup_state: EnrollmentCleanupState;
  commit_id?: string;
  config_revision?: string;
  remote_committed_at?: string;
  saved_at?: string;
  verified_at?: string;
  retryable_error?: {
    code: EnrollmentErrorCode;
    stage: string;
    retryable: boolean;
    operation_id: string | null;
    state: EnrollmentState | null;
  };
}

export interface CommitEnrollmentInput {
  enrollment_handle: string;
  expected_config_revision: string;
  confirmed_agent_id: string;
  commit_id?: string;
}

export interface CommitEnrollmentResult {
  enrollment_handle: string;
  commit_id: string;
  state: "saved" | "active" | "commit_in_progress" | "error";
  save_state: EnrollmentSaveState;
  activation_state: EnrollmentActivationState;
  cleanup_state: EnrollmentCleanupState;
  config_revision?: string;
  remote_committed_at?: string;
}

export interface CancelEnrollmentInput {
  enrollment_handle: string;
}

export interface CancelEnrollmentResult {
  enrollment_handle: string;
  state: "cancelled" | "expired" | "cleanup_pending" | "cleanup_conflict";
  cleanup_state: EnrollmentCleanupState;
}

export interface ActivationEvidence {
  effective_hub_url: string;
  agent_id: string;
  /** Host-side route/process evidence, not just an unauthenticated /me probe. */
  route_verified: boolean;
  observed_at?: string;
}

export interface ActivateEnrollmentInput {
  enrollment_handle: string;
  evidence?: ActivationEvidence;
}

export interface ActivateEnrollmentResult {
  enrollment_handle: string;
  state: "active" | "error";
  activation_state: "active" | "error";
  save_state: EnrollmentSaveState;
  cleanup_state: EnrollmentCleanupState;
  activated_at?: string;
}

export interface ConnectionEnrollmentManagerOptions {
  /** Server-resolved .agent-mail home/profile; never accept this from UI. */
  home: string;
  /** Management principal already authorized by the host boundary. */
  owner: string;
  /** Exact approved HTTPS Hub origins. Omit only for an explicitly host-wide policy. */
  allowedHubUrls?: readonly string[];
  /** Protected server-side trust path, resolved by the host. */
  caFile?: string | null;
  /** Opaque profile handle bound by the host, if one exists. */
  targetProfileHandle?: string;
  trustProfileHandle?: string;
  /** Injected protocol client for tests or a provider-specific implementation. */
  transport?: EnrollmentTransport;
  transportFactory?: (endpoint: string) => EnrollmentTransport;
  /** Optional host callback for proving the effective process route after save. */
  activationVerifier?: (input: {
    home: string;
    endpoint: string;
    agent_id: string;
    token_file: string;
  }) => Promise<ActivationEvidence>;
  contextTtlMs?: number;
  journalPath?: string;
  now?: () => Date;
}

interface JournalError {
  code: EnrollmentErrorCode;
  stage: string;
  retryable: boolean;
  operation_id: string | null;
  state: EnrollmentState | null;
}

interface JournalEntry {
  context_handle: string;
  enrollment_handle: string | null;
  owner: string;
  target_profile_handle: string | null;
  endpoint: string;
  target_label: string;
  trust_profile_handle: string;
  trust_digest: string;
  created_at: string;
  expires_at: string;
  observed_config_revision: string;
  request_id: string | null;
  request_fingerprint: string | null;
  /** Base64url 32-byte recovery proof, protected by the journal's 0600 mode. */
  recovery_proof: string | null;
  hub_enrollment_id: string | null;
  agent_id: string | null;
  verified_at: string | null;
  custody_file: string | null;
  state: EnrollmentState;
  save_state: EnrollmentSaveState;
  activation_state: EnrollmentActivationState;
  cleanup_state: EnrollmentCleanupState;
  commit_id: string | null;
  expected_config_revision: string | null;
  confirmed_agent_id: string | null;
  staged_token_file: string | null;
  remote_committed_at: string | null;
  /** Distinguishes a captured absent file from an uncaptured journal entry. */
  previous_connection_captured: boolean;
  previous_connection_contents: string | null;
  provisional_config_revision: string | null;
  saved_at: string | null;
  config_revision: string | null;
  activated_at: string | null;
  last_error: JournalError | null;
}

interface JournalDocument {
  schema_version: 1;
  entries: JournalEntry[];
}

interface RemoteRedeem {
  enrollment_id: string;
  agent_id: string;
  token: string;
  expires_at: string;
  verified_at: string;
  state: "pending_save" | "committed";
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function freshHandle(prefix: "ctx" | "enr"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function requireHandle(value: string): string {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    throw new EnrollmentManagerError("context_expired");
  }
  return value;
}

function requireUuid(value: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new EnrollmentManagerError("protocol_error");
  }
  return value;
}

function requireRevision(value: string): string {
  if (typeof value !== "string" || !REVISION_RE.test(value)) {
    throw new EnrollmentManagerError("config_conflict");
  }
  return value;
}

function requireSafeHandle(value: string | undefined, fallback: string): string {
  const result = value?.trim() || fallback;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(result) || result.includes("..")) {
    throw new EnrollmentManagerError("target_not_allowed");
  }
  return result;
}

function safeError(
  error: unknown,
  stage: string,
  operationId: string | null,
  state: EnrollmentState | null,
): EnrollmentManagerError {
  if (error instanceof EnrollmentManagerError) return error;
  if (error instanceof EnrollmentClientError) {
    return new EnrollmentManagerError(error.code, {
      stage,
      retryable: error.retryable,
      operationId,
      state,
      unknownOutcome: error.unknown_outcome,
    });
  }
  const candidate = error as { code?: unknown; retryable?: unknown; unknown_outcome?: unknown };
  const code =
    typeof candidate?.code === "string" &&
    Object.hasOwn(SAFE_MESSAGES, candidate.code)
      ? (candidate.code as EnrollmentErrorCode)
      : "hub_unreachable";
  return new EnrollmentManagerError(code, {
    stage,
    retryable: candidate?.retryable === true || code === "hub_unreachable",
    operationId,
    state,
    unknownOutcome: candidate?.unknown_outcome === true,
  });
}

function ensureRealDirectory(directory: string, label: string): void {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new EnrollmentManagerError("save_failed", { stage: label });
    }
  }
  try {
    fs.chmodSync(resolved, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function ensureRealFile(filename: string, label: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new EnrollmentManagerError("save_failed", { stage: label });
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseJournal(raw: string): JournalDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new EnrollmentManagerError("save_failed", { stage: "journal" });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).schema_version !== JOURNAL_SCHEMA_VERSION ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    throw new EnrollmentManagerError("save_failed", { stage: "journal" });
  }
  const entries = (parsed as { entries: unknown[] }).entries;
  if (entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new EnrollmentManagerError("save_failed", { stage: "journal" });
  }
  // The manager only ever writes this schema; avoid trusting a malformed
  // external entry as a credential-bearing record.
  for (const entry of entries as JournalEntry[]) {
    if (
      typeof entry.context_handle !== "string" ||
      typeof entry.owner !== "string" ||
      typeof entry.endpoint !== "string" ||
      !HANDLE_RE.test(entry.context_handle)
    ) {
      throw new EnrollmentManagerError("save_failed", { stage: "journal" });
    }
  }
  return { schema_version: 1, entries: entries as JournalEntry[] };
}

export class ConnectionEnrollmentManager {
  readonly home: string;
  readonly owner: string;
  readonly journalPath: string;
  private readonly allowedHubUrls: Set<string> | null;
  private readonly caFile: string | null;
  private readonly caDigest: string;
  private readonly targetProfileHandle: string | null;
  private readonly trustProfileHandle: string;
  private readonly transport: EnrollmentTransport | null;
  private readonly transportFactory:
    | ((endpoint: string) => EnrollmentTransport)
    | null;
  private readonly activationVerifier:
    | ConnectionEnrollmentManagerOptions["activationVerifier"]
    | null;
  private readonly contextTtlMs: number;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Serialize stateful operations on one enrollment within this host. */
  private readonly serialized = new Map<string, Promise<void>>();

  constructor(options: ConnectionEnrollmentManagerOptions) {
    this.home = path.resolve(options.home);
    const homeStat = fs.lstatSync(this.home);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
      throw new EnrollmentManagerError("save_failed", { stage: "profile" });
    }
    if (
      typeof options.owner !== "string" ||
      !options.owner.trim() ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(options.owner)
    ) {
      throw new EnrollmentManagerError("management_denied", { stage: "owner" });
    }
    this.owner = options.owner.trim();
    this.targetProfileHandle = options.targetProfileHandle
      ? requireSafeHandle(options.targetProfileHandle, "")
      : null;
    this.trustProfileHandle = requireSafeHandle(
      options.trustProfileHandle,
      options.caFile ? "configured-ca" : "system",
    );
    this.caFile = options.caFile ? path.resolve(options.caFile) : null;
    if (this.caFile) {
      const stat = ensureRealFile(this.caFile, "trust");
      if (!stat) throw new EnrollmentManagerError("tls_untrusted", { stage: "trust" });
      this.caDigest = sha256(fs.readFileSync(this.caFile));
    } else {
      this.caDigest = "system";
    }
    this.allowedHubUrls =
      options.allowedHubUrls === undefined
        ? null
        : new Set(
            options.allowedHubUrls.map((url) => normalizeEnrollmentEndpoint(url).url),
          );
    this.transport = options.transport ?? null;
    this.transportFactory = options.transportFactory ?? null;
    this.activationVerifier = options.activationVerifier ?? null;
    this.contextTtlMs = options.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
    if (
      !Number.isInteger(this.contextTtlMs) ||
      this.contextTtlMs < 1_000 ||
      this.contextTtlMs > MAX_CONTEXT_TTL_MS
    ) {
      throw new EnrollmentManagerError("protocol_error", { stage: "context" });
    }
    this.now = options.now ?? (() => new Date());
    this.journalPath = path.resolve(
      options.journalPath ?? path.join(this.home, "enrollment", "journal.json"),
    );
    const journalParent = path.dirname(this.journalPath);
    ensureRealDirectory(journalParent, "journal");
    ensureRealFile(this.journalPath, "journal");
  }

  private async readJournal(): Promise<JournalDocument> {
    return withPathLock(this.journalPath, () =>
      withFileLockSync(this.journalPath, () => {
        const stat = ensureRealFile(this.journalPath, "journal");
        if (!stat) return { schema_version: 1, entries: [] };
        return parseJournal(fs.readFileSync(this.journalPath, "utf8"));
      }),
    );
  }

  private async updateJournal<T>(fn: (journal: JournalDocument) => T): Promise<T> {
    return withPathLock(this.journalPath, () =>
      withFileLockSync(this.journalPath, () => {
        const stat = ensureRealFile(this.journalPath, "journal");
        const journal = stat
          ? parseJournal(fs.readFileSync(this.journalPath, "utf8"))
          : { schema_version: 1 as const, entries: [] };
        const result = fn(journal);
        atomicWriteText(
          this.journalPath,
          `${JSON.stringify(journal, null, 2)}\n`,
          0o600,
        );
        return result;
      }),
    );
  }

  private findEntry(
    journal: JournalDocument,
    handle: string,
  ): JournalEntry {
    const entry = journal.entries.find(
      (candidate) =>
        candidate.context_handle === handle || candidate.enrollment_handle === handle,
    );
    if (!entry || entry.owner !== this.owner) {
      throw new EnrollmentManagerError("management_denied", { stage: "owner" });
    }
    if (
      this.targetProfileHandle &&
      entry.target_profile_handle !== this.targetProfileHandle
    ) {
      throw new EnrollmentManagerError("management_denied", { stage: "profile" });
    }
    if (entry.trust_profile_handle !== this.trustProfileHandle) {
      throw new EnrollmentManagerError("management_denied", { stage: "trust" });
    }
    if (this.allowedHubUrls && !this.allowedHubUrls.has(entry.endpoint)) {
      throw new EnrollmentManagerError("target_not_allowed", { stage: "target" });
    }
    return entry;
  }

  private transportFor(endpoint: string): EnrollmentTransport {
    if (this.transport) return this.transport;
    if (this.transportFactory) return this.transportFactory(endpoint);
    return new EnrollmentHubClient({ baseUrl: endpoint, caFile: this.caFile });
  }

  private checkTarget(endpoint: string): string {
    let normalized: string;
    try {
      normalized = normalizeEnrollmentEndpoint(endpoint).url;
    } catch (error) {
      throw safeError(error, "target", null, null);
    }
    if (this.allowedHubUrls && !this.allowedHubUrls.has(normalized)) {
      throw new EnrollmentManagerError("target_not_allowed", { stage: "target" });
    }
    return normalized;
  }

  private assertTrustUnchanged(entry: JournalEntry): void {
    if (entry.trust_digest !== this.caDigest) {
      throw new EnrollmentManagerError("tls_untrusted", { stage: "trust", state: entry.state });
    }
    if (!this.caFile) return;
    const stat = ensureRealFile(this.caFile, "trust");
    if (!stat || sha256(fs.readFileSync(this.caFile)) !== entry.trust_digest) {
      throw new EnrollmentManagerError("tls_untrusted", { stage: "trust", state: entry.state });
    }
  }

  private assertSafeBeginInput(input: BeginEnrollmentInput): void {
    const candidate = input as unknown as Record<string, unknown>;
    for (const key of [
      "token",
      "hub_token",
      "token_file",
      "ca_file",
      "caFile",
      "provider_home",
      "providerHome",
      "home",
      "env",
      "environment",
      "credentials",
    ]) {
      if (Object.hasOwn(candidate, key)) {
        throw new EnrollmentManagerError("target_not_allowed", { stage: "target" });
      }
    }
  }

  private newEntry(input: BeginEnrollmentInput, endpoint: string): JournalEntry {
    const now = this.now();
    const expires = new Date(now.getTime() + this.contextTtlMs);
    const target = requireSafeHandle(
      input.target_profile_handle,
      this.targetProfileHandle ?? "profile",
    );
    if (this.targetProfileHandle && target !== this.targetProfileHandle) {
      throw new EnrollmentManagerError("target_not_allowed", { stage: "profile" });
    }
    const trust = requireSafeHandle(
      input.trust_profile_handle,
      this.trustProfileHandle,
    );
    if (trust !== this.trustProfileHandle) {
      throw new EnrollmentManagerError("target_not_allowed", { stage: "trust" });
    }
    return {
      context_handle: freshHandle("ctx"),
      enrollment_handle: null,
      owner: this.owner,
      target_profile_handle: target,
      endpoint,
      target_label: target,
      trust_profile_handle: trust,
      trust_digest: this.caDigest,
      created_at: iso(now),
      expires_at: iso(expires),
      observed_config_revision: connectionRevision(this.home),
      request_id: null,
      request_fingerprint: null,
      recovery_proof: null,
      hub_enrollment_id: null,
      agent_id: null,
      verified_at: null,
      custody_file: null,
      state: "context_ready",
      save_state: "unsaved",
      activation_state: "pending",
      cleanup_state: "none",
      commit_id: null,
      expected_config_revision: null,
      confirmed_agent_id: null,
      staged_token_file: null,
      remote_committed_at: null,
      previous_connection_captured: false,
      previous_connection_contents: null,
      provisional_config_revision: null,
      saved_at: null,
      config_revision: null,
      activated_at: null,
      last_error: null,
    };
  }

  private async changeState(
    entry: JournalEntry,
    error: EnrollmentManagerError | null,
  ): Promise<void> {
    await this.updateJournal((journal) => {
      const current = this.findEntry(journal, entry.context_handle);
      current.last_error = error
        ? {
            code: error.code,
            stage: error.stage,
            retryable: error.retryable,
            operation_id: error.operation_id,
            state: error.state,
          }
        : null;
    });
  }

  private custodyPath(entry: JournalEntry): string {
    const relative = entry.custody_file;
    if (!relative || path.posix.normalize(relative) !== relative || !relative.startsWith("auth/enrollment/")) {
      throw new EnrollmentManagerError("save_failed", { stage: "custody", state: entry.state });
    }
    const filename = path.resolve(this.home, relative);
    if (!filename.startsWith(`${this.home}${path.sep}`)) {
      throw new EnrollmentManagerError("save_failed", { stage: "custody", state: entry.state });
    }
    return filename;
  }

  private writeCustody(entry: JournalEntry, token: string): void {
    if (!entry.custody_file) {
      entry.custody_file = `auth/enrollment/${entry.enrollment_handle!}.token`;
    }
    const filename = this.custodyPath(entry);
    ensureRealDirectory(path.dirname(filename), "custody");
    const existing = ensureRealFile(filename, "custody");
    if (existing) {
      const current = fs.readFileSync(filename, "utf8").trim();
      if (current !== token) {
        throw new EnrollmentManagerError("identity_mismatch", { stage: "custody" });
      }
      return;
    }
    atomicWriteText(filename, `${token}\n`, 0o600);
  }

  private removeCustody(entry: JournalEntry): void {
    if (!entry.custody_file) return;
    const filename = this.custodyPath(entry);
    const stat = ensureRealFile(filename, "custody");
    if (stat) fs.unlinkSync(filename);
  }

  private parseRemoteRedeem(value: EnrollmentHubValue): RemoteRedeem {
    const enrollmentId =
      typeof value.enrollment_id === "string" ? value.enrollment_id : "";
    const agent = typeof value.agent_id === "string" ? value.agent_id : "";
    const token = typeof value.token === "string" ? value.token : "";
    const expiresAt =
      typeof value.expires_at === "string" && Number.isFinite(Date.parse(value.expires_at))
        ? value.expires_at
        : "";
    const state = value.state;
    const verifiedAt =
      typeof value.verified_at === "string" && Number.isFinite(Date.parse(value.verified_at))
        ? value.verified_at
        : iso(this.now());
    if (
      !enrollmentId ||
      !/^enroll_[a-f0-9]{32}$/.test(enrollmentId) ||
      enrollmentId.length > 256 ||
      !agent ||
      !token ||
      !expiresAt ||
      (state !== "pending_save" && state !== "committed") ||
      token.length > 512 ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(token)
    ) {
      throw new EnrollmentManagerError("protocol_error", { stage: "redeem" });
    }
    try {
      validateAgentId(agent);
    } catch {
      throw new EnrollmentManagerError("identity_mismatch", { stage: "redeem" });
    }
    return {
      enrollment_id: enrollmentId,
      agent_id: agent,
      token,
      expires_at: expiresAt,
      verified_at: verifiedAt,
      state,
    };
  }

  private safeRedeemResult(entry: JournalEntry): RedeemEnrollmentResult {
    if (!entry.enrollment_handle || !entry.agent_id || !entry.verified_at) {
      throw new EnrollmentManagerError("protocol_error", { stage: "redeem" });
    }
    return {
      enrollment_handle: entry.enrollment_handle,
      agent_id: entry.agent_id,
      expires_at: entry.expires_at,
      verified_at: entry.verified_at,
      state: "pending_save",
      save_state: entry.save_state,
      activation_state: entry.activation_state,
      cleanup_state: entry.cleanup_state,
    };
  }

  private statusResult(entry: JournalEntry): EnrollmentStatusResult {
    const result: EnrollmentStatusResult = {
      enrollment_handle: entry.enrollment_handle ?? entry.context_handle,
      ...(entry.agent_id ? { agent_id: entry.agent_id } : {}),
      expires_at: entry.expires_at,
      state: entry.state,
      save_state: entry.save_state,
      activation_state: entry.activation_state,
      cleanup_state: entry.cleanup_state,
      ...(entry.commit_id ? { commit_id: entry.commit_id } : {}),
      ...(entry.config_revision ? { config_revision: entry.config_revision } : {}),
      ...(entry.remote_committed_at
        ? { remote_committed_at: entry.remote_committed_at }
        : {}),
      ...(entry.saved_at ? { saved_at: entry.saved_at } : {}),
      ...(entry.verified_at ? { verified_at: entry.verified_at } : {}),
    };
    if (entry.last_error) result.retryable_error = { ...entry.last_error };
    return result;
  }

  private desiredConfigMatches(entry: JournalEntry, settings = loadConnection(this.home)): boolean {
    return (
      settings.hub_url === entry.endpoint &&
      settings.token_file === entry.custody_file &&
      settings.ca_file === (this.caFile ?? "") &&
      settings.insecure_tls === false
    );
  }

  /** Roll back only this manager's provisional generation using an exact CAS. */
  private async rollbackProvisional(entry: JournalEntry): Promise<"rolled_back" | "conflict" | "none"> {
    const journal = await this.readJournal();
    const current = this.findEntry(journal, entry.context_handle);
    const provisional = current.provisional_config_revision;
    if (!provisional) return "none";
    if (!current.previous_connection_captured) {
      return "conflict";
    }
    try {
      restoreConnectionIfRevision(
        this.home,
        provisional,
        current.previous_connection_contents,
      );
    } catch (error) {
      if (error instanceof ConnectionRevisionConflictError) return "conflict";
      return "conflict";
    }
    await this.updateJournal((doc) => {
      const fresh = this.findEntry(doc, entry.context_handle);
      fresh.provisional_config_revision = null;
      // A later commit attempt must snapshot the then-current connection. In
      // particular, an administrator may have edited it between attempts.
      fresh.previous_connection_captured = false;
      fresh.previous_connection_contents = null;
      fresh.staged_token_file = null;
    });
    return "rolled_back";
  }

  private async markCommitFailure(
    entry: JournalEntry,
    failure: EnrollmentManagerError,
    rollback: boolean,
  ): Promise<void> {
    let rollbackResult: "rolled_back" | "conflict" | "none" = "none";
    if (rollback) rollbackResult = await this.rollbackProvisional(entry);
    let terminalCleanup = false;
    if (
      failure.code === "context_expired" &&
      rollbackResult !== "conflict" &&
      !entry.remote_committed_at
    ) {
      try {
        await this.updateJournal((journal) => {
          const current = this.findEntry(journal, entry.context_handle);
          this.removeCustody(current);
        });
        terminalCleanup = true;
      } catch {
        // Keep a durable cleanup-pending state so cancel/status can retry the
        // local custody removal without revoking unrelated credentials.
      }
    }
    await this.updateJournal((journal) => {
      const current = this.findEntry(journal, entry.context_handle);
      current.last_error = {
        code:
          rollbackResult === "conflict"
            ? "cleanup_conflict"
            : terminalCleanup
              ? failure.code
              : failure.code,
        stage: rollbackResult === "conflict" ? "rollback" : failure.stage,
        retryable: terminalCleanup ? false : true,
        operation_id: failure.operation_id,
        state: current.state,
      };
      if (rollbackResult === "conflict") {
        current.state = "cleanup_conflict";
        current.cleanup_state = "conflict";
        current.save_state = "error";
      } else if (rollbackResult === "rolled_back") {
        current.state = failure.code === "context_expired" ? "expired" : "error";
        current.cleanup_state =
          failure.code === "context_expired" && terminalCleanup ? "complete" : "pending";
        current.save_state = "error";
      } else if (current.remote_committed_at) {
        // The Hub credential is committed, so retain it for a save retry while
        // making the failed local activation explicit.
        current.state = "error";
        current.save_state = "error";
      } else if (failure.code === "context_expired") {
        current.state = "expired";
        current.cleanup_state = terminalCleanup ? "complete" : "pending";
        current.save_state = "error";
      }
    });
  }

  private remoteState(value: EnrollmentHubValue): string {
    return typeof value.state === "string" ? value.state : "";
  }

  /** Reconcile a durable Hub state before exposing or retrying local state. */
  private async reconcileRemoteState(
    entry: JournalEntry,
    remoteState: string,
  ): Promise<void> {
    if (remoteState === "committed") {
      await this.updateJournal((journal) => {
        const current = this.findEntry(journal, entry.context_handle);
        current.remote_committed_at ??= iso(this.now());
        if (current.state === "cleanup_pending") {
          current.state = "cleanup_conflict";
          current.cleanup_state = "conflict";
        }
        current.last_error = null;
      });
      return;
    }
    if (remoteState === "cleanup_pending") {
      await this.updateJournal((journal) => {
        const current = this.findEntry(journal, entry.context_handle);
        current.state = "cleanup_pending";
        current.cleanup_state = "pending";
      });
      return;
    }
    if (remoteState === "cleanup_conflict") {
      await this.updateJournal((journal) => {
        const current = this.findEntry(journal, entry.context_handle);
        current.state = "cleanup_conflict";
        current.cleanup_state = "conflict";
      });
      return;
    }
    if (remoteState !== "cancelled" && remoteState !== "expired") return;

    const rollback = await this.rollbackProvisional(entry);
    if (rollback === "conflict") {
      await this.updateJournal((journal) => {
        const current = this.findEntry(journal, entry.context_handle);
        current.state = "cleanup_conflict";
        current.cleanup_state = "conflict";
        current.save_state = "error";
      });
      return;
    }
    let custodyError = false;
    const terminalState = remoteState as "cancelled" | "expired";
    try {
      await this.updateJournal((journal) => {
        const current = this.findEntry(journal, entry.context_handle);
        this.removeCustody(current);
        current.state = terminalState;
        current.cleanup_state = "complete";
        current.save_state = "error";
        current.last_error = null;
      });
    } catch {
      custodyError = true;
    }
    if (custodyError) {
      await this.updateJournal((journal) => {
        const current = this.findEntry(journal, entry.context_handle);
        current.state = "cleanup_pending";
        current.cleanup_state = "pending";
        current.last_error = {
          code: "cleanup_pending",
          stage: "custody",
          retryable: true,
          operation_id: null,
          state: current.state,
        };
      });
    }
  }

  private async runOnce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const operation = fn();
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.serialized.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.serialized.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.serialized.get(key) === tail) this.serialized.delete(key);
    }
  }

  /**
   * Serialize an enrollment across manager instances and provider processes.
   * The lock acquisition itself never blocks the event loop: a zero-timeout
   * attempt yields to a later timer while another process owns the lease.
   */
  private async withOperationLock<T>(
    handle: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockTarget = path.join(
      path.dirname(this.journalPath),
      `operation-${handle}`,
    );
    ensureRealDirectory(path.dirname(lockTarget), "operation");
    const started = Date.now();
    let release: (() => void) | null = null;
    while (!release) {
      try {
        release = acquireFileLockSync(lockTarget, { timeoutMs: 0 });
      } catch (error) {
        if (
          !(error instanceof FileLockError) ||
          !error.message.includes("timed out waiting for file lock")
        ) {
          throw new EnrollmentManagerError("save_failed", {
            stage: "operation_lock",
            retryable: true,
          });
        }
        if (Date.now() - started >= OPERATION_LOCK_WAIT_MS) {
          throw new EnrollmentManagerError("save_failed", {
            stage: "operation_lock",
            retryable: true,
          });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Resolve context and enrollment aliases to one durable lock key. */
  private async operationLockHandle(handle: string): Promise<string> {
    const journal = await this.readJournal();
    return this.findEntry(journal, handle).context_handle;
  }

  private async verifyRemoteIdentity(
    transport: EnrollmentTransport,
    parsed: RemoteRedeem,
  ): Promise<void> {
    if (!transport.verifyIdentity) {
      throw new EnrollmentManagerError("identity_mismatch", {
        stage: "identity",
      });
    }
    const verified = await transport.verifyIdentity({
      token: parsed.token,
      expected_agent_id: parsed.agent_id,
    });
    if (verified.agent_id !== parsed.agent_id) {
      throw new EnrollmentManagerError("identity_mismatch", { stage: "identity" });
    }
  }

  /** Persist the authenticated Hub record handle before bearer verification. */
  private async persistRemoteEnrollmentId(
    handle: string,
    parsed: RemoteRedeem,
  ): Promise<void> {
    await this.updateJournal((journal) => {
      const current = this.findEntry(journal, handle);
      if (
        current.hub_enrollment_id &&
        current.hub_enrollment_id !== parsed.enrollment_id
      ) {
        throw new EnrollmentManagerError("identity_mismatch", {
          stage: "redeem",
          state: current.state,
        });
      }
      current.hub_enrollment_id = parsed.enrollment_id;
      current.expires_at = parsed.expires_at;
    });
  }

  /** Finish redeem only after the returned token proves the expected identity. */
  private async persistVerifiedRedeem(
    handle: string,
    parsed: RemoteRedeem,
  ): Promise<void> {
    await this.updateJournal((journal) => {
      const current = this.findEntry(journal, handle);
      if (current.agent_id && current.agent_id !== parsed.agent_id) {
        throw new EnrollmentManagerError("identity_mismatch", {
          stage: "identity",
          state: current.state,
        });
      }
      current.hub_enrollment_id = parsed.enrollment_id;
      current.agent_id = parsed.agent_id;
      current.expires_at = parsed.expires_at;
      current.verified_at = parsed.verified_at;
      this.writeCustody(current, parsed.token);
      if (parsed.state === "committed") {
        current.remote_committed_at ??= iso(this.now());
      }
      current.state = "pending_save";
      current.save_state = "unsaved";
      current.activation_state = "pending";
      current.cleanup_state = "none";
      current.last_error = null;
    });
  }

  /** Verify the approved HTTPS context and persist its observed revision. */
  async begin(input: BeginEnrollmentInput): Promise<BeginEnrollmentResult> {
    this.assertSafeBeginInput(input);
    const endpoint = this.checkTarget(input.endpoint);
    const transport = this.transportFor(endpoint);
    let verified = true;
    if (transport.verify) {
      try {
        const result = await transport.verify();
        verified = result.tls_verified === true;
      } catch (error) {
        throw safeError(error, "begin", null, null);
      }
    }
    if (!verified) throw new EnrollmentManagerError("tls_untrusted", { stage: "begin" });
    const entry = this.newEntry(input, endpoint);
    const result = await this.updateJournal((journal) => {
      journal.entries.push(entry);
      return {
        context_handle: entry.context_handle,
        target_label: entry.target_label,
        endpoint: entry.endpoint,
        trust_profile_handle: entry.trust_profile_handle,
        tls_verified: true,
        expires_at: entry.expires_at,
        observed_config_revision: entry.observed_config_revision,
        state: "context_ready" as const,
      };
    });
    return result;
  }

  /** Redeem once, then recover the same request/proof after a lost response. */
  async redeem(input: RedeemEnrollmentInput): Promise<RedeemEnrollmentResult> {
    const contextHandle = requireHandle(input.context_handle);
    const requestId = requireUuid(input.request_id);
    if (typeof input.code !== "string" || !CODE_RE.test(input.code.trim())) {
      throw new EnrollmentManagerError("code_invalid_or_expired", { stage: "redeem" });
    }
    return this.runOnce(`redeem:${contextHandle}:${requestId}`, () =>
      this.runExclusive(`enrollment:${contextHandle}`, () =>
        this.withOperationLock(contextHandle, async () => {
      const prep = await this.updateJournal((journal) => {
        const entry = this.findEntry(journal, contextHandle);
        this.assertTrustUnchanged(entry);
        if (Date.parse(entry.expires_at) <= this.now().getTime()) {
          const failure = new EnrollmentManagerError("context_expired", {
            stage: "redeem",
            state: "expired",
          });
          entry.state = "expired";
          entry.cleanup_state = "complete";
          entry.last_error = {
            code: failure.code,
            stage: failure.stage,
            retryable: failure.retryable,
            operation_id: failure.operation_id,
            state: failure.state,
          };
          return { entry, recover: false, done: false, expired: true, failure };
        }
        const fingerprint = sha256(`${requestId}\n${input.code.trim().toUpperCase()}`);
        if (entry.request_id && entry.request_id !== requestId) {
          throw new EnrollmentManagerError("idempotency_conflict", {
            stage: "redeem",
            state: entry.state,
          });
        }
        if (entry.request_fingerprint && entry.request_fingerprint !== fingerprint) {
          throw new EnrollmentManagerError("idempotency_conflict", {
            stage: "redeem",
            state: entry.state,
          });
        }
        if (entry.state === "pending_save" && entry.custody_file) {
          const stat = ensureRealFile(this.custodyPath(entry), "custody");
          if (stat) return { entry, recover: false, done: true, expired: false, fingerprint };
        }
        if (entry.state === "saved" || entry.state === "active") {
          throw new EnrollmentManagerError("idempotency_conflict", {
            stage: "redeem",
            state: entry.state,
          });
        }
        if (!entry.request_id) {
          entry.request_id = requestId;
          entry.request_fingerprint = fingerprint;
          entry.recovery_proof = randomBytes(32).toString("base64url");
          entry.enrollment_handle = freshHandle("enr");
        }
        if (!entry.recovery_proof || !PROOF_RE.test(entry.recovery_proof)) {
          throw new EnrollmentManagerError("save_failed", { stage: "journal" });
        }
        const recover = entry.state === "redeem_in_progress" || Boolean(entry.hub_enrollment_id);
        entry.state = "redeem_in_progress";
        entry.save_state = "unsaved";
        entry.last_error = null;
        return { entry, recover, done: false, expired: false, fingerprint };
      });
      if (prep.expired) throw prep.failure;
      const entry = prep.entry;
      if (prep.done) {
        const journal = await this.readJournal();
        return this.safeRedeemResult(this.findEntry(journal, contextHandle));
      }
      if (prep.recover && entry.agent_id && entry.custody_file) {
        const stat = ensureRealFile(this.custodyPath(entry), "custody");
        if (stat) {
          const journal = await this.readJournal();
          return this.safeRedeemResult(this.findEntry(journal, contextHandle));
        }
      }
      const proof = entry.recovery_proof!;
      const transport = this.transportFor(entry.endpoint);
      let remote: EnrollmentHubValue;
      try {
        remote = prep.recover
          ? await transport.recover({ request_id: entry.request_id!, recovery_proof: proof })
          : await transport.redeem({
              request_id: entry.request_id!,
              code: input.code.trim().toUpperCase(),
              recovery_proof: proof,
            });
      } catch (error) {
        const failure = safeError(error, prep.recover ? "recover" : "redeem", entry.request_id, entry.state);
        await this.changeState(entry, failure);
        // Definite rejection releases the request so the caller can start a
        // fresh code attempt; unknown network outcomes retain proof/request.
        if (!failure.unknown_outcome && failure.code !== "hub_unreachable") {
          await this.updateJournal((journal) => {
            const current = this.findEntry(journal, contextHandle);
            current.request_id = null;
            current.request_fingerprint = null;
            current.recovery_proof = null;
            current.enrollment_handle = null;
            current.state = failure.code === "context_expired" ? "expired" : "context_ready";
            current.last_error = null;
          });
        }
        throw failure;
      }
      let parsed: RemoteRedeem;
      try {
        parsed = this.parseRemoteRedeem(remote);
        await this.persistRemoteEnrollmentId(contextHandle, parsed);
        await this.verifyRemoteIdentity(transport, parsed);
        await this.persistVerifiedRedeem(contextHandle, parsed);
      } catch (error) {
        const failure = safeError(error, "redeem", entry.request_id, entry.state);
        await this.changeState(entry, failure);
        throw failure;
      }
      const journal = await this.readJournal();
      return this.safeRedeemResult(this.findEntry(journal, contextHandle));
        }),
      ),
    );
  }

  /** Read owner-scoped state; recover a lost redeem response when necessary. */
  async status(input: EnrollmentStatusInput): Promise<EnrollmentStatusResult> {
    const handle = requireHandle(input.enrollment_handle);
    const operationHandle = await this.operationLockHandle(handle);
    return this.runExclusive(`enrollment:${operationHandle}`, () =>
      this.withOperationLock(operationHandle, async () => {
      const initial = await this.readJournal();
      const entry = this.findEntry(initial, handle);
      this.assertTrustUnchanged(entry);
      if (
        entry.state === "redeem_in_progress" &&
        !entry.hub_enrollment_id &&
        entry.request_id &&
        entry.recovery_proof
      ) {
        const transport = this.transportFor(entry.endpoint);
        try {
          const value = await transport.recover({
            request_id: entry.request_id,
            recovery_proof: entry.recovery_proof,
          });
          const parsed = this.parseRemoteRedeem(value);
          await this.persistRemoteEnrollmentId(handle, parsed);
          await this.verifyRemoteIdentity(transport, parsed);
          await this.persistVerifiedRedeem(handle, parsed);
        } catch (error) {
          const failure = safeError(error, "recover", entry.request_id, entry.state);
          await this.changeState(entry, failure);
        }
      }
      const journal = await this.readJournal();
      const current = this.findEntry(journal, handle);
      if (
        current.hub_enrollment_id &&
        current.recovery_proof &&
        [
          "redeem_in_progress",
          "pending_save",
          "commit_in_progress",
          "cleanup_pending",
          "cleanup_conflict",
          "error",
          "expired",
        ].includes(current.state)
      ) {
        try {
          const value = await this.transportFor(current.endpoint).status({
            enrollment_id: current.hub_enrollment_id,
            recovery_proof: current.recovery_proof,
          });
          const remoteState = this.remoteState(value);
          if (![
            "preparing",
            "pending_save",
            "committed",
            "cancelled",
            "expired",
            "cleanup_pending",
            "cleanup_conflict",
          ].includes(remoteState)) {
            throw new EnrollmentManagerError("protocol_error", {
              stage: "status",
              retryable: true,
              state: current.state,
            });
          }
          await this.reconcileRemoteState(current, remoteState);
        } catch (error) {
          const failure = safeError(error, "status", current.hub_enrollment_id, current.state);
          await this.changeState(current, failure);
        }
      }
      const finalJournal = await this.readJournal();
      return this.statusResult(this.findEntry(finalJournal, handle));
      }),
    );
  }

  /** Commit the same Hub mutation ID and then publish a local CAS generation. */
  async commit(input: CommitEnrollmentInput): Promise<CommitEnrollmentResult> {
    const handle = requireHandle(input.enrollment_handle);
    const expectedRevision = requireRevision(input.expected_config_revision);
    let confirmedAgent: string;
    try {
      confirmedAgent = validateAgentId(input.confirmed_agent_id);
    } catch {
      throw new EnrollmentManagerError("identity_mismatch", { stage: "commit" });
    }
    const requestedCommit = input.commit_id ? requireUuid(input.commit_id) : null;
    const operationHandle = await this.operationLockHandle(handle);
    return this.runOnce(`commit:${handle}:${requestedCommit ?? "stored"}`, () =>
      this.runExclusive(`enrollment:${operationHandle}`, () =>
        this.withOperationLock(operationHandle, async () => {
      const prep = await this.updateJournal((journal) => {
        const entry = this.findEntry(journal, handle);
        this.assertTrustUnchanged(entry);
        if (entry.state === "cleanup_conflict") {
          throw new EnrollmentManagerError("cleanup_conflict", { stage: "commit", state: entry.state });
        }
        if (entry.state === "cancelled" || entry.state === "expired") {
          throw new EnrollmentManagerError("context_expired", { stage: "commit", state: entry.state });
        }
        if (!entry.agent_id || entry.agent_id !== confirmedAgent) {
          throw new EnrollmentManagerError("identity_mismatch", { stage: "commit", state: entry.state });
        }
        if (entry.commit_id && requestedCommit && entry.commit_id !== requestedCommit) {
          throw new EnrollmentManagerError("idempotency_conflict", { stage: "commit", state: entry.state });
        }
        const commitId = entry.commit_id ?? requestedCommit ?? randomUUID();
        if (
          (entry.state === "saved" || entry.state === "active") &&
          entry.remote_committed_at
        ) {
          return {
            entry,
            commitId,
            needsStage: false,
            alreadyDone: true as const,
          };
        }
        const snapshot = loadConnectionSnapshot(this.home);
        if (
          entry.expected_config_revision &&
          entry.expected_config_revision !== expectedRevision &&
          !entry.remote_committed_at
        ) {
          // A failed pre-Hub CAS may have observed a legitimate administrator
          // edit. Rebase that retry on the caller's current revision and take
          // the new bytes as the rollback target; once staging or Hub commit
          // began, the original request remains idempotent and immutable.
          if (
            entry.provisional_config_revision ||
            snapshot.revision !== expectedRevision
          ) {
            throw new EnrollmentManagerError("idempotency_conflict", {
              stage: "commit",
              state: entry.state,
            });
          }
          entry.previous_connection_contents = readConnectionFileContents(this.home);
          entry.previous_connection_captured = true;
        }
        if (!entry.previous_connection_captured) {
          entry.previous_connection_contents = readConnectionFileContents(this.home);
          entry.previous_connection_captured = true;
        }
        // A process may have crashed after the provisional CAS and before its
        // journal marker. Recognize our exact staged generation before doing
        // any Hub mutation again.
        if (
          !entry.remote_committed_at &&
          !entry.provisional_config_revision &&
          this.desiredConfigMatches(entry, snapshot.settings)
        ) {
          entry.provisional_config_revision = snapshot.revision;
        }
        const isOurProvisionalGeneration =
          Boolean(entry.provisional_config_revision) &&
          snapshot.revision === entry.provisional_config_revision;
        if (
          !entry.remote_committed_at &&
          snapshot.revision !== expectedRevision &&
          !isOurProvisionalGeneration
        ) {
          const conflict = new EnrollmentManagerError("config_conflict", { stage: "commit", state: entry.state });
          entry.last_error = {
            code: conflict.code,
            stage: conflict.stage,
            retryable: conflict.retryable,
            operation_id: conflict.operation_id,
            state: conflict.state,
          };
          throw conflict;
        }
        entry.commit_id = commitId;
        entry.expected_config_revision = expectedRevision;
        entry.confirmed_agent_id = confirmedAgent;
        entry.staged_token_file = entry.custody_file;
        entry.state = "commit_in_progress";
        entry.save_state = "saving";
        entry.last_error = null;
        return {
          entry,
          commitId,
          needsStage: !entry.remote_committed_at && !entry.provisional_config_revision,
          alreadyDone: false as const,
        };
      });
      let entry = prep.entry;
      if (prep.alreadyDone) {
        return {
          enrollment_handle: entry.enrollment_handle!,
          commit_id: entry.commit_id!,
          state: entry.state === "active" ? "active" : "saved",
          save_state: entry.save_state,
          activation_state: entry.activation_state,
          cleanup_state: entry.cleanup_state,
          ...(entry.config_revision ? { config_revision: entry.config_revision } : {}),
          ...(entry.remote_committed_at
            ? { remote_committed_at: entry.remote_committed_at }
            : {}),
        };
      }
      if (!entry.hub_enrollment_id || !entry.recovery_proof || !entry.custody_file) {
        const failure = new EnrollmentManagerError("save_failed", { stage: "commit", state: entry.state });
        await this.markCommitFailure(entry, failure, false);
        throw failure;
      }
      const stagedPatch = {
        hub_url: entry.endpoint,
        token_file: entry.custody_file!,
        ca_file: this.caFile ?? "",
        insecure_tls: false,
      };
      if (prep.needsStage) {
        try {
          if (!ensureRealFile(this.custodyPath(entry), "custody")) {
            throw new EnrollmentManagerError("save_failed", {
              stage: "custody",
              state: entry.state,
            });
          }
          const staged = setConnectionIfRevision(
            this.home,
            entry.expected_config_revision!,
            stagedPatch,
          );
          await this.updateJournal((journal) => {
            const current = this.findEntry(journal, handle);
            current.provisional_config_revision = staged.revision;
            current.staged_token_file = current.custody_file;
            current.last_error = null;
          });
        } catch (error) {
          const failure = new EnrollmentManagerError(
            error instanceof ConnectionRevisionConflictError
              ? "config_conflict"
              : "save_failed",
            { stage: "save", retryable: true, state: entry.state },
          );
          await this.markCommitFailure(entry, failure, false);
          throw failure;
        }
        const stagedJournal = await this.readJournal();
        entry = this.findEntry(stagedJournal, handle);
      }
      if (!entry.remote_committed_at) {
        try {
          const remoteResult = await this.transportFor(entry.endpoint).commit({
            enrollment_id: entry.hub_enrollment_id!,
            recovery_proof: entry.recovery_proof!,
            commit_id: prep.commitId,
          });
          if (this.remoteState(remoteResult) !== "committed") {
            throw new EnrollmentManagerError("protocol_error", {
              stage: "commit",
              retryable: true,
              state: entry.state,
              unknownOutcome: true,
            });
          }
        } catch (error) {
          const failure = safeError(error, "commit", prep.commitId, entry.state);
          await this.markCommitFailure(
            entry,
            failure,
            !failure.unknown_outcome && failure.code !== "hub_unreachable",
          );
          throw failure;
        }
        await this.updateJournal((journal) => {
          const current = this.findEntry(journal, handle);
          current.remote_committed_at ??= iso(this.now());
          current.last_error = null;
        });
      }
      const journal = await this.readJournal();
      entry = this.findEntry(journal, handle);
      const tokenFile = entry.custody_file!;
      let savedRevision: string | undefined;
      try {
        const current = loadConnectionSnapshot(this.home);
        const expected = entry.expected_config_revision!;
        const settings = loadConnection(this.home);
        const desiredCa = this.caFile ?? "";
        const alreadyPublished =
          settings.hub_url === entry.endpoint &&
          settings.token_file === tokenFile &&
          settings.ca_file === desiredCa &&
          settings.insecure_tls === false;
        if (alreadyPublished) {
          savedRevision = current.revision;
        } else {
          savedRevision = setConnectionIfRevision(this.home, expected, {
            hub_url: entry.endpoint,
            token_file: tokenFile,
            ca_file: desiredCa,
            insecure_tls: false,
          }).revision;
        }
      } catch (error) {
        const failure =
          error instanceof ConnectionRevisionConflictError
            ? new EnrollmentManagerError("config_conflict", {
                stage: "save",
                retryable: true,
                state: entry.state,
              })
            : new EnrollmentManagerError("save_failed", {
                stage: "save",
                retryable: true,
                state: entry.state,
              });
        await this.markCommitFailure(entry, failure, false);
        throw failure;
      }
      await this.updateJournal((journal) => {
        const current = this.findEntry(journal, handle);
        current.state = "saved";
        current.save_state = "saved";
        current.activation_state = "restart_required";
        current.saved_at ??= iso(this.now());
        current.config_revision = savedRevision!;
        current.last_error = null;
      });
      if (this.activationVerifier) {
        try {
          const evidence = await this.activationVerifier({
            home: this.home,
            endpoint: entry.endpoint,
            agent_id: entry.agent_id!,
            token_file: tokenFile,
          });
          if (evidence.route_verified) {
            await this.activate({ enrollment_handle: handle, evidence });
          }
        } catch (error) {
          const failure = safeError(error, "activation", prep.commitId, "saved");
          await this.changeState(entry, failure);
        }
      }
      const final = await this.readJournal();
      const current = this.findEntry(final, handle);
      return {
        enrollment_handle: current.enrollment_handle!,
        commit_id: current.commit_id!,
        state: current.state === "active" ? "active" : "saved",
        save_state: current.save_state,
        activation_state: current.activation_state,
        cleanup_state: current.cleanup_state,
        config_revision: current.config_revision!,
        remote_committed_at: current.remote_committed_at!,
      };
        }),
      ),
    );
  }

  /** Cancel only a pending Hub enrollment; never revoke a committed save. */
  async cancel(input: CancelEnrollmentInput): Promise<CancelEnrollmentResult> {
    const handle = requireHandle(input.enrollment_handle);
    const operationHandle = await this.operationLockHandle(handle);
    return this.runOnce(`cancel:${handle}`, () =>
      this.runExclusive(`enrollment:${operationHandle}`, () =>
        this.withOperationLock(operationHandle, async () => {
      let journal = await this.readJournal();
      let entry = this.findEntry(journal, handle);
      this.assertTrustUnchanged(entry);
      if (entry.state === "cancelled") {
        return { enrollment_handle: handle, state: "cancelled" as const, cleanup_state: "complete" as const };
      }
      if (entry.state === "saved" || entry.state === "active" || entry.remote_committed_at) {
        throw new EnrollmentManagerError("cleanup_conflict", { stage: "cancel", state: entry.state });
      }
      if (entry.state === "expired" && entry.cleanup_state === "complete") {
        try {
          await this.updateJournal((doc) => {
            const current = this.findEntry(doc, handle);
            this.removeCustody(current);
          });
        } catch {
          await this.updateJournal((doc) => {
            const current = this.findEntry(doc, handle);
            current.cleanup_state = "pending";
            current.last_error = {
              code: "cleanup_pending",
              stage: "custody",
              retryable: true,
              operation_id: null,
              state: current.state,
            };
          });
          throw new EnrollmentManagerError("cleanup_pending", {
            stage: "cancel",
            retryable: true,
            state: entry.state,
          });
        }
        return {
          enrollment_handle: handle,
          state: "expired",
          cleanup_state: "complete",
        };
      }
      if (!entry.hub_enrollment_id && entry.request_id && entry.recovery_proof) {
        try {
          const value = await this.transportFor(entry.endpoint).recover({
            request_id: entry.request_id,
            recovery_proof: entry.recovery_proof,
          });
          const parsed = this.parseRemoteRedeem(value);
          // Cancellation is scoped by the durable recovery proof and Hub
          // enrollment ID. It must remain available after identity verification
          // rejected the bearer, so do not require /me again here.
          await this.persistRemoteEnrollmentId(handle, parsed);
          await this.updateJournal((doc) => {
            const current = this.findEntry(doc, handle);
            if (parsed.state === "committed") {
              current.remote_committed_at ??= iso(this.now());
            }
          });
        } catch (error) {
          const failure = safeError(error, "recover", entry.request_id, entry.state);
          await this.changeState(entry, failure);
          throw failure;
        }
        journal = await this.readJournal();
        entry = this.findEntry(journal, handle);
      }
      if (entry.remote_committed_at) {
        throw new EnrollmentManagerError("cleanup_conflict", {
          stage: "cancel",
          state: entry.state,
        });
      }
      if (!entry.hub_enrollment_id || !entry.recovery_proof) {
        await this.updateJournal((doc) => {
          const current = this.findEntry(doc, handle);
          current.state = current.state === "expired" ? "expired" : "cancelled";
          current.cleanup_state = "complete";
          this.removeCustody(current);
          current.last_error = null;
        });
        const terminalState = entry.state === "expired" ? "expired" : "cancelled";
        return { enrollment_handle: handle, state: terminalState, cleanup_state: "complete" };
      }
      await this.updateJournal((doc) => {
        const current = this.findEntry(doc, handle);
        current.state = "cleanup_pending";
        current.cleanup_state = "pending";
        current.last_error = null;
      });
      try {
        const result = await this.transportFor(entry.endpoint).cancel({
          enrollment_id: entry.hub_enrollment_id,
          recovery_proof: entry.recovery_proof,
        });
        const remoteState = this.remoteState(result);
        if (remoteState === "committed") {
          const failure = new EnrollmentManagerError("cleanup_conflict", {
            stage: "cancel",
            state: "cleanup_pending",
          });
          await this.updateJournal((doc) => {
            const current = this.findEntry(doc, handle);
            current.remote_committed_at ??= iso(this.now());
            current.state = "cleanup_conflict";
            current.cleanup_state = "conflict";
            current.last_error = {
              code: failure.code,
              stage: failure.stage,
              retryable: failure.retryable,
              operation_id: failure.operation_id,
              state: failure.state,
            };
          });
          throw failure;
        }
        if (remoteState === "cleanup_pending") {
          await this.updateJournal((doc) => {
            const current = this.findEntry(doc, handle);
            current.state = "cleanup_pending";
            current.cleanup_state = "pending";
          });
          throw new EnrollmentManagerError("cleanup_pending", {
            stage: "cancel",
            retryable: true,
            state: "cleanup_pending",
          });
        }
        if (remoteState === "cleanup_conflict") {
          await this.updateJournal((doc) => {
            const current = this.findEntry(doc, handle);
            current.state = "cleanup_conflict";
            current.cleanup_state = "conflict";
          });
          throw new EnrollmentManagerError("cleanup_conflict", {
            stage: "cancel",
            state: "cleanup_pending",
          });
        }
        if (remoteState !== "cancelled" && remoteState !== "expired") {
          throw new EnrollmentManagerError("protocol_error", {
            stage: "cancel",
            retryable: true,
            state: "cleanup_pending",
            unknownOutcome: true,
          });
        }
        const rollback = await this.rollbackProvisional(entry);
        if (rollback === "conflict") {
          const failure = new EnrollmentManagerError("cleanup_conflict", {
            stage: "rollback",
            state: "cleanup_pending",
          });
          await this.updateJournal((doc) => {
            const current = this.findEntry(doc, handle);
            current.state = "cleanup_conflict";
            current.cleanup_state = "conflict";
            current.save_state = "error";
            current.last_error = {
              code: failure.code,
              stage: failure.stage,
              retryable: failure.retryable,
              operation_id: failure.operation_id,
              state: failure.state,
            };
          });
          throw failure;
        }
        const localState = remoteState as "cancelled" | "expired";
        await this.updateJournal((doc) => {
          const current = this.findEntry(doc, handle);
          this.removeCustody(current);
          current.state = localState;
          current.cleanup_state = "complete";
          current.last_error = null;
        });
        return {
          enrollment_handle: handle,
          state: localState,
          cleanup_state: "complete" as const,
        };
      } catch (error) {
        const failure = safeError(error, "cancel", entry.hub_enrollment_id, "cleanup_pending");
        await this.changeState(entry, failure);
        throw failure;
      }
      throw new EnrollmentManagerError("cleanup_pending", {
        stage: "cancel",
        retryable: true,
        state: "cleanup_pending",
      });
        }),
      ),
    );
  }

  /** Mark a saved enrollment active only with host route evidence. */
  async activate(input: ActivateEnrollmentInput): Promise<ActivateEnrollmentResult> {
    const handle = requireHandle(input.enrollment_handle);
    const journal = await this.readJournal();
    const entry = this.findEntry(journal, handle);
    if (entry.state !== "saved" && entry.state !== "active") {
      throw new EnrollmentManagerError("activation_failed", { stage: "activation", state: entry.state });
    }
    let evidence = input.evidence;
    if (!evidence && this.activationVerifier) {
      evidence = await this.activationVerifier({
        home: this.home,
        endpoint: entry.endpoint,
        agent_id: entry.agent_id!,
        token_file: entry.custody_file!,
      });
    }
    if (
      !evidence ||
      evidence.route_verified !== true ||
      evidence.effective_hub_url !== entry.endpoint ||
      evidence.agent_id !== entry.agent_id
    ) {
      const failure = new EnrollmentManagerError("activation_failed", {
        stage: "activation",
        retryable: true,
        state: entry.state,
      });
      await this.changeState(entry, failure);
      await this.updateJournal((doc) => {
        const current = this.findEntry(doc, handle);
        current.activation_state = "error";
        current.last_error = {
          code: failure.code,
          stage: failure.stage,
          retryable: failure.retryable,
          operation_id: failure.operation_id,
          state: failure.state,
        };
      });
      throw failure;
    }
    const activatedAt = evidence.observed_at ?? iso(this.now());
    await this.updateJournal((doc) => {
      const current = this.findEntry(doc, handle);
      current.state = "active";
      current.activation_state = "active";
      current.activated_at = activatedAt;
      current.last_error = null;
    });
    return {
      enrollment_handle: handle,
      state: "active",
      activation_state: "active",
      save_state: "saved",
      cleanup_state: "none",
      activated_at: activatedAt,
    };
  }
}
