/**
 * L2 pairing-code enrollment (single Hub).
 * Spec: docs/architecture/pairing-enrollment-spec.md
 * Codes/tokens are never written to audit logs in plaintext.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  mintTokenWithSnapshot,
  restoreTokenRecordsIfCurrent,
  type TokenRecord,
} from "./hub/auth.js";
import { validateAgentId } from "./ids.js";
import { ensureAgent, removeAgent } from "./roster.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
export const DEFAULT_TTL_SECONDS = 600;
export const DEFAULT_MAX_ATTEMPTS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  redeemed_at TEXT,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pairing_status_exp ON pairing_codes(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pairing_agent ON pairing_codes(agent_id);
`;

export class PairingError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "PairingError";
    this.exitCode = exitCode;
  }
}

export interface PairingRecord {
  id: string;
  agent_id: string;
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  status: string;
  redeemed_at: string | null;
  max_attempts: number;
  attempt_count: number;
}

export interface CreateResult {
  pair_id: string;
  code: string;
  agent_id: string;
  expires_at: string;
}

export interface RedeemResult {
  agent_id: string;
  token: string;
  pair_id: string;
}

export interface PairingCompensationResult {
  token_restored: boolean;
  roster_removed: boolean;
}

function iso(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function pairingDbPath(home: string): string {
  return path.join(path.resolve(home), "auth", "pairing.sqlite");
}

function openDb(home: string): Database.Database {
  const p = pairingDbPath(home);
  const directory = path.dirname(p);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new PairingError(`pairing auth path must be a real directory: ${directory}`);
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  if (!fs.existsSync(p)) {
    const fd = fs.openSync(
      p,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.closeSync(fd);
  } else {
    const stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PairingError(`pairing database must be a real file: ${p}`);
    }
  }
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  for (const sidecar of [`${p}-wal`, `${p}-shm`]) {
    if (!fs.existsSync(sidecar)) continue;
    try {
      fs.chmodSync(sidecar, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  }
  return db;
}

export function hashCode(code: string): string {
  const normalized = code.trim().toUpperCase().replace(/\s+/g, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function generateCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += CROCKFORD[randomBytes(1)[0]! % CROCKFORD.length]!;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function lazyExpire(db: Database.Database, nowIso: string): void {
  db.prepare(
    `UPDATE pairing_codes SET status='expired'
     WHERE status='pending' AND expires_at < ?`,
  ).run(nowIso);
}

function rowToRecord(row: Record<string, unknown>): PairingRecord {
  return {
    id: String(row.id),
    agent_id: String(row.agent_id),
    label: String(row.label || ""),
    created_by: String(row.created_by || ""),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    status: String(row.status),
    redeemed_at: row.redeemed_at != null ? String(row.redeemed_at) : null,
    max_attempts: Number(row.max_attempts),
    attempt_count: Number(row.attempt_count),
  };
}

export function createPairing(
  home: string,
  agentId: string,
  opts: {
    ttlSeconds?: number;
    label?: string;
    createdBy?: string;
    maxAttempts?: number;
  } = {},
): CreateResult {
  const root = path.resolve(home);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new PairingError(`not initialized: ${root}`, 3);
  }
  const id = validateAgentId(agentId);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (ttl < 60 || ttl > 86400) {
    throw new PairingError("ttl must be between 60 and 86400 seconds");
  }
  if (maxAttempts < 1 || maxAttempts > 20) {
    throw new PairingError("max_attempts must be between 1 and 20");
  }

  const now = new Date();
  const pairId = `pair_${randomUUID().replace(/-/g, "")}`;
  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const createdBy = opts.createdBy ?? "admin@local";
  const label = opts.label ?? "";

  const db = openDb(root);
  try {
    try {
      db.prepare(
        `
        INSERT INTO pairing_codes(
          id, code_hash, agent_id, label, created_by, created_at, expires_at,
          status, redeemed_at, max_attempts, attempt_count
        ) VALUES (?,?,?,?,?,?,?,'pending',NULL,?,0)
        `,
      ).run(
        pairId,
        codeHash,
        id,
        label,
        createdBy,
        iso(now),
        iso(expiresAt),
        maxAttempts,
      );
    } catch {
      throw new PairingError("could not create pairing code (hash collision)");
    }
  } finally {
    db.close();
  }

  return {
    pair_id: pairId,
    code,
    agent_id: id,
    expires_at: iso(expiresAt),
  };
}

export function listPairings(home: string): PairingRecord[] {
  const root = path.resolve(home);
  const db = openDb(root);
  try {
    lazyExpire(db, iso());
    const rows = db
      .prepare("SELECT * FROM pairing_codes ORDER BY created_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  } finally {
    db.close();
  }
}

export function revokePairing(
  home: string,
  pairId: string,
): boolean {
  if (!pairId.startsWith("pair_")) {
    throw new PairingError("invalid pair id");
  }
  const root = path.resolve(home);
  const db = openDb(root);
  try {
    const row = db
      .prepare("SELECT status FROM pairing_codes WHERE id=?")
      .get(pairId) as { status: string } | undefined;
    if (!row) return false;
    if (row.status !== "pending") {
      throw new PairingError(`cannot revoke pairing in status ${row.status}`);
    }
    db.prepare(
      "UPDATE pairing_codes SET status='rejected' WHERE id=? AND status='pending'",
    ).run(pairId);
    return true;
  } finally {
    db.close();
  }
}

/**
 * Compensate a minted enrollment without overwriting a later token operation.
 * A newer token means another actor now owns the state, so its roster entry
 * must remain valid as well.
 */
export function compensateMintedEnrollment(
  home: string,
  agentId: string,
  mintedHash: string,
  previous: TokenRecord[],
  rosterAdded: boolean,
): PairingCompensationResult {
  let rosterRemoved = false;
  const tokenRestored = restoreTokenRecordsIfCurrent(
    home,
    agentId,
    mintedHash,
    previous,
    () => {
      rosterRemoved = rosterAdded ? removeAgent(home, agentId) : false;
    },
  );
  return {
    token_restored: tokenRestored,
    roster_removed: rosterRemoved,
  };
}

/**
 * Redeem a pending code; returns one-time hub token plaintext.
 * Side effects (roster + mint) commit before marking redeemed; rollback on failure.
 */
export function redeemPairing(home: string, code: string): RedeemResult {
  const root = path.resolve(home);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new PairingError(`not initialized: ${root}`, 3);
  }
  const normalized = code.trim().toUpperCase().replace(/\s+/g, "");
  if (!CODE_RE.test(normalized)) {
    throw new PairingError("invalid_or_expired_code");
  }
  const codeHash = hashCode(normalized);
  const now = new Date();
  const nowIso = iso(now);

  const db = openDb(root);
  let rosterAdded = false;
  let tokenMinted = false;
  let previous: TokenRecord[] = [];
  let mintedHash = "";
  let agentId = "";
  let pairId = "";
  let token = "";

  try {
    const tx = db.transaction(() => {
      lazyExpire(db, nowIso);
      const row = db
        .prepare("SELECT * FROM pairing_codes WHERE code_hash=?")
        .get(codeHash) as Record<string, unknown> | undefined;
      if (!row) {
        throw new PairingError("invalid_or_expired_code");
      }
      if (String(row.status) !== "pending") {
        throw new PairingError("invalid_or_expired_code");
      }
      if (new Date(String(row.expires_at)).getTime() < now.getTime()) {
        db.prepare(
          "UPDATE pairing_codes SET status='expired' WHERE id=?",
        ).run(String(row.id));
        throw new PairingError("invalid_or_expired_code");
      }

      agentId = String(row.agent_id);
      pairId = String(row.id);
      const label = String(row.label || "");
      // Keep transaction open across side effects? better-sqlite3 holds lock for
      // the sync transaction callback — perform roster+mint inside.
      try {
        rosterAdded = ensureAgent(root, {
          id: agentId,
          display_name: label.trim() || agentId.split("@", 1)[0] || agentId,
          skills: ["paired"],
        });
        const minted = mintTokenWithSnapshot(root, agentId, label || "paired");
        token = minted.token;
        mintedHash = minted.issued_hash;
        previous = minted.replaced;
        tokenMinted = true;
        const r = db
          .prepare(
            `UPDATE pairing_codes SET status='redeemed', redeemed_at=?
             WHERE id=? AND status='pending'`,
          )
          .run(nowIso, pairId);
        if (r.changes !== 1) {
          throw new PairingError("invalid_or_expired_code");
        }
      } catch (e) {
        if (tokenMinted) {
          compensateMintedEnrollment(
            root,
            agentId,
            mintedHash,
            previous,
            rosterAdded,
          );
        } else if (rosterAdded) removeAgent(root, agentId);
        if (e instanceof PairingError) throw e;
        throw new PairingError(
          `pairing enrollment failed: ${e instanceof Error ? e.message : String(e)}`,
          3,
        );
      }
    });
    tx();
  } finally {
    db.close();
  }

  return { agent_id: agentId, token, pair_id: pairId };
}
