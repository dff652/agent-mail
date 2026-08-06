/**
 * SQLite schema for the Agent Mail store.
 *
 * Version history (additive only for 1–4; destructive steps must be explicit later):
 *   0 → empty / legacy without user_version
 *   1 → core lifecycle tables (messages, deliveries, tasks, approvals, events)
 *   2 → hub wake outbox (outbox_events, outbox_consumers)
 *   3 → federation outbox + inbox dedup (minimal columns)
 *   4 → federation retry/DLQ columns + remaining indexes
 */
export const SCHEMA_VERSION = 4;

/** Full DDL for a fresh database at SCHEMA_VERSION (idempotent CREATE IF NOT EXISTS). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT,
  in_reply_to TEXT,
  task_id TEXT,
  body_md TEXT NOT NULL DEFAULT '',
  doc_refs TEXT NOT NULL DEFAULT '[]',
  effect_level TEXT NOT NULL DEFAULT 'none',
  requires_human_approval INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL,
  claim_by TEXT,
  claim_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(message_id, recipient)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL,
  assignee TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  task_id TEXT,
  requested_for TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  message_id TEXT,
  task_id TEXT,
  thread_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS outbox_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS outbox_consumers (
  consumer_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS federation_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  to_domain TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  acked_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  dead_at TEXT
);
CREATE TABLE IF NOT EXISTS federation_inbox_dedup (
  message_id TEXT PRIMARY KEY,
  from_domain TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status
  ON deliveries(recipient, status);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_task_ts ON events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_thread_ts ON events(thread_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_actor_ts ON events(actor, ts);
CREATE INDEX IF NOT EXISTS idx_outbox_recipient_sequence
  ON outbox_events(recipient, sequence);
CREATE INDEX IF NOT EXISTS idx_outbox_message ON outbox_events(message_id);
CREATE INDEX IF NOT EXISTS idx_fed_outbox_domain_status_seq
  ON federation_outbox(to_domain, status, seq);
CREATE INDEX IF NOT EXISTS idx_fed_outbox_status_created
  ON federation_outbox(status, created_at);
`;

/** Core tables only (schema v1). */
export const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT,
  in_reply_to TEXT,
  task_id TEXT,
  body_md TEXT NOT NULL DEFAULT '',
  doc_refs TEXT NOT NULL DEFAULT '[]',
  effect_level TEXT NOT NULL DEFAULT 'none',
  requires_human_approval INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL,
  claim_by TEXT,
  claim_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(message_id, recipient)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  origin_message_id TEXT NOT NULL,
  assignee TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  task_id TEXT,
  requested_for TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  message_id TEXT,
  task_id TEXT,
  thread_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status
  ON deliveries(recipient, status);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

/** Wake outbox tables (schema v2). */
export const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS outbox_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS outbox_consumers (
  consumer_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_recipient_sequence
  ON outbox_events(recipient, sequence);
CREATE INDEX IF NOT EXISTS idx_outbox_message ON outbox_events(message_id);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_task_ts ON events(task_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_thread_ts ON events(thread_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_actor_ts ON events(actor, ts);
`;

/**
 * Federation tables at v3 (before retry/DLQ columns).
 * attempts/last_error/... are added in v4 via ALTER.
 */
export const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS federation_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  to_domain TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  acked_at TEXT
);
CREATE TABLE IF NOT EXISTS federation_inbox_dedup (
  message_id TEXT PRIMARY KEY,
  from_domain TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fed_outbox_domain_status_seq
  ON federation_outbox(to_domain, status, seq);
`;
