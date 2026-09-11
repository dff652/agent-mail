import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { planAck, planClaim } from "../domain/claim.js";
import { planOutbound } from "../domain/outbound.js";
import {
  planTerminalMessage,
  validateDeliveryAck,
  type ApprovalStatusSnapshot,
  type ClaimSnapshot,
  type TaskSnapshot,
} from "../domain/task-lifecycle.js";
import { TaskTransitionError } from "../errors.js";
import {
  dtToIso,
  newApprovalId,
  newEventId,
  newTaskId,
  newThreadId,
  parseDt,
  utcNow,
} from "../ids.js";
import {
  createDelivery,
  createTask,
  type Delivery,
  type DeliveryStatus,
  type InboxItem,
  type Message,
  type MessageType,
  type SentHistoryItem,
  type SentHistoryStatus,
  type Task,
  type TaskStatus,
} from "../models.js";
import {
  migrateStore,
  SchemaMigrationError,
  SCHEMA_VERSION,
  type MigrateResult,
} from "./migrate.js";

type Db = Database.Database;

export class SqliteStore {
  readonly home: string;
  readonly dbPath: string;
  /** Last migrate result from ensureReady (for tests/diagnostics). */
  lastMigrate: MigrateResult | null = null;

  constructor(home: string) {
    this.home = home;
    this.dbPath = path.join(home, "store.sqlite");
  }

  private connect(): Db {
    fs.mkdirSync(this.home, { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    return db;
  }

  /**
   * Open/create store.sqlite and apply user_version migrations to SCHEMA_VERSION.
   * @see migrateStore
   */
  ensureReady(): void {
    const db = this.connect();
    try {
      try {
        this.lastMigrate = migrateStore(db, SCHEMA_VERSION);
      } catch (e) {
        if (e instanceof SchemaMigrationError) throw e;
        throw e;
      }
    } finally {
      db.close();
    }
  }

  diagnostics(): {
    integrity: string[];
    journal_mode: string;
    user_version: number;
    foreign_keys: boolean;
    counts: Record<string, number>;
    delivery_statuses: Record<string, number>;
  } {
    const db = this.connect();
    try {
      const rows = db.pragma("quick_check") as Array<Record<string, unknown>>;
      const integrity = rows.map((row) =>
        String(row.quick_check ?? Object.values(row)[0] ?? "unknown"),
      );
      const tables = [
        "messages",
        "deliveries",
        "tasks",
        "approvals",
        "events",
        "outbox_events",
      ];
      const counts = Object.fromEntries(
        tables.map((table) => {
          const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          };
          return [table, Number(row.count)];
        }),
      );
      const deliveryStatuses = Object.fromEntries(
        (
          db
            .prepare(
              "SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status ORDER BY status",
            )
            .all() as Array<{ status: string; count: number }>
        ).map((row) => [row.status, Number(row.count)]),
      );
      return {
        integrity,
        journal_mode: String(db.pragma("journal_mode", { simple: true })),
        user_version: Number(db.pragma("user_version", { simple: true })),
        foreign_keys: Number(db.pragma("foreign_keys", { simple: true })) === 1,
        counts,
        delivery_statuses: deliveryStatuses,
      };
    } finally {
      db.close();
    }
  }

  sendMessage(message: Message): {
    message: Message;
    delivery: Delivery;
    task: Task | null;
    approvalId: string | null;
  } {
    const outbound = planOutbound(message);
    message = outbound.message;
    const task = outbound.task;
    const delivery = createDelivery(message.id, message.to);
    const now = utcNow();
    let approvalId: string | null = null;

    const db = this.connect();
    try {
      const tx = db.transaction(() => {
        let terminal: { new_status: TaskStatus; expected_current: TaskStatus } | null =
          null;
        if (
          message.type === "done" ||
          message.type === "error" ||
          message.type === "cancel"
        ) {
          terminal = this.loadTerminalPlan(db, message, now);
        }

        this.insertMessage(db, message);
        this.insertDelivery(db, delivery);
        if (task) this.insertTask(db, task);

        if (task && message.requires_human_approval) {
          approvalId = newApprovalId();
          db.prepare(
            `
            INSERT INTO approvals(
              id, message_id, task_id, requested_for, status, decided_by, decided_at, note, created_at
            ) VALUES (?,?,?,?, 'pending', NULL, NULL, '', ?)
            `,
          ).run(approvalId, message.id, task.id, message.to, dtToIso(now));
          this.insertEvent(db, {
            kind: "approval.requested",
            actor: message.from_id,
            message_id: message.id,
            task_id: task.id,
            thread_id: message.thread_id,
          });
        }

        this.insertEvent(db, {
          kind: "message.sent",
          actor: message.from_id,
          message_id: message.id,
          task_id: message.task_id,
          thread_id: message.thread_id,
        });
        // Wake outbox (body-free doorbell) — same txn as delivery
        this.insertOutboxEvent(db, {
          ts: message.ts,
          kind: "message.created",
          recipient: message.to,
          message_id: message.id,
          payload: {
            thread_id: message.thread_id,
            task_id: message.task_id,
            message_type: message.type,
            effect_level: message.effect_level,
            requires_human_approval: message.requires_human_approval,
          },
        });

        if (terminal && message.task_id) {
          const r = db
            .prepare(
              "UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status=?",
            )
            .run(
              terminal.new_status,
              dtToIso(now),
              message.task_id,
              terminal.expected_current,
            );
          if (r.changes !== 1) {
            throw new TaskTransitionError("task transition race lost");
          }
          this.insertEvent(db, {
            kind: `task.${terminal.new_status}`,
            actor: message.from_id,
            message_id: message.id,
            task_id: message.task_id,
            thread_id: message.thread_id,
          });
        }
      });
      tx();
    } finally {
      db.close();
    }
    return { message, delivery, task, approvalId };
  }

  inbox(agentId: string, unreadOnly = true): InboxItem[] {
    const db = this.connect();
    try {
      const rows = db
        .prepare(
          `
          SELECT m.*, d.id AS d_id, d.message_id AS d_message_id, d.recipient,
                 d.status AS d_status, d.claim_by, d.claim_until,
                 d.created_at AS d_created, d.updated_at AS d_updated
          FROM deliveries d
          JOIN messages m ON m.id = d.message_id
          WHERE d.recipient = ?
            ${unreadOnly ? "AND d.status != 'acked'" : ""}
          ORDER BY m.ts ASC
          `,
        )
        .all(agentId) as Record<string, unknown>[];
      return rows.map((r) => ({
        message: rowToMessage(r),
        delivery: {
          id: String(r.d_id),
          message_id: String(r.d_message_id),
          recipient: String(r.recipient),
          status: r.d_status as DeliveryStatus,
          claim_by: (r.claim_by as string) ?? null,
          claim_until: parseDt(r.claim_until as string | null),
          created_at: parseDt(String(r.d_created))!,
          updated_at: parseDt(String(r.d_updated))!,
        },
      }));
    } finally {
      db.close();
    }
  }

  claim(messageId: string, agentId: string, leaseSeconds = 3600): Delivery {
    const now = utcNow();
    const db = this.connect();
    try {
      return db.transaction(() => {
        const row = db
          .prepare(
            "SELECT * FROM deliveries WHERE message_id=? AND recipient=?",
          )
          .get(messageId, agentId) as Record<string, unknown> | undefined;
        if (!row) {
          throw new Error(`no delivery for message_id=${messageId} recipient=${agentId}`);
        }
        const msg = db
          .prepare("SELECT task_id, thread_id, type FROM messages WHERE id=?")
          .get(messageId) as Record<string, unknown> | undefined;

        const plan = planClaim(
          {
            status: row.status as DeliveryStatus,
            claim_by: (row.claim_by as string) ?? null,
            claim_until: parseDt(row.claim_until as string | null),
          },
          {
            agentId,
            now,
            leaseSeconds,
            messageType: (msg?.type as MessageType) ?? null,
          },
        );

        const cur = db
          .prepare(
            `
            UPDATE deliveries
            SET status=?, claim_by=?, claim_until=?, updated_at=?
            WHERE message_id=? AND recipient=?
              AND (
                status=?
                OR (status=? AND (claim_until IS NULL OR claim_until<=?))
                OR (status=? AND claim_by=?)
              )
            `,
          )
          .run(
            "claimed",
            agentId,
            dtToIso(plan.claim_until),
            dtToIso(now),
            messageId,
            agentId,
            "pending",
            "claimed",
            dtToIso(now),
            "claimed",
            agentId,
          );
        if (cur.changes !== 1) throw new Error("claim race lost");

        if (plan.advance_task_to_in_progress && msg?.task_id) {
          db.prepare(
            "UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status IN (?,?)",
          ).run("in_progress", dtToIso(now), msg.task_id, "open", "in_progress");
        }

        this.insertEvent(db, {
          kind: "delivery.claimed",
          actor: agentId,
          message_id: messageId,
          task_id: (msg?.task_id as string) ?? null,
          thread_id: (msg?.thread_id as string) ?? null,
        });

        const out = db
          .prepare("SELECT * FROM deliveries WHERE message_id=? AND recipient=?")
          .get(messageId, agentId) as Record<string, unknown>;
        return rowToDelivery(out);
      })();
    } finally {
      db.close();
    }
  }

  ackDelivery(messageId: string, agentId: string): Delivery {
    const now = utcNow();
    const db = this.connect();
    try {
      return db.transaction(() => {
        const row = db
          .prepare(
            "SELECT * FROM deliveries WHERE message_id=? AND recipient=?",
          )
          .get(messageId, agentId) as Record<string, unknown> | undefined;
        if (!row) throw new Error("delivery not found");
        if (row.status === "acked") return rowToDelivery(row);

        planAck(
          {
            status: row.status as DeliveryStatus,
            claim_by: (row.claim_by as string) ?? null,
            claim_until: parseDt(row.claim_until as string | null),
          },
          { agentId, now },
        );

        const msg = db
          .prepare(
            `
            SELECT m.task_id, m.thread_id, m.type, t.status AS task_status
            FROM messages m
            LEFT JOIN tasks t ON t.id = m.task_id
            WHERE m.id=?
            `,
          )
          .get(messageId) as Record<string, unknown>;

        validateDeliveryAck({
          messageType: msg.type as MessageType,
          taskStatus: (msg.task_status as TaskStatus) ?? null,
        });

        db.prepare(
          `
          UPDATE deliveries SET status=?, updated_at=?
          WHERE message_id=? AND recipient=? AND claim_by=? AND status=?
          `,
        ).run("acked", dtToIso(now), messageId, agentId, agentId, "claimed");

        this.insertEvent(db, {
          kind: "delivery.acked",
          actor: agentId,
          message_id: messageId,
          task_id: (msg.task_id as string) ?? null,
          thread_id: (msg.thread_id as string) ?? null,
        });

        const out = db
          .prepare("SELECT * FROM deliveries WHERE message_id=? AND recipient=?")
          .get(messageId, agentId) as Record<string, unknown>;
        return rowToDelivery(out);
      })();
    } finally {
      db.close();
    }
  }

  /**
   * List messages sent by one sender with the durable recipient evidence that
   * is available in this Hub. The sender predicate is part of the SQL query so
   * callers cannot accidentally turn this into a project-wide history read.
   */
  listSent(
    senderId: string,
    opts: { before?: string | null; limit?: number } = {},
  ): SentHistoryItem[] {
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("sent history limit must be between 1 and 1000");
    }
    if (opts.before !== undefined && opts.before !== null) {
      if (!parseSentCursor(opts.before)) {
        throw new Error("sent history before must be an ISO timestamp");
      }
    }
    const cursor =
      opts.before !== undefined && opts.before !== null
        ? parseSentCursor(opts.before)
        : null;
    const db = this.connect();
    try {
      const rows = db
        .prepare(
          `
          SELECT m.id, m.ts, m.to_id, m.type, m.thread_id, m.task_id, m.body_md,
                 d.status AS d_status, d.claim_by AS d_claim_by,
                 d.claim_until AS d_claim_until, d.updated_at AS d_updated_at,
                 t.status AS task_status, t.updated_at AS task_updated_at,
                 f.status AS federation_status,
                 COALESCE(f.acked_at, f.last_attempt_at, f.created_at) AS f_updated_at
          FROM messages m
          LEFT JOIN deliveries d
            ON d.message_id = m.id AND d.recipient = m.to_id
          LEFT JOIN tasks t ON t.id = m.task_id AND m.type = 'task'
          LEFT JOIN federation_outbox f ON f.message_id = m.id
          WHERE m.from_id = ?
            ${cursor?.id ? "AND (m.ts < ? OR (m.ts = ? AND m.id < ?))" : cursor ? "AND m.ts < ?" : ""}
          ORDER BY m.ts DESC, m.id DESC
          LIMIT ?
          `,
        )
        .all(
          ...(cursor?.id
            ? [senderId, cursor.ts, cursor.ts, cursor.id, limit]
            : cursor
              ? [senderId, cursor.ts, limit]
              : [senderId, limit]),
        ) as Array<Record<string, unknown>>;
      return rows.map(rowToSentHistoryItem);
    } finally {
      db.close();
    }
  }

  listMessages(opts: { threadId?: string | null; limit?: number } = {}): Message[] {
    const db = this.connect();
    try {
      if (opts.threadId) {
        const rows = db
          .prepare(
            "SELECT * FROM messages WHERE thread_id=? ORDER BY ts ASC LIMIT ?",
          )
          .all(opts.threadId, opts.limit ?? 50) as Record<string, unknown>[];
        return rows.map(rowToMessage);
      }
      const rows = db
        .prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?")
        .all(opts.limit ?? 50) as Record<string, unknown>[];
      return rows.map(rowToMessage);
    } finally {
      db.close();
    }
  }

  /**
   * Outbound federated: message audit copy + federation_outbox in one txn.
   * No local delivery/task on the origin Hub (assignee Hub owns lifecycle).
   */
  enqueueFederatedMessage(
    message: Message,
    envelope: Record<string, unknown>,
  ): Message {
    let msg = { ...message };
    if (!msg.thread_id) {
      msg = { ...msg, thread_id: newThreadId() };
    }
    if (msg.type === "task" && !msg.task_id) {
      msg = { ...msg, task_id: newTaskId() };
    }
    const now = utcNow();
    const toDomain = msg.to.includes("@") ? msg.to.split("@", 2)[1]! : "";
    const wireEnvelope = {
      ...envelope,
      message_id: msg.id,
      thread_id: msg.thread_id,
      task_id: msg.task_id,
      type: msg.type,
      from: msg.from_id,
      to: msg.to,
    };

    const db = this.connect();
    try {
      db.transaction(() => {
        let terminal: { new_status: TaskStatus; expected_current: TaskStatus } | null =
          null;
        if (
          msg.type === "done" ||
          msg.type === "error" ||
          msg.type === "cancel"
        ) {
          const exists = db
            .prepare("SELECT 1 FROM tasks WHERE id=?")
            .get(msg.task_id);
          if (exists) {
            terminal = this.loadTerminalPlan(db, msg, now);
          }
        }

        this.insertMessage(db, msg);
        this.insertEvent(db, {
          kind: "message.federated_sent",
          actor: msg.from_id,
          message_id: msg.id,
          task_id: msg.task_id,
          thread_id: msg.thread_id,
        });
        if (terminal && msg.task_id) {
          const r = db
            .prepare(
              "UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status=?",
            )
            .run(
              terminal.new_status,
              dtToIso(now),
              msg.task_id,
              terminal.expected_current,
            );
          if (r.changes !== 1) {
            throw new TaskTransitionError("task transition race lost");
          }
          this.insertEvent(db, {
            kind: `task.${terminal.new_status}`,
            actor: msg.from_id,
            message_id: msg.id,
            task_id: msg.task_id,
            thread_id: msg.thread_id,
          });
        }
        db.prepare(
          `
          INSERT INTO federation_outbox(
            message_id, to_domain, to_agent, from_agent, envelope_json, status, created_at
          ) VALUES (?,?,?,?,?,'pending',?)
          `,
        ).run(
          msg.id,
          toDomain,
          msg.to,
          msg.from_id,
          JSON.stringify(wireEnvelope),
          dtToIso(now),
        );
      })();
    } finally {
      db.close();
    }
    return msg;
  }

  /**
   * Import peer envelope: message + delivery + task/approval + wake outbox
   * + audit + federation_inbox_dedup in one transaction (idempotent).
   */
  receiveFederatedMessage(
    message: Message,
    fromDomain: string,
  ): { status: "imported" | "duplicate"; message: Message } {
    const now = utcNow();
    const db = this.connect();
    try {
      return db.transaction(() => {
        const existing = db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(message.id) as Record<string, unknown> | undefined;
        const dedup = db
          .prepare("SELECT 1 FROM federation_inbox_dedup WHERE message_id=?")
          .get(message.id);

        if (existing) {
          const stored = rowToMessage(existing);
          if (
            stored.from_id !== message.from_id ||
            stored.to !== message.to ||
            stored.type !== message.type ||
            stored.body_md !== message.body_md
          ) {
            throw new TaskTransitionError(
              `federation message id collision: ${message.id}`,
            );
          }
          if (!dedup) {
            db.prepare(
              `INSERT INTO federation_inbox_dedup(message_id, from_domain, received_at)
               VALUES (?,?,?)`,
            ).run(message.id, fromDomain, dtToIso(now));
          }
          return { status: "duplicate" as const, message: stored };
        }

        if (dedup) {
          // Repair pre-txn poisoned claim: dedup without message.
          db.prepare(
            "DELETE FROM federation_inbox_dedup WHERE message_id=?",
          ).run(message.id);
        }

        let task: Task | null = null;
        let terminal: {
          new_status: TaskStatus;
          expected_current: TaskStatus;
        } | null = null;

        if (message.type === "task") {
          if (!message.task_id || !message.thread_id) {
            throw new TaskTransitionError(
              "federated task requires task_id and thread_id",
            );
          }
          task = createTask({
            id: message.task_id,
            thread_id: message.thread_id,
            origin_message_id: message.id,
            assignee: message.to,
          });
        } else if (
          message.type === "done" ||
          message.type === "error" ||
          message.type === "cancel"
        ) {
          const taskExists = db
            .prepare("SELECT 1 FROM tasks WHERE id=?")
            .get(message.task_id);
          if (taskExists) {
            terminal = this.loadTerminalPlan(db, message, now);
          }
        }

        const delivery = createDelivery(message.id, message.to);
        this.insertMessage(db, message);
        this.insertDelivery(db, delivery);
        if (task) this.insertTask(db, task);

        if (task && message.requires_human_approval) {
          db.prepare(
            `
            INSERT INTO approvals(
              id, message_id, task_id, requested_for, status, decided_by, decided_at, note, created_at
            ) VALUES (?,?,?,?, 'pending', NULL, NULL, '', ?)
            `,
          ).run(
            newApprovalId(),
            message.id,
            task.id,
            message.to,
            dtToIso(now),
          );
          this.insertEvent(db, {
            kind: "approval.requested",
            actor: message.from_id,
            message_id: message.id,
            task_id: task.id,
            thread_id: message.thread_id,
          });
        }

        this.insertEvent(db, {
          kind: "message.federated_received",
          actor: message.from_id,
          message_id: message.id,
          task_id: message.task_id,
          thread_id: message.thread_id,
        });
        this.insertOutboxEvent(db, {
          ts: message.ts,
          kind: "message.created",
          recipient: message.to,
          message_id: message.id,
          payload: {
            thread_id: message.thread_id,
            task_id: message.task_id,
            message_type: message.type,
            effect_level: message.effect_level,
            requires_human_approval: message.requires_human_approval,
            federated: true,
          },
        });

        if (terminal && message.task_id) {
          const r = db
            .prepare(
              "UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status=?",
            )
            .run(
              terminal.new_status,
              dtToIso(now),
              message.task_id,
              terminal.expected_current,
            );
          if (r.changes !== 1) {
            throw new TaskTransitionError("task transition race lost");
          }
          this.insertEvent(db, {
            kind: `task.${terminal.new_status}`,
            actor: message.from_id,
            message_id: message.id,
            task_id: message.task_id,
            thread_id: message.thread_id,
          });
        }

        db.prepare(
          `INSERT INTO federation_inbox_dedup(message_id, from_domain, received_at)
           VALUES (?,?,?)`,
        ).run(message.id, fromDomain, dtToIso(now));

        return { status: "imported" as const, message };
      })();
    } finally {
      db.close();
    }
  }

  /** @deprecated use enqueueFederatedMessage — kept for callers that only need message row */
  insertOutboundFederated(message: Message): void {
    const wire = {
      message_id: message.id,
      thread_id: message.thread_id,
      task_id: message.task_id,
      type: message.type,
      from: message.from_id,
      to: message.to,
      effect_level: message.effect_level,
      requires_human_approval: message.requires_human_approval,
      body_md: message.body_md,
      ts: message.ts.toISOString(),
      origin_domain: null,
    };
    this.enqueueFederatedMessage(message, wire);
  }

  getMessage(messageId: string): Message | null {
    const db = this.connect();
    try {
      const row = db
        .prepare("SELECT * FROM messages WHERE id=?")
        .get(messageId) as Record<string, unknown> | undefined;
      return row ? rowToMessage(row) : null;
    } finally {
      db.close();
    }
  }

  getTaskStatus(taskId: string): TaskStatus | null {
    const db = this.connect();
    try {
      const row = db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId) as
        | { status: TaskStatus }
        | undefined;
      return row?.status ?? null;
    } finally {
      db.close();
    }
  }

  listEvents(opts: {
    limit?: number;
    kind?: string | null;
    actor?: string | null;
    taskId?: string | null;
    threadId?: string | null;
  } = {}): Array<Record<string, unknown>> {
    const db = this.connect();
    try {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.kind) {
        clauses.push("kind = ?");
        params.push(opts.kind);
      }
      if (opts.actor) {
        clauses.push("actor = ?");
        params.push(opts.actor);
      }
      if (opts.taskId) {
        clauses.push("task_id = ?");
        params.push(opts.taskId);
      }
      if (opts.threadId) {
        clauses.push("thread_id = ?");
        params.push(opts.threadId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(opts.limit ?? 20);
      return db
        .prepare(
          `SELECT id, ts, kind, actor, message_id, task_id, thread_id, entity_type, entity_id, details
           FROM events ${where} ORDER BY ts DESC LIMIT ?`,
        )
        .all(...params) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  }

  listApprovals(status?: string | null): Array<Record<string, unknown>> {
    const db = this.connect();
    try {
      if (status) {
        return db
          .prepare(
            `SELECT id, message_id, task_id, requested_for, status, decided_by, decided_at, note, created_at
             FROM approvals WHERE status=? ORDER BY created_at DESC`,
          )
          .all(status) as Array<Record<string, unknown>>;
      }
      return db
        .prepare(
          `SELECT id, message_id, task_id, requested_for, status, decided_by, decided_at, note, created_at
           FROM approvals ORDER BY created_at DESC`,
        )
        .all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  }

  getApprovalForTask(taskId: string): Record<string, unknown> | null {
    const db = this.connect();
    try {
      const row = db
        .prepare(
          `SELECT id, message_id, task_id, requested_for, status, decided_by,
                  decided_at, note, created_at
           FROM approvals WHERE task_id=?`,
        )
        .get(taskId) as Record<string, unknown> | undefined;
      return row ?? null;
    } finally {
      db.close();
    }
  }

  setApproval(
    approvalId: string,
    actor: string,
    status: "approved" | "rejected",
    note = "",
  ): Record<string, unknown> {
    const db = this.connect();
    try {
      return db.transaction(() => {
        const row = db
          .prepare("SELECT * FROM approvals WHERE id=?")
          .get(approvalId) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`approval not found: ${approvalId}`);
        if (row.status !== "pending") {
          if (row.status === status) return row;
          throw new Error(`approval already decided as ${row.status}`);
        }
        const now = utcNow();
        db.prepare(
          `UPDATE approvals SET status=?, decided_by=?, decided_at=?, note=? WHERE id=? AND status=?`,
        ).run(status, actor, dtToIso(now), note, approvalId, "pending");
        const message = db
          .prepare("SELECT thread_id FROM messages WHERE id=?")
          .get(row.message_id) as Record<string, unknown> | undefined;
        this.insertEvent(db, {
          kind: `approval.${status}`,
          actor,
          message_id: String(row.message_id),
          task_id: row.task_id ? String(row.task_id) : null,
          thread_id: message?.thread_id ? String(message.thread_id) : null,
        });
        this.insertOutboxEvent(db, {
          ts: now,
          kind: `approval.${status}`,
          recipient: String(row.requested_for),
          message_id: String(row.message_id),
          payload: {
            approval_id: approvalId,
            task_id: row.task_id ? String(row.task_id) : null,
            status,
          },
        });
        const out = db
          .prepare("SELECT * FROM approvals WHERE id=?")
          .get(approvalId) as Record<string, unknown>;
        return out;
      })();
    } finally {
      db.close();
    }
  }

  private loadTerminalPlan(db: Db, message: Message, now: Date) {
    if (!message.task_id) {
      throw new TaskTransitionError(`${message.type} requires task_id and thread_id`);
    }
    const trow = db
      .prepare(
        `
        SELECT t.*, origin.from_id AS origin_from
        FROM tasks t
        JOIN messages origin ON origin.id = t.origin_message_id
        WHERE t.id=?
        `,
      )
      .get(message.task_id) as Record<string, unknown> | undefined;
    if (!trow) throw new TaskTransitionError(`task not found: ${message.task_id}`);

    const task: TaskSnapshot = {
      id: String(trow.id),
      thread_id: String(trow.thread_id),
      origin_message_id: String(trow.origin_message_id),
      origin_from: String(trow.origin_from),
      assignee: String(trow.assignee),
      status: trow.status as TaskStatus,
    };
    const drow = db
      .prepare(
        "SELECT status, claim_by, claim_until FROM deliveries WHERE message_id=? AND recipient=?",
      )
      .get(task.origin_message_id, task.assignee) as Record<string, unknown> | undefined;
    let claim: ClaimSnapshot | null = null;
    if (drow) {
      claim = {
        status: drow.status as DeliveryStatus,
        claim_by: (drow.claim_by as string) ?? null,
        claim_until: parseDt(drow.claim_until as string | null),
      };
    }
    const arow = db
      .prepare(
        "SELECT status FROM approvals WHERE task_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(message.task_id) as { status: string } | undefined;
    return planTerminalMessage(message, task, {
      originClaim: claim,
      approvalStatus: (arow?.status as ApprovalStatusSnapshot) ?? null,
      now,
    });
  }

  private insertMessage(db: Db, m: Message): void {
    db.prepare(
      `
      INSERT INTO messages(
        id, ts, from_id, to_id, type, thread_id, in_reply_to, task_id,
        body_md, doc_refs, effect_level, requires_human_approval, meta
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
    ).run(
      m.id,
      dtToIso(m.ts),
      m.from_id,
      m.to,
      m.type,
      m.thread_id,
      m.in_reply_to,
      m.task_id,
      m.body_md,
      JSON.stringify(m.doc_refs),
      m.effect_level,
      m.requires_human_approval ? 1 : 0,
      JSON.stringify(m.meta),
    );
  }

  private insertDelivery(db: Db, d: Delivery): void {
    db.prepare(
      `
      INSERT INTO deliveries(
        id, message_id, recipient, status, claim_by, claim_until, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?)
      `,
    ).run(
      d.id,
      d.message_id,
      d.recipient,
      d.status,
      d.claim_by,
      d.claim_until ? dtToIso(d.claim_until) : null,
      dtToIso(d.created_at),
      dtToIso(d.updated_at),
    );
  }

  private insertTask(db: Db, t: Task): void {
    db.prepare(
      `
      INSERT INTO tasks(
        id, thread_id, origin_message_id, assignee, status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?)
      `,
    ).run(
      t.id,
      t.thread_id,
      t.origin_message_id,
      t.assignee,
      t.status,
      dtToIso(t.created_at),
      dtToIso(t.updated_at),
    );
  }

  private insertEvent(
    db: Db,
    e: {
      kind: string;
      actor: string | null;
      message_id: string | null;
      task_id: string | null;
      thread_id: string | null;
    },
  ): void {
    db.prepare(
      `
      INSERT INTO events(
        id, ts, kind, actor, message_id, task_id, thread_id, entity_type, entity_id, details
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `,
    ).run(
      newEventId(),
      dtToIso(utcNow()),
      e.kind,
      e.actor,
      e.message_id,
      e.task_id,
      e.thread_id,
      null,
      null,
      "{}",
    );
  }

  private insertOutboxEvent(
    db: Db,
    e: {
      ts: Date;
      kind: string;
      recipient: string;
      message_id: string;
      payload: Record<string, unknown>;
    },
  ): void {
    db.prepare(
      `
      INSERT INTO outbox_events(id, ts, kind, recipient, message_id, payload)
      VALUES (?,?,?,?,?,?)
      `,
    ).run(
      newEventId(),
      dtToIso(e.ts),
      e.kind,
      e.recipient,
      e.message_id,
      JSON.stringify(e.payload),
    );
  }

  listOutboxEvents(
    recipient: string,
    afterSequence = 0,
    limit = 100,
  ): OutboxEventRow[] {
    if (afterSequence < 0) throw new Error("outbox sequence must be >= 0");
    if (limit < 1 || limit > 1000) {
      throw new Error("outbox limit must be between 1 and 1000");
    }
    this.ensureReady();
    const db = this.connect();
    try {
      const rows = db
        .prepare(
          `
          SELECT sequence, id, ts, kind, recipient, message_id, payload
          FROM outbox_events
          WHERE recipient=? AND sequence>?
          ORDER BY sequence ASC LIMIT ?
          `,
        )
        .all(recipient, afterSequence, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        sequence: Number(r.sequence),
        id: String(r.id),
        ts: String(r.ts),
        kind: String(r.kind),
        recipient: String(r.recipient),
        message_id: String(r.message_id),
        payload: JSON.parse(String(r.payload || "{}")) as Record<string, unknown>,
      }));
    } finally {
      db.close();
    }
  }

  getOutboxCursor(consumerId: string, recipient: string): number {
    validateConsumerId(consumerId);
    this.ensureReady();
    const db = this.connect();
    try {
      const row = db
        .prepare(
          "SELECT recipient, last_sequence FROM outbox_consumers WHERE consumer_id=?",
        )
        .get(consumerId) as
        | { recipient: string; last_sequence: number }
        | undefined;
      if (!row) return 0;
      if (row.recipient !== recipient) {
        throw new Error(
          `consumer ${consumerId} is already bound to ${row.recipient}`,
        );
      }
      return Number(row.last_sequence);
    } finally {
      db.close();
    }
  }

  ackOutboxCursor(
    consumerId: string,
    recipient: string,
    sequence: number,
  ): number {
    validateConsumerId(consumerId);
    if (sequence < 0) throw new Error("outbox sequence must be >= 0");
    this.ensureReady();
    const db = this.connect();
    try {
      return db.transaction(() => {
        const current = db
          .prepare(
            "SELECT recipient, last_sequence FROM outbox_consumers WHERE consumer_id=?",
          )
          .get(consumerId) as
          | { recipient: string; last_sequence: number }
          | undefined;
        if (current && current.recipient !== recipient) {
          throw new Error(
            `consumer ${consumerId} is already bound to ${current.recipient}`,
          );
        }
        if (sequence > 0) {
          const event = db
            .prepare(
              "SELECT 1 FROM outbox_events WHERE sequence=? AND recipient=?",
            )
            .get(sequence, recipient);
          if (!event) {
            throw new Error(
              `outbox event not found for recipient=${recipient} sequence=${sequence}`,
            );
          }
        }
        const now = dtToIso(utcNow());
        const prev = current ? Number(current.last_sequence) : 0;
        const next = Math.max(prev, sequence);
        db.prepare(
          `
          INSERT INTO outbox_consumers(consumer_id, recipient, last_sequence, updated_at)
          VALUES (?,?,?,?)
          ON CONFLICT(consumer_id) DO UPDATE SET
            recipient=excluded.recipient,
            last_sequence=excluded.last_sequence,
            updated_at=excluded.updated_at
          `,
        ).run(consumerId, recipient, next, now);
        return next;
      })();
    } finally {
      db.close();
    }
  }

  /**
   * Delete outbox events at or below each recipient's safe watermark.
   *
   * The watermark is per recipient: the minimum cursor across the consumers
   * bound to it. A recipient with no consumer keeps everything, because
   * `sequence` is a global AUTOINCREMENT and a global watermark would drop an
   * unattached recipient's pending wake hints as soon as some other
   * recipient's consumer advanced past them. `retainAfterSequence` lowers every
   * watermark (retains more).
   */
  purgeOutboxEvents(retainAfterSequence?: number | null): number {
    if (
      retainAfterSequence !== undefined &&
      retainAfterSequence !== null &&
      (!Number.isInteger(retainAfterSequence) || retainAfterSequence < 0)
    ) {
      throw new Error("retain_after_sequence must be >= 0");
    }
    this.ensureReady();
    const db = this.connect();
    try {
      // BEGIN IMMEDIATE: this reads a watermark and then
      // deletes on it, so a deferred read lock would have to upgrade mid-txn.
      return db.transaction(() => {
        const rows = db
          .prepare(
            `SELECT recipient, MIN(last_sequence) AS watermark
             FROM outbox_consumers GROUP BY recipient`,
          )
          .all() as Array<{ recipient: string; watermark: number | null }>;
        let deleted = 0;
        for (const row of rows) {
          let watermark = Number(row.watermark ?? 0);
          if (retainAfterSequence !== undefined && retainAfterSequence !== null) {
            watermark = Math.min(watermark, retainAfterSequence);
          }
          if (watermark <= 0) continue;
          const result = db
            .prepare(
              "DELETE FROM outbox_events WHERE recipient=? AND sequence <= ?",
            )
            .run(row.recipient, watermark);
          deleted += Number(result.changes);
        }
        return deleted;
      }).immediate();
    } finally {
      db.close();
    }
  }

  /** Backfill message.created for open deliveries missing outbox rows. */
  backfillMissingOutbox(recipient: string): number {
    this.ensureReady();
    const db = this.connect();
    try {
      return db.transaction(() => {
        const rows = db
          .prepare(
            `
            SELECT d.message_id, m.thread_id, m.task_id, m.type, m.effect_level,
                   m.requires_human_approval, m.ts
            FROM deliveries d
            JOIN messages m ON m.id = d.message_id
            WHERE d.recipient=? AND d.status IN ('pending', 'claimed')
              AND NOT EXISTS (
                SELECT 1 FROM outbox_events o WHERE o.message_id=d.message_id
              )
            ORDER BY d.message_id
            `,
          )
          .all(recipient) as Array<Record<string, unknown>>;
        let n = 0;
        for (const row of rows) {
          this.insertOutboxEvent(db, {
            ts: parseDt(String(row.ts)) ?? utcNow(),
            kind: "message.created",
            recipient,
            message_id: String(row.message_id),
            payload: {
              thread_id: row.thread_id,
              task_id: row.task_id,
              message_type: row.type,
              effect_level: row.effect_level,
              requires_human_approval: Boolean(row.requires_human_approval),
            },
          });
          n += 1;
        }
        return n;
      })();
    } finally {
      db.close();
    }
  }
}

export interface OutboxEventRow {
  sequence: number;
  id: string;
  ts: string;
  kind: string;
  recipient: string;
  message_id: string;
  payload: Record<string, unknown>;
}

function validateConsumerId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value)) {
    throw new Error(`invalid consumer id: ${value}`);
  }
  return value;
}

/**
 * Stable sent-history cursor: `<sent_at>|<message_id>`. A bare ISO timestamp
 * remains accepted for callers that only need an older time boundary, while
 * the returned cursor includes the message id so equal timestamps are not
 * skipped between pages.
 */
function parseSentCursor(value: string): { ts: string; id?: string } | null {
  const separator = value.indexOf("|");
  const rawTs = separator >= 0 ? value.slice(0, separator) : value;
  const id = separator >= 0 ? value.slice(separator + 1) : undefined;
  if (!rawTs || (separator >= 0 && !id)) return null;
  const parsed = new Date(rawTs);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    ts: dtToIso(parsed),
    ...(id ? { id } : {}),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function localDeliveryStatus(value: unknown): DeliveryStatus | null {
  return value === "pending" || value === "claimed" || value === "acked"
    ? value
    : null;
}

function taskStatus(value: unknown): TaskStatus | null {
  return value === "open" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : null;
}

function federationStatus(
  value: unknown,
): "pending" | "acked" | "dead" | null {
  return value === "pending" || value === "acked" || value === "dead"
    ? value
    : null;
}

function deriveSentHistoryStatus(
  delivery: DeliveryStatus | null,
  task: TaskStatus | null,
  federation: "pending" | "acked" | "dead" | null,
): { status: SentHistoryStatus; basis: "delivery" | "task" | "federation" | "unknown" } {
  if (task === "failed") return { status: "failed", basis: "task" };
  if (task === "completed") return { status: "completed", basis: "task" };
  if (task === "in_progress") return { status: "processing", basis: "task" };
  if (task === "cancelled") return { status: "unknown", basis: "task" };
  if (delivery === "acked") return { status: "completed", basis: "delivery" };
  if (delivery === "claimed") return { status: "claimed", basis: "delivery" };
  if (delivery === "pending") return { status: "submitted", basis: "delivery" };
  if (federation === "dead") return { status: "failed", basis: "federation" };
  if (federation === "pending" || federation === "acked") {
    // Federation ack is Hub-to-Hub transport evidence, not recipient task
    // completion. Keep the sender status at submitted until local evidence
    // says otherwise.
    return { status: "submitted", basis: "federation" };
  }
  return { status: "unknown", basis: "unknown" };
}

function rowToSentHistoryItem(r: Record<string, unknown>): SentHistoryItem {
  const delivery = localDeliveryStatus(r.d_status);
  const task = taskStatus(r.task_status);
  const federation = federationStatus(r.federation_status);
  const derived = deriveSentHistoryStatus(delivery, task, federation);
  const deliveryUpdated = nullableString(r.d_updated_at);
  const taskUpdated = nullableString(r.task_updated_at);
  const federationUpdated = nullableString(r.f_updated_at);
  const updatedAt =
    derived.basis === "delivery"
      ? deliveryUpdated
      : derived.basis === "task"
        ? taskUpdated
        : derived.basis === "federation"
          ? federationUpdated
          : null;
  return {
    message_id: String(r.id),
    sent_at: String(r.ts),
    to: String(r.to_id),
    type: r.type as MessageType,
    thread_id: nullableString(r.thread_id),
    task_id: nullableString(r.task_id),
    body_md: String(r.body_md ?? ""),
    status: derived.status,
    delivery_status: delivery,
    task_status: task,
    federation_status: federation,
    status_evidence: {
      basis: derived.basis,
      delivery_status: delivery,
      task_status: task,
      federation_status: federation,
      updated_at: updatedAt,
    },
    claim_by: nullableString(r.d_claim_by),
    claim_until: nullableString(r.d_claim_until),
    delivery_updated_at: deliveryUpdated,
    task_updated_at: taskUpdated,
    federation_updated_at: federationUpdated,
  };
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: String(r.id),
    ts: parseDt(String(r.ts))!,
    from_id: String(r.from_id),
    to: String(r.to_id),
    type: r.type as MessageType,
    thread_id: (r.thread_id as string) ?? null,
    in_reply_to: (r.in_reply_to as string) ?? null,
    task_id: (r.task_id as string) ?? null,
    body_md: String(r.body_md ?? ""),
    doc_refs: JSON.parse(String(r.doc_refs || "[]")),
    effect_level: (r.effect_level as Message["effect_level"]) || "none",
    requires_human_approval: Boolean(r.requires_human_approval),
    meta: JSON.parse(String(r.meta || "{}")),
  };
}

function rowToDelivery(r: Record<string, unknown>): Delivery {
  return {
    id: String(r.id),
    message_id: String(r.message_id),
    recipient: String(r.recipient),
    status: r.status as DeliveryStatus,
    claim_by: (r.claim_by as string) ?? null,
    claim_until: parseDt(r.claim_until as string | null),
    created_at: parseDt(String(r.created_at))!,
    updated_at: parseDt(String(r.updated_at))!,
  };
}
