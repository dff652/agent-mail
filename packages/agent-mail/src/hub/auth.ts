import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { atomicWriteText, withFileLockSync } from "../atomic-file.js";
import { validateAgentId } from "../ids.js";

export interface TokenRecord {
  agent_id: string;
  token_hash: string;
  created_at: string;
  label: string;
  generation: number;
}

export type TokenMetadata = Omit<TokenRecord, "token_hash">;

export interface MintTokenSnapshot {
  token: string;
  issued_hash: string;
  replaced: TokenRecord[];
}

export const DEFAULT_WEBHOOK_SKEW_SECONDS = 300;
export const WEBHOOK_REPLAY_MAX_ENTRIES = 10_000;

export class WebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookAuthError";
  }
}

export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

interface TokenAuditEvent {
  ts: string;
  event_id: string;
  operation: "mint" | "rotate" | "revoke_previous" | "revoke" | "restore";
  agent_id: string;
  label: string;
  generation: number | null;
  active_tokens: number;
}

export function tokensPath(home: string): string {
  return path.join(path.resolve(home), "auth", "hub_tokens.json");
}

export function tokenAuditPath(home: string): string {
  return path.join(path.resolve(home), "auth", "token_audit.jsonl");
}

export function webhookSecretPath(home: string): string {
  return path.join(path.resolve(home), "auth", "webhook_secret");
}

function ensureRealAuthDirectory(home: string): string {
  const directory = path.dirname(tokensPath(home));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`auth path must be a real directory: ${directory}`);
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  return directory;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function validateTokenRecord(item: unknown, storePath: string): TokenRecord {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`invalid hub token entry: ${storePath}`);
  }
  const candidate = item as Record<string, unknown>;
  const agentId = validateAgentId(
    typeof candidate.agent_id === "string" ? candidate.agent_id : "",
  );
  if (
    typeof candidate.token_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.token_hash) ||
    typeof candidate.created_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.created_at)) ||
    (candidate.label !== undefined && typeof candidate.label !== "string") ||
    (candidate.generation !== undefined &&
      (!Number.isInteger(candidate.generation) ||
        (candidate.generation as number) < 0))
  ) {
    throw new Error(`invalid hub token entry: ${storePath}`);
  }
  return {
    agent_id: agentId,
    token_hash: candidate.token_hash,
    created_at: candidate.created_at,
    label: candidate.label ?? "",
    generation: (candidate.generation as number | undefined) ?? 0,
  };
}

export function loadTokenRecords(home: string): TokenRecord[] {
  const storePath = tokensPath(home);
  if (!fs.existsSync(storePath)) return [];
  const stat = fs.lstatSync(storePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`hub token store must be a real file: ${storePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `invalid hub token store: ${storePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).schema_version !== 1 ||
    !Array.isArray((raw as Record<string, unknown>).tokens)
  ) {
    throw new Error(`invalid hub token store: ${storePath}`);
  }
  const records = ((raw as Record<string, unknown>).tokens as unknown[]).map(
    (item) => validateTokenRecord(item, storePath),
  );
  if (new Set(records.map((record) => record.token_hash)).size !== records.length) {
    throw new Error(`duplicate hashes in hub token store: ${storePath}`);
  }
  return records;
}

function saveTokenRecordsUnlocked(home: string, records: TokenRecord[]): void {
  ensureRealAuthDirectory(home);
  const payload = {
    schema_version: 1,
    tokens: records.map((record) => ({
      agent_id: record.agent_id,
      token_hash: record.token_hash,
      created_at: record.created_at,
      label: record.label,
      generation: record.generation,
    })),
  };
  atomicWriteText(
    tokensPath(home),
    `${JSON.stringify(payload, null, 2)}\n`,
    0o600,
  );
}

function appendTokenAuditUnlocked(
  home: string,
  event: Omit<TokenAuditEvent, "ts" | "event_id">,
): void {
  ensureRealAuthDirectory(home);
  const auditPath = tokenAuditPath(home);
  if (fs.existsSync(auditPath)) {
    const stat = fs.lstatSync(auditPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`token audit path must be a real file: ${auditPath}`);
    }
  }
  const record: TokenAuditEvent = {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    ...event,
  };
  const fd = fs.openSync(
    auditPath,
    fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(fd);
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  } finally {
    fs.closeSync(fd);
  }
}

function tokenLock<T>(home: string, fn: () => T): T {
  ensureRealAuthDirectory(home);
  return withFileLockSync(tokensPath(home), fn);
}

function commitTokenMutation(
  home: string,
  before: TokenRecord[],
  after: TokenRecord[],
  event: Omit<TokenAuditEvent, "ts" | "event_id" | "active_tokens">,
): void {
  saveTokenRecordsUnlocked(home, after);
  try {
    appendTokenAuditUnlocked(home, {
      ...event,
      active_tokens: after.filter(
        (record) => record.agent_id === event.agent_id,
      ).length,
    });
  } catch (auditError) {
    try {
      saveTokenRecordsUnlocked(home, before);
    } catch (rollbackError) {
      throw new Error(
        `token audit failed and token rollback failed: ${
          auditError instanceof Error ? auditError.message : String(auditError)
        }; rollback: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
      );
    }
    throw auditError;
  }
}

function newest(records: TokenRecord[]): TokenRecord | null {
  return (
    [...records].sort((left, right) =>
      left.generation === right.generation
        ? right.created_at.localeCompare(left.created_at)
        : right.generation - left.generation,
    )[0] ?? null
  );
}

/** Hard cutover mint: replaces all tokens for agent_id. */
export function mintToken(home: string, agentId: string, label = ""): string {
  return mintTokenWithSnapshot(home, agentId, label).token;
}

/** Pairing helper: returns the records replaced by this exact locked mint. */
export function mintTokenWithSnapshot(
  home: string,
  agentId: string,
  label = "",
): MintTokenSnapshot {
  const id = validateAgentId(agentId);
  return tokenLock(home, () => {
    const before = loadTokenRecords(home);
    const generation = 0;
    const token = generateToken();
    const issuedHash = hashToken(token);
    const replaced = before.filter((record) => record.agent_id === id);
    const after = before.filter((record) => record.agent_id !== id);
    after.push({
      agent_id: id,
      token_hash: issuedHash,
      created_at: new Date().toISOString(),
      label,
      generation,
    });
    commitTokenMutation(home, before, after, {
      operation: "mint",
      agent_id: id,
      label,
      generation,
    });
    return { token, issued_hash: issuedHash, replaced };
  });
}

/**
 * Issue a new token while keeping the newest old token valid.
 * A second rotation drops the oldest token, so at most two remain per agent.
 */
export function rotateToken(home: string, agentId: string, label = ""): string {
  const id = validateAgentId(agentId);
  return tokenLock(home, () => {
    const before = loadTokenRecords(home);
    const mine = before.filter((record) => record.agent_id === id);
    const previous = newest(mine);
    const generation =
      mine.length === 0
        ? 0
        : Math.max(...mine.map((record) => record.generation)) + 1;
    const token = generateToken();
    const after = before.filter((record) => record.agent_id !== id);
    if (previous) after.push(previous);
    after.push({
      agent_id: id,
      token_hash: hashToken(token),
      created_at: new Date().toISOString(),
      label: label || "rotated",
      generation,
    });
    commitTokenMutation(home, before, after, {
      operation: "rotate",
      agent_id: id,
      label: label || "rotated",
      generation,
    });
    return token;
  });
}

/** End the grace window by keeping only the newest token. */
export function revokePreviousToken(home: string, agentId: string): boolean {
  const id = validateAgentId(agentId);
  return tokenLock(home, () => {
    const before = loadTokenRecords(home);
    const mine = before.filter((record) => record.agent_id === id);
    if (mine.length <= 1) return false;
    const current = newest(mine)!;
    const after = before.filter((record) => record.agent_id !== id);
    after.push(current);
    commitTokenMutation(home, before, after, {
      operation: "revoke_previous",
      agent_id: id,
      label: current.label,
      generation: current.generation,
    });
    return true;
  });
}

/** Revoke all bearer tokens for one agent. */
export function revokeToken(home: string, agentId: string): boolean {
  const id = validateAgentId(agentId);
  return tokenLock(home, () => {
    const before = loadTokenRecords(home);
    const mine = before.filter((record) => record.agent_id === id);
    if (mine.length === 0) return false;
    const after = before.filter((record) => record.agent_id !== id);
    const current = newest(mine);
    commitTokenMutation(home, before, after, {
      operation: "revoke",
      agent_id: id,
      label: current?.label ?? "",
      generation: current?.generation ?? null,
    });
    return true;
  });
}

/** Restore all prior records for an agent after failed enrollment. */
export function restoreTokenRecords(
  home: string,
  agentId: string,
  previous: TokenRecord[],
): void {
  restoreTokenRecordsInternal(home, agentId, previous);
}

/**
 * Restore only when the named mint is still the sole current record.
 * This prevents enrollment compensation from overwriting a later rotation.
 */
export function restoreTokenRecordsIfCurrent(
  home: string,
  agentId: string,
  expectedCurrentHash: string,
  previous: TokenRecord[],
  onRestoredWhileLocked?: () => void,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedCurrentHash)) {
    throw new Error("invalid expected token hash for restore");
  }
  return restoreTokenRecordsInternal(
    home,
    agentId,
    previous,
    expectedCurrentHash,
    onRestoredWhileLocked,
  );
}

function restoreTokenRecordsInternal(
  home: string,
  agentId: string,
  previous: TokenRecord[],
  expectedCurrentHash?: string,
  onRestoredWhileLocked?: () => void,
): boolean {
  const id = validateAgentId(agentId);
  const restored = previous.map((record) => {
    if (record.agent_id !== id) {
      throw new Error(`cannot restore token for a different agent: ${record.agent_id}`);
    }
    return validateTokenRecord(record, tokensPath(home));
  });
  return tokenLock(home, () => {
    const before = loadTokenRecords(home);
    if (expectedCurrentHash) {
      const current = before.filter((record) => record.agent_id === id);
      if (
        current.length !== 1 ||
        current[0]?.token_hash !== expectedCurrentHash
      ) {
        return false;
      }
    }
    const after = before.filter((record) => record.agent_id !== id);
    after.push(...restored);
    const current = newest(restored);
    commitTokenMutation(home, before, after, {
      operation: "restore",
      agent_id: id,
      label: current?.label ?? "",
      generation: current?.generation ?? null,
    });
    onRestoredWhileLocked?.();
    return true;
  });
}

/** Backward-compatible single-record enrollment rollback helper. */
export function restoreTokenRecord(
  home: string,
  agentId: string,
  previous: TokenRecord | null,
): void {
  restoreTokenRecords(home, agentId, previous ? [previous] : []);
}

export function findTokenRecords(home: string, agentId: string): TokenRecord[] {
  const id = validateAgentId(agentId);
  return loadTokenRecords(home).filter((record) => record.agent_id === id);
}

export function findTokenRecord(
  home: string,
  agentId: string,
): TokenRecord | null {
  return newest(findTokenRecords(home, agentId));
}

/** Safe listing surface: token hashes never leave this module. */
export function listTokenMetadata(home: string): TokenMetadata[] {
  return loadTokenRecords(home).map(
    ({ agent_id, created_at, label, generation }) => ({
      agent_id,
      created_at,
      label,
      generation,
    }),
  );
}

export function authenticateBearer(
  home: string,
  authorization: string | null | undefined,
): string {
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
    throw new Error("missing or invalid Authorization bearer token");
  }
  const token = authorization.slice(7).trim();
  if (!token || token.length > 512) {
    throw new Error("missing or invalid Authorization bearer token");
  }
  const digest = hashToken(token);
  const digestBuffer = Buffer.from(digest, "utf8");
  for (const record of loadTokenRecords(home)) {
    const recordBuffer = Buffer.from(record.token_hash, "utf8");
    if (
      recordBuffer.length === digestBuffer.length &&
      timingSafeEqual(recordBuffer, digestBuffer)
    ) {
      return record.agent_id;
    }
  }
  throw new Error("unknown or revoked bearer token");
}

function validateWebhookSecret(secret: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error("invalid webhook secret");
  }
  return secret;
}

export function loadWebhookSecret(home: string): string | null {
  const secretPath = webhookSecretPath(home);
  const authDirectory = path.dirname(secretPath);
  if (!fs.existsSync(authDirectory)) return null;
  const directoryStat = fs.lstatSync(authDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`auth path must be a real directory: ${authDirectory}`);
  }
  if (!fs.existsSync(secretPath)) return null;
  const stat = fs.lstatSync(secretPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 32 ||
    stat.size > 1024 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(`webhook secret must be a private regular file: ${secretPath}`);
  }
  return validateWebhookSecret(fs.readFileSync(secretPath, "utf8").trim());
}

/** Create once; later calls return the same configured secret. */
export function ensureWebhookSecret(home: string): string {
  const secretPath = webhookSecretPath(home);
  ensureRealAuthDirectory(home);
  return withFileLockSync(secretPath, () => {
    const existing = loadWebhookSecret(home);
    if (existing) return existing;
    const secret = generateToken();
    atomicWriteText(secretPath, `${secret}\n`, 0o600);
    return secret;
  });
}

export function signWebhookBody(
  secret: string,
  body: Buffer,
  timestamp: string,
  nonce: string,
): string {
  validateWebhookSecret(secret);
  return createHmac("sha256", secret)
    .update(timestamp, "utf8")
    .update(".", "utf8")
    .update(nonce, "utf8")
    .update(".", "utf8")
    .update(body)
    .digest("hex");
}

export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  readonly skewSeconds: number;
  readonly maxEntries: number;

  constructor(
    options: { skewSeconds?: number; maxEntries?: number } = {},
  ) {
    this.skewSeconds = options.skewSeconds ?? DEFAULT_WEBHOOK_SKEW_SECONDS;
    this.maxEntries = options.maxEntries ?? WEBHOOK_REPLAY_MAX_ENTRIES;
    if (
      !Number.isFinite(this.skewSeconds) ||
      this.skewSeconds < 1 ||
      this.skewSeconds > 86_400 ||
      !Number.isInteger(this.maxEntries) ||
      this.maxEntries < 10 ||
      this.maxEntries > 1_000_000
    ) {
      throw new Error("invalid webhook replay guard limits");
    }
  }

  checkAndRemember(timestamp: string, nonce: string, now = new Date()): void {
    if (!/^[\x20-\x7e]{1,128}$/.test(nonce)) {
      throw new WebhookValidationError(
        "webhook nonce is required and must be <= 128 printable ASCII characters",
      );
    }
    const timestampMs = Date.parse(timestamp);
    if (
      !/^\d{4}-\d{2}-\d{2}T/.test(timestamp) ||
      !Number.isFinite(timestampMs)
    ) {
      throw new WebhookValidationError("webhook timestamp must be ISO-8601");
    }
    const nowMs = now.getTime();
    if (
      !Number.isFinite(nowMs) ||
      Math.abs(nowMs - timestampMs) > this.skewSeconds * 1000
    ) {
      throw new WebhookValidationError(
        "webhook timestamp outside allowed skew window",
      );
    }
    const cutoff = nowMs - this.skewSeconds * 2 * 1000;
    for (const [key, seenAt] of this.seen) {
      if (seenAt < cutoff) this.seen.delete(key);
    }
    const key = `${timestamp}:${nonce}`;
    if (this.seen.has(key)) {
      throw new WebhookValidationError("webhook replay detected");
    }
    this.seen.set(key, nowMs);
    if (this.seen.size > this.maxEntries) {
      const drop = Math.ceil(this.seen.size / 2);
      let removed = 0;
      for (const seenKey of this.seen.keys()) {
        this.seen.delete(seenKey);
        removed += 1;
        if (removed >= drop) break;
      }
    }
  }
}

export function verifyWebhook(
  home: string,
  input: {
    body: Buffer;
    timestamp?: string;
    nonce?: string;
    signature?: string;
    replay: ReplayGuard;
  },
): void {
  const secret = loadWebhookSecret(home);
  if (!secret) {
    throw new WebhookAuthError(
      "webhook secret not configured; run agent-mail hub-token webhook-init",
    );
  }
  if (!input.timestamp || !input.nonce || !input.signature) {
    throw new WebhookAuthError(
      "webhook requires X-Agent-Mail-Timestamp, Nonce, and Signature",
    );
  }
  const expected = signWebhookBody(
    secret,
    input.body,
    input.timestamp,
    input.nonce,
  );
  const supplied = input.signature.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) {
    throw new WebhookAuthError("webhook signature mismatch");
  }
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(supplied, "hex");
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    throw new WebhookAuthError("webhook signature mismatch");
  }
  input.replay.checkAndRemember(input.timestamp, input.nonce);
}
