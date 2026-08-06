import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { dtToIso, utcNow } from "../ids.js";
import { SqliteStore } from "../store/sqlite-store.js";

export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_LAG_ALERT_SEC = 300;
export const MAX_BACKOFF_SEC = 300;
export const ERROR_SNIPPET = 240;
export const STATUS_PENDING = "pending";
export const STATUS_ACKED = "acked";
export const STATUS_DEAD = "dead";

function openDb(home: string) {
  new SqliteStore(home).ensureReady();
  const dbPath = path.join(home, "store.sqlite");
  fs.mkdirSync(home, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

function backoffSeconds(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(MAX_BACKOFF_SEC, 2 ** attempts);
}

export interface PendingItem {
  seq: number;
  message_id: string;
  to_domain: string;
  to_agent: string;
  from_agent: string;
  envelope: Record<string, unknown>;
  status: string;
  attempts: number;
}

export interface DeadLetterItem {
  seq: number;
  message_id: string;
  to_domain: string;
  to_agent: string;
  from_agent: string;
  attempts: number;
  last_error: string;
  created_at: string;
  dead_at: string;
}

export function enqueueOutbound(
  home: string,
  opts: {
    message_id: string;
    to_domain: string;
    to_agent: string;
    from_agent: string;
    envelope: Record<string, unknown>;
  },
): void {
  const db = openDb(home);
  try {
    db.prepare(
      `
      INSERT OR IGNORE INTO federation_outbox(
        message_id, to_domain, to_agent, from_agent, envelope_json, status, created_at
      ) VALUES (?,?,?,?,?,'pending',?)
      `,
    ).run(
      opts.message_id,
      opts.to_domain,
      opts.to_agent,
      opts.from_agent,
      JSON.stringify(opts.envelope),
      dtToIso(utcNow()),
    );
  } finally {
    db.close();
  }
}

/** Pending rows ready now (respect next_attempt_at backoff). */
export function listPendingForPeer(
  home: string,
  domain: string,
  limit = 50,
  afterSeq = 0,
): PendingItem[] {
  const db = openDb(home);
  try {
    const now = dtToIso(utcNow());
    const rows = db
      .prepare(
        `
        SELECT seq, message_id, to_domain, to_agent, from_agent, envelope_json, status, attempts
        FROM federation_outbox
        WHERE to_domain=? AND status='pending' AND seq > ?
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY seq ASC LIMIT ?
        `,
      )
      .all(domain, afterSeq, now, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      message_id: String(r.message_id),
      to_domain: String(r.to_domain),
      to_agent: String(r.to_agent),
      from_agent: String(r.from_agent),
      envelope: JSON.parse(String(r.envelope_json)) as Record<string, unknown>,
      status: String(r.status),
      attempts: Number(r.attempts || 0),
    }));
  } finally {
    db.close();
  }
}

export function ackOutbound(
  home: string,
  messageIds: string[],
  peerDomain: string,
): string[] {
  if (!messageIds.length) return [];
  const db = openDb(home);
  try {
    const now = dtToIso(utcNow());
    const stmt = db.prepare(
      `UPDATE federation_outbox SET status='acked', acked_at=?, last_error='', next_attempt_at=NULL
       WHERE message_id=? AND to_domain=? AND status='pending'`,
    );
    const acked: string[] = [];
    const tx = db.transaction(() => {
      for (const id of messageIds) {
        if (stmt.run(now, id, peerDomain).changes > 0) acked.push(id);
      }
    });
    tx();
    return acked;
  } finally {
    db.close();
  }
}

/** Increment attempts; may dead-letter. Returns new status. */
export function recordPushFailure(
  home: string,
  messageId: string,
  peerDomain: string,
  error: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): string {
  const maxAtt = Math.max(1, maxAttempts);
  const snippet = (error || "push failed").replace(/\n/g, " ").trim().slice(0, ERROR_SNIPPET);
  const now = utcNow();
  const nowIso = dtToIso(now);
  const db = openDb(home);
  try {
    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT attempts, status FROM federation_outbox
           WHERE message_id=? AND to_domain=?`,
        )
        .get(messageId, peerDomain) as
        | { attempts: number; status: string }
        | undefined;
      if (!row) return "missing";
      if (row.status !== STATUS_PENDING) return String(row.status);
      const attempts = Number(row.attempts || 0) + 1;
      if (attempts >= maxAtt) {
        db.prepare(
          `
          UPDATE federation_outbox
          SET status='dead', attempts=?, last_error=?, last_attempt_at=?,
              dead_at=?, next_attempt_at=NULL
          WHERE message_id=? AND to_domain=? AND status='pending'
          `,
        ).run(attempts, snippet, nowIso, nowIso, messageId, peerDomain);
        return STATUS_DEAD;
      }
      const nextAt = new Date(now.getTime() + backoffSeconds(attempts) * 1000);
      db.prepare(
        `
        UPDATE federation_outbox
        SET attempts=?, last_error=?, last_attempt_at=?, next_attempt_at=?
        WHERE message_id=? AND to_domain=? AND status='pending'
        `,
      ).run(attempts, snippet, nowIso, dtToIso(nextAt), messageId, peerDomain);
      return STATUS_PENDING;
    })();
  } finally {
    db.close();
  }
}

export function listDeadLetters(
  home: string,
  opts: { toDomain?: string; limit?: number } = {},
): DeadLetterItem[] {
  const limit = opts.limit ?? 100;
  const db = openDb(home);
  try {
    const rows = (
      opts.toDomain
        ? db
            .prepare(
              `
              SELECT seq, message_id, to_domain, to_agent, from_agent, attempts,
                     last_error, created_at, dead_at
              FROM federation_outbox
              WHERE status='dead' AND to_domain=?
              ORDER BY seq ASC LIMIT ?
              `,
            )
            .all(opts.toDomain, limit)
        : db
            .prepare(
              `
              SELECT seq, message_id, to_domain, to_agent, from_agent, attempts,
                     last_error, created_at, dead_at
              FROM federation_outbox
              WHERE status='dead'
              ORDER BY seq ASC LIMIT ?
              `,
            )
            .all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      message_id: String(r.message_id),
      to_domain: String(r.to_domain),
      to_agent: String(r.to_agent),
      from_agent: String(r.from_agent),
      attempts: Number(r.attempts || 0),
      last_error: String(r.last_error || ""),
      created_at: String(r.created_at || ""),
      dead_at: String(r.dead_at || ""),
    }));
  } finally {
    db.close();
  }
}

export function requeueDead(
  home: string,
  opts: { messageIds?: string[]; allDead?: boolean; toDomain?: string } = {},
): string[] {
  if (!opts.messageIds?.length && !opts.allDead) {
    throw new Error("requeue requires messageIds or allDead");
  }
  const db = openDb(home);
  try {
    return db.transaction(() => {
      let ids = opts.messageIds ? [...opts.messageIds] : [];
      if (opts.allDead) {
        const rows = (
          opts.toDomain
            ? db
                .prepare(
                  `SELECT message_id FROM federation_outbox WHERE status='dead' AND to_domain=?`,
                )
                .all(opts.toDomain)
            : db
                .prepare(`SELECT message_id FROM federation_outbox WHERE status='dead'`)
                .all()
        ) as Array<{ message_id: string }>;
        ids = rows.map((r) => r.message_id);
      }
      const requeued: string[] = [];
      const stmt = opts.toDomain
        ? db.prepare(
            `
            UPDATE federation_outbox
            SET status='pending', attempts=0, last_error='',
                last_attempt_at=NULL, next_attempt_at=NULL, dead_at=NULL
            WHERE message_id=? AND to_domain=? AND status='dead'
            `,
          )
        : db.prepare(
            `
            UPDATE federation_outbox
            SET status='pending', attempts=0, last_error='',
                last_attempt_at=NULL, next_attempt_at=NULL, dead_at=NULL
            WHERE message_id=? AND status='dead'
            `,
          );
      for (const mid of ids) {
        const r = opts.toDomain
          ? stmt.run(mid, opts.toDomain)
          : stmt.run(mid);
        if (r.changes === 1) requeued.push(mid);
      }
      return requeued;
    })();
  } finally {
    db.close();
  }
}

export function alreadyImported(home: string, messageId: string): boolean {
  const db = openDb(home);
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM federation_inbox_dedup WHERE message_id=?").get(messageId),
    );
  } finally {
    db.close();
  }
}

export function markImported(home: string, messageId: string, fromDomain: string): void {
  const db = openDb(home);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO federation_inbox_dedup(message_id, from_domain, received_at) VALUES (?,?,?)`,
    ).run(messageId, fromDomain, dtToIso(utcNow()));
  } finally {
    db.close();
  }
}

export function outboxCounts(home: string): Record<string, unknown> {
  const db = openDb(home);
  try {
    const rows = db
      .prepare(`SELECT status, COUNT(*) AS n FROM federation_outbox GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = Number(r.n);

    const oldest = db
      .prepare(
        `SELECT MIN(created_at) AS oldest FROM federation_outbox WHERE status='pending'`,
      )
      .get() as { oldest: string | null };
    let oldest_pending_age_sec: number | null = null;
    if (oldest?.oldest) {
      const t = new Date(oldest.oldest).getTime();
      if (!Number.isNaN(t)) {
        oldest_pending_age_sec = Math.max(0, (Date.now() - t) / 1000);
      }
    }
    return {
      ...byStatus,
      pending: byStatus.pending || 0,
      acked: byStatus.acked || 0,
      dead: byStatus.dead || 0,
      oldest_pending_age_sec,
    };
  } finally {
    db.close();
  }
}
