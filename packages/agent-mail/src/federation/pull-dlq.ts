import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { dtToIso, utcNow } from "../ids.js";
import { importEnvelope } from "./envelope.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  ERROR_SNIPPET,
  STATUS_DEAD,
  STATUS_PENDING,
} from "./outbox.js";

export const PULL_DLQ_FILENAME = "federation_pull_dlq.sqlite";

export interface PullDeadLetterItem {
  direction: "pull";
  source_domain: string;
  message_id: string;
  attempts: number;
  last_error: string;
  first_failed_at: string;
  last_failed_at: string;
  dead_at: string;
}

export interface PullRequeueResult {
  requeued: string[];
  errors: string[];
}

export function pullDlqPath(home: string): string {
  return path.join(path.resolve(home), PULL_DLQ_FILENAME);
}

function safeError(error: string): string {
  return (error || "pull import failed")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, ERROR_SNIPPET);
}

function ensurePrivateDatabaseFile(home: string): string {
  const resolvedHome = path.resolve(home);
  const homeStat = fs.lstatSync(resolvedHome);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error(`Agent Mail home must be a real directory: ${resolvedHome}`);
  }
  const dbPath = pullDlqPath(home);
  if (!fs.existsSync(dbPath)) {
    const fd = fs.openSync(
      dbPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.closeSync(fd);
  }
  const stat = fs.lstatSync(dbPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(`pull DLQ must be a private regular file: ${dbPath}`);
  }
  return dbPath;
}

function openPullDlq(home: string): Database.Database {
  const dbPath = ensurePrivateDatabaseFile(home);
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = DELETE");
    const version = Number(db.pragma("user_version", { simple: true }));
    if (version !== 0 && version !== 1) {
      throw new Error(`unsupported pull DLQ schema version: ${version}`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS pull_failures (
        source_domain TEXT NOT NULL,
        message_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT NOT NULL,
        first_failed_at TEXT NOT NULL,
        last_failed_at TEXT NOT NULL,
        dead_at TEXT,
        PRIMARY KEY(source_domain, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pull_failures_status
        ON pull_failures(status, last_failed_at);
    `);
    if (version === 0) db.pragma("user_version = 1");
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function validateKey(sourceDomain: string, messageId: string): void {
  if (
    !sourceDomain ||
    sourceDomain.length > 253 ||
    !messageId ||
    messageId.length > 256
  ) {
    throw new Error("pull DLQ requires bounded source_domain and message_id");
  }
}

export function recordPullFailure(
  home: string,
  input: {
    sourceDomain: string;
    messageId: string;
    envelope: Record<string, unknown>;
    error: string;
    maxAttempts?: number;
  },
): string {
  validateKey(input.sourceDomain, input.messageId);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10_000
  ) {
    throw new Error("pull DLQ maxAttempts must be 1..10000");
  }
  const envelopeJson = JSON.stringify(input.envelope);
  const error = safeError(input.error);
  const now = dtToIso(utcNow());
  const db = openPullDlq(home);
  try {
    return db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT status, attempts FROM pull_failures
           WHERE source_domain=? AND message_id=?`,
        )
        .get(input.sourceDomain, input.messageId) as
        | { status: string; attempts: number }
        | undefined;
      if (existing?.status === STATUS_DEAD) return STATUS_DEAD;
      const attempts = Number(existing?.attempts ?? 0) + 1;
      const status =
        attempts >= maxAttempts ? STATUS_DEAD : STATUS_PENDING;
      const deadAt = status === STATUS_DEAD ? now : null;
      db.prepare(
        `
        INSERT INTO pull_failures(
          source_domain, message_id, envelope_json, status, attempts,
          last_error, first_failed_at, last_failed_at, dead_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_domain, message_id) DO UPDATE SET
          envelope_json=excluded.envelope_json,
          status=excluded.status,
          attempts=excluded.attempts,
          last_error=excluded.last_error,
          last_failed_at=excluded.last_failed_at,
          dead_at=excluded.dead_at
        `,
      ).run(
        input.sourceDomain,
        input.messageId,
        envelopeJson,
        status,
        attempts,
        error,
        now,
        now,
        deadAt,
      );
      return status;
    })();
  } finally {
    db.close();
  }
}

export function clearPullFailure(
  home: string,
  sourceDomain: string,
  messageId: string,
): void {
  validateKey(sourceDomain, messageId);
  if (!fs.existsSync(pullDlqPath(home))) return;
  const db = openPullDlq(home);
  try {
    db.prepare(
      "DELETE FROM pull_failures WHERE source_domain=? AND message_id=?",
    ).run(sourceDomain, messageId);
  } finally {
    db.close();
  }
}

export function listPullDeadLetters(
  home: string,
  limit = 100,
): PullDeadLetterItem[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("pull DLQ limit must be 1..10000");
  }
  if (!fs.existsSync(pullDlqPath(home))) return [];
  const db = openPullDlq(home);
  try {
    const rows = db
      .prepare(
        `
        SELECT source_domain, message_id, attempts, last_error,
               first_failed_at, last_failed_at, dead_at
        FROM pull_failures
        WHERE status='dead'
        ORDER BY last_failed_at ASC
        LIMIT ?
        `,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      direction: "pull",
      source_domain: String(row.source_domain),
      message_id: String(row.message_id),
      attempts: Number(row.attempts),
      last_error: String(row.last_error),
      first_failed_at: String(row.first_failed_at),
      last_failed_at: String(row.last_failed_at),
      dead_at: String(row.dead_at ?? ""),
    }));
  } finally {
    db.close();
  }
}

export function countPullDeadLetters(home: string): number {
  if (!fs.existsSync(pullDlqPath(home))) return 0;
  const db = openPullDlq(home);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM pull_failures WHERE status='dead'")
      .get() as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

export function requeuePullDeadLetters(
  home: string,
  opts: { messageIds?: string[]; allDead?: boolean } = {},
): PullRequeueResult {
  if (!opts.messageIds?.length && !opts.allDead) {
    throw new Error("pull DLQ requeue requires messageIds or allDead");
  }
  if (!fs.existsSync(pullDlqPath(home))) {
    return { requeued: [], errors: [] };
  }
  const db = openPullDlq(home);
  try {
    const allRows = db
      .prepare(
        `SELECT source_domain, message_id, envelope_json
         FROM pull_failures WHERE status='dead' ORDER BY last_failed_at`,
      )
      .all() as Array<{
      source_domain: string;
      message_id: string;
      envelope_json: string;
    }>;
    const selected = new Set(opts.messageIds ?? []);
    const rows = opts.allDead
      ? allRows
      : allRows.filter((row) => selected.has(row.message_id));
    const requeued: string[] = [];
    const errors: string[] = [];
    for (const row of rows) {
      try {
        const envelope = JSON.parse(row.envelope_json) as Record<
          string,
          unknown
        >;
        importEnvelope(home, envelope, row.source_domain);
        db.prepare(
          "DELETE FROM pull_failures WHERE source_domain=? AND message_id=?",
        ).run(row.source_domain, row.message_id);
        requeued.push(row.message_id);
      } catch (error) {
        const message = safeError(
          error instanceof Error ? error.message : String(error),
        );
        db.prepare(
          `UPDATE pull_failures
           SET last_error=?, last_failed_at=?
           WHERE source_domain=? AND message_id=? AND status='dead'`,
        ).run(
          message,
          dtToIso(utcNow()),
          row.source_domain,
          row.message_id,
        );
        errors.push(`${row.source_domain} ${row.message_id}: ${message}`);
      }
    }
    return { requeued, errors };
  } finally {
    db.close();
  }
}
