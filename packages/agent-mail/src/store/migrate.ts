/**
 * Explicit SQLite user_version migration runner.
 *
 * Contract:
 * - Never open a DB with user_version > SCHEMA_VERSION (require newer binary).
 * - Upgrade only by applying ordered steps current+1 … SCHEMA_VERSION.
 * - Steps 1–4 are additive (CREATE IF NOT EXISTS / ADD COLUMN).
 * - Future destructive migrations must be real steps here, not silent DDL jumps.
 */
import type Database from "better-sqlite3";

import {
  SCHEMA_SQL,
  SCHEMA_V1_SQL,
  SCHEMA_V2_SQL,
  SCHEMA_V3_SQL,
  SCHEMA_VERSION,
} from "./schema.js";

export type Db = Database.Database;

export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMigrationError";
  }
}

export interface MigrationStep {
  /** Target user_version after this step. */
  toVersion: number;
  description: string;
  up: (db: Db) => void;
}

function tableColumns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function indexExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
    .get(name);
  return row !== undefined;
}

/**
 * Additive v4 federation_outbox retry/DLQ columns.
 *
 * Reads first and only writes when something is genuinely missing: this runs on
 * every store open as a repair path for legacy DBs stamped v4 without the
 * ALTERs, and an unconditional `CREATE INDEX IF NOT EXISTS` took a write lock
 * on every open of an already-current database (evaluation P2-1).
 */
export function ensureFederationOutboxColumns(db: Db): void {
  const existing = tableColumns(db, "federation_outbox");
  if (existing.size === 0) return;
  const alters: Array<[string, string]> = [
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["last_error", "TEXT NOT NULL DEFAULT ''"],
    ["last_attempt_at", "TEXT"],
    ["next_attempt_at", "TEXT"],
    ["dead_at", "TEXT"],
  ];
  for (const [name, decl] of alters) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE federation_outbox ADD COLUMN ${name} ${decl}`);
    }
  }
  if (!indexExists(db, "idx_fed_outbox_status_created")) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_fed_outbox_status_created
         ON federation_outbox(status, created_at)`,
    );
  }
}

/**
 * Ordered migration steps. Each step is applied inside ensureReady when
 * current user_version < step.toVersion.
 */
export const MIGRATIONS: MigrationStep[] = [
  {
    toVersion: 1,
    description: "core lifecycle tables",
    up: (db) => {
      db.exec(SCHEMA_V1_SQL);
    },
  },
  {
    toVersion: 2,
    description: "hub wake outbox_events + outbox_consumers",
    up: (db) => {
      db.exec(SCHEMA_V2_SQL);
    },
  },
  {
    toVersion: 3,
    description: "federation outbox + inbox dedup",
    up: (db) => {
      db.exec(SCHEMA_V3_SQL);
    },
  },
  {
    toVersion: 4,
    description: "federation retry/DLQ columns + full index set",
    up: (db) => {
      // Re-apply full idempotent DDL so fresh paths and partial upgrades converge.
      db.exec(SCHEMA_SQL);
      ensureFederationOutboxColumns(db);
    },
  },
];

export function readUserVersion(db: Db): number {
  return Number(db.pragma("user_version", { simple: true }));
}

export function writeUserVersion(db: Db, version: number): void {
  db.pragma(`user_version = ${version}`);
}

export interface MigrateResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

/**
 * Upgrade db to SCHEMA_VERSION. Safe to call repeatedly.
 * Throws SchemaMigrationError if DB is newer than this binary supports.
 */
export function migrateStore(db: Db, target = SCHEMA_VERSION): MigrateResult {
  const fromVersion = readUserVersion(db);
  if (fromVersion > target) {
    throw new SchemaMigrationError(
      `database schema ${fromVersion} is newer than supported ${target}`,
    );
  }
  if (fromVersion === target) {
    // Still ensure additive columns (legacy DBs marked v4 without all ALTERs).
    if (target >= 4) {
      ensureFederationOutboxColumns(db);
    }
    return { fromVersion, toVersion: target, applied: [] };
  }

  const applied: number[] = [];
  const steps = MIGRATIONS.filter(
    (m) => m.toVersion > fromVersion && m.toVersion <= target,
  ).sort((a, b) => a.toVersion - b.toVersion);

  // Validate steps form a contiguous chain from fromVersion+1.
  let expected = fromVersion + 1;
  for (const step of steps) {
    if (step.toVersion !== expected) {
      throw new SchemaMigrationError(
        `missing migration step for user_version ${expected} (next is ${step.toVersion})`,
      );
    }
    expected += 1;
  }
  if (steps.length === 0 || steps[steps.length - 1]!.toVersion !== target) {
    throw new SchemaMigrationError(
      `no migration path from user_version ${fromVersion} to ${target}`,
    );
  }

  const run = db.transaction(() => {
    for (const step of steps) {
      step.up(db);
      writeUserVersion(db, step.toVersion);
      applied.push(step.toVersion);
    }
  });
  run();

  return { fromVersion, toVersion: target, applied };
}

export { SCHEMA_VERSION };
