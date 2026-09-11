import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  migrateStore,
  readUserVersion,
  SchemaMigrationError,
  SCHEMA_VERSION,
  writeUserVersion,
  ensureFederationOutboxColumns,
  ensureSentHistoryIndex,
} from "../src/store/migrate.js";
import {
  SCHEMA_V1_SQL,
  SCHEMA_V2_SQL,
  SCHEMA_V3_SQL,
} from "../src/store/schema.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import * as svc from "../src/services.js";

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-schema-"));
  return path.join(dir, ".agent-mail");
}

function open(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function tables(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("schema user_version migrations", () => {
  it("fresh ensureReady lands on SCHEMA_VERSION with full tables", () => {
    const home = tmpHome();
    const store = new SqliteStore(home);
    store.ensureReady();
    expect(store.lastMigrate?.fromVersion).toBe(0);
    expect(store.lastMigrate?.toVersion).toBe(SCHEMA_VERSION);
    expect(store.lastMigrate?.applied).toEqual([1, 2, 3, 4]);

    const db = open(store.dbPath);
    try {
      expect(readUserVersion(db)).toBe(4);
      const t = tables(db);
      for (const name of [
        "messages",
        "deliveries",
        "tasks",
        "approvals",
        "events",
        "outbox_events",
        "outbox_consumers",
        "federation_outbox",
        "federation_inbox_dedup",
      ]) {
        expect(t.has(name)).toBe(true);
      }
      const fedCols = cols(db, "federation_outbox");
      expect(fedCols).toContain("attempts");
      expect(fedCols).toContain("last_error");
      expect(fedCols).toContain("dead_at");
      expect(
        (db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",
          )
          .get("idx_messages_sender_ts_id") as { 1: number } | undefined),
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("idempotent re-open does not re-apply steps", () => {
    const home = tmpHome();
    const store = new SqliteStore(home);
    store.ensureReady();
    store.ensureReady();
    expect(store.lastMigrate?.fromVersion).toBe(4);
    expect(store.lastMigrate?.applied).toEqual([]);
  });

  it("upgrades v3 DB (no retry columns) to v4 and preserves rows", () => {
    const home = tmpHome();
    fs.mkdirSync(home, { recursive: true });
    const dbPath = path.join(home, "store.sqlite");
    const db = open(dbPath);
    try {
      db.exec(SCHEMA_V1_SQL);
      db.exec(SCHEMA_V2_SQL);
      db.exec(SCHEMA_V3_SQL);
      writeUserVersion(db, 3);
      db.prepare(
        `INSERT INTO messages(id, ts, from_id, to_id, type, body_md)
         VALUES ('msg_legacy1','2026-01-01T00:00:00Z','a@local','b@local','message','hi')`,
      ).run();
      db.prepare(
        `INSERT INTO federation_outbox(
           message_id, to_domain, to_agent, from_agent, envelope_json, status, created_at
         ) VALUES ('msg_legacy1','bob.lab','b@bob.lab','a@alice.lab','{}','pending','2026-01-01T00:00:00Z')`,
      ).run();
      expect(cols(db, "federation_outbox")).not.toContain("attempts");
      expect(readUserVersion(db)).toBe(3);
    } finally {
      db.close();
    }

    const store = new SqliteStore(home);
    store.ensureReady();
    expect(store.lastMigrate?.fromVersion).toBe(3);
    expect(store.lastMigrate?.applied).toEqual([4]);

    const db2 = open(dbPath);
    try {
      expect(readUserVersion(db2)).toBe(4);
      expect(cols(db2, "federation_outbox")).toContain("attempts");
      expect(cols(db2, "federation_outbox")).toContain("dead_at");
      const msg = db2
        .prepare("SELECT body_md FROM messages WHERE id=?")
        .get("msg_legacy1") as { body_md: string };
      expect(msg.body_md).toBe("hi");
      const row = db2
        .prepare("SELECT attempts, status FROM federation_outbox WHERE message_id=?")
        .get("msg_legacy1") as { attempts: number; status: string };
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
    } finally {
      db2.close();
    }
  });

  it("upgrades v1 → v4 applying steps 2,3,4", () => {
    const home = tmpHome();
    fs.mkdirSync(home, { recursive: true });
    const dbPath = path.join(home, "store.sqlite");
    const db = open(dbPath);
    try {
      db.exec(SCHEMA_V1_SQL);
      writeUserVersion(db, 1);
    } finally {
      db.close();
    }

    const store = new SqliteStore(home);
    store.ensureReady();
    expect(store.lastMigrate?.applied).toEqual([2, 3, 4]);

    const db2 = open(dbPath);
    try {
      const t = tables(db2);
      expect(t.has("outbox_events")).toBe(true);
      expect(t.has("outbox_consumers")).toBe(true);
      expect(t.has("federation_outbox")).toBe(true);
      expect(readUserVersion(db2)).toBe(4);
    } finally {
      db2.close();
    }
  });

  it("rejects DB newer than supported SCHEMA_VERSION", () => {
    const home = tmpHome();
    fs.mkdirSync(home, { recursive: true });
    const dbPath = path.join(home, "store.sqlite");
    const db = open(dbPath);
    try {
      db.exec(SCHEMA_V1_SQL);
      writeUserVersion(db, SCHEMA_VERSION + 1);
    } finally {
      db.close();
    }
    const store = new SqliteStore(home);
    expect(() => store.ensureReady()).toThrow(SchemaMigrationError);
    expect(() => store.ensureReady()).toThrow(/newer than supported/);
  });

  it("ensureFederationOutboxColumns is safe on missing table", () => {
    const db = new Database(":memory:");
    try {
      ensureFederationOutboxColumns(db);
    } finally {
      db.close();
    }
  });

  it("repairs the sender history index without changing schema version", () => {
    const db = new Database(":memory:");
    try {
      db.exec(SCHEMA_V1_SQL);
      expect(() => ensureSentHistoryIndex(db)).not.toThrow();
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",
          )
          .get("idx_messages_sender_ts_id"),
      ).toBeTruthy();
      expect(readUserVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("migrateStore direct API returns applied chain from 0", () => {
    const db = new Database(":memory:");
    try {
      const r = migrateStore(db);
      expect(r.fromVersion).toBe(0);
      expect(r.toVersion).toBe(4);
      expect(r.applied).toEqual([1, 2, 3, 4]);
      const r2 = migrateStore(db);
      expect(r2.applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("lifecycle still works after migration on real home", () => {
    const home = svc.initProject(tmpHome());
    // Force re-migrate path
    const db = open(path.join(home, "store.sqlite"));
    try {
      // leave at v4; ensureReady no-op
      expect(readUserVersion(db)).toBe(4);
    } finally {
      db.close();
    }
    const msg = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "after migrate",
      home,
    });
    expect(msg.id).toMatch(/^msg_/);
    expect(svc.inbox("codex@local", { home }).length).toBe(1);
  });
});
