import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildEnvelopeFromMessage,
  importEnvelope,
} from "../src/federation/envelope.js";
import { setLocalDomain, addPeer } from "../src/federation/peers.js";
import { createMessage } from "../src/models.js";
import * as svc from "../src/services.js";
import { SqliteStore } from "../src/store/sqlite-store.js";

function addAgent(home: string, id: string) {
  const p = path.join(home, "agents.json");
  const roster = JSON.parse(fs.readFileSync(p, "utf8")) as {
    agents: Array<{ id: string; display_name: string; skills: string[] }>;
  };
  if (!roster.agents.some((a) => a.id === id)) {
    roster.agents.push({
      id,
      display_name: id.split("@", 1)[0] || id,
      skills: ["lab"],
    });
    fs.writeFileSync(p, JSON.stringify(roster, null, 2));
  }
}

function countRows(home: string, table: string): number {
  const db = new Database(path.join(home, "store.sqlite"));
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    return Number(row.n);
  } finally {
    db.close();
  }
}

describe("Federation import/export transactions", () => {
  it("enqueueForeign writes message + outbox in one store", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-txn-"));
    const home = svc.initProject(path.join(tmp, ".agent-mail"));
    setLocalDomain(home, "alice.lab");
    addAgent(home, "claude@alice.lab");
    addPeer(home, {
      domain: "bob.lab",
      base_url: "http://127.0.0.1:9",
      push_enabled: true,
    });

    const msg = svc.send({
      from_id: "claude@alice.lab",
      to: "codex@bob.lab",
      type: "task",
      body: "atomic enqueue",
      home,
    });

    expect(msg.task_id).toMatch(/^tsk_/);
    expect(countRows(home, "messages")).toBe(1);
    expect(countRows(home, "federation_outbox")).toBe(1);
    expect(countRows(home, "deliveries")).toBe(0); // origin keeps no local delivery
    expect(countRows(home, "tasks")).toBe(0); // task lifecycle on assignee hub
    // outbox envelope preserves task/thread ids
    const db = new Database(path.join(home, "store.sqlite"));
    try {
      const row = db
        .prepare("SELECT envelope_json FROM federation_outbox WHERE message_id=?")
        .get(msg.id) as { envelope_json: string };
      const env = JSON.parse(row.envelope_json) as Record<string, unknown>;
      expect(env.task_id).toBe(msg.task_id);
      expect(env.thread_id).toBe(msg.thread_id);
    } finally {
      db.close();
    }
  });

  it("import is atomic: message + delivery + task + dedup + wake outbox", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-imp-"));
    const home = svc.initProject(path.join(tmp, ".agent-mail"));
    setLocalDomain(home, "bob.lab");
    addAgent(home, "codex@bob.lab");

    const src = createMessage({
      id: "msg_fedtxn001abc",
      from_id: "claude@alice.lab",
      to: "codex@bob.lab",
      type: "task",
      body_md: "please review",
      thread_id: "thr_fedtxn001",
      task_id: "tsk_fedtxn001",
      effect_level: "read",
    });
    const envelope = buildEnvelopeFromMessage(src, "alice.lab");

    const status = importEnvelope(
      home,
      envelope as unknown as Record<string, unknown>,
      "alice.lab",
    );
    expect(status).toBe("imported");
    expect(countRows(home, "messages")).toBe(1);
    expect(countRows(home, "deliveries")).toBe(1);
    expect(countRows(home, "tasks")).toBe(1);
    expect(countRows(home, "federation_inbox_dedup")).toBe(1);
    expect(countRows(home, "outbox_events")).toBe(1);
    expect(svc.getStore(home).getTaskStatus("tsk_fedtxn001")).toBe("open");
  });

  it("re-import is idempotent duplicate and does not double-write", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-dup-"));
    const home = svc.initProject(path.join(tmp, ".agent-mail"));
    setLocalDomain(home, "bob.lab");
    addAgent(home, "codex@bob.lab");

    const env = {
      message_id: "msg_feddup001xyz",
      thread_id: "thr_dup1",
      task_id: "tsk_dup1",
      type: "task",
      from: "claude@alice.lab",
      to: "codex@bob.lab",
      effect_level: "none",
      requires_human_approval: false,
      body_md: "once",
      ts: new Date().toISOString(),
      origin_domain: "alice.lab",
    };
    expect(importEnvelope(home, env, "alice.lab")).toBe("imported");
    expect(importEnvelope(home, env, "alice.lab")).toBe("duplicate");
    expect(countRows(home, "messages")).toBe(1);
    expect(countRows(home, "deliveries")).toBe(1);
    expect(countRows(home, "federation_inbox_dedup")).toBe(1);
  });

  it("repairs poisoned dedup (dedup without message) then imports", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-poison-"));
    const home = svc.initProject(path.join(tmp, ".agent-mail"));
    setLocalDomain(home, "bob.lab");
    addAgent(home, "codex@bob.lab");
    new SqliteStore(home).ensureReady();

    const mid = "msg_poison001abc";
    const db = new Database(path.join(home, "store.sqlite"));
    try {
      db.prepare(
        `INSERT INTO federation_inbox_dedup(message_id, from_domain, received_at)
         VALUES (?,?,?)`,
      ).run(mid, "alice.lab", new Date().toISOString());
    } finally {
      db.close();
    }

    const env = {
      message_id: mid,
      thread_id: "thr_p1",
      task_id: "tsk_p1",
      type: "task",
      from: "claude@alice.lab",
      to: "codex@bob.lab",
      effect_level: "none",
      requires_human_approval: false,
      body_md: "recovered",
      ts: new Date().toISOString(),
      origin_domain: "alice.lab",
    };
    expect(importEnvelope(home, env, "alice.lab")).toBe("imported");
    expect(countRows(home, "messages")).toBe(1);
    expect(svc.inbox("codex@bob.lab", { home })[0].message.body_md).toBe(
      "recovered",
    );
  });

  it("rejects domain mismatch and foreign from domain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-dom-"));
    const home = svc.initProject(path.join(tmp, ".agent-mail"));
    setLocalDomain(home, "bob.lab");
    addAgent(home, "codex@bob.lab");

    const base = {
      message_id: "msg_domcheck001",
      thread_id: null as string | null,
      task_id: null as string | null,
      type: "message",
      from: "claude@alice.lab",
      to: "codex@bob.lab",
      effect_level: "none",
      requires_human_approval: false,
      body_md: "x",
      ts: null as string | null,
      origin_domain: "alice.lab",
    };
    expect(() =>
      importEnvelope(home, { ...base, to: "codex@other.lab" }, "alice.lab"),
    ).toThrow(/domain_mismatch/);
    expect(() =>
      importEnvelope(
        home,
        { ...base, message_id: "msg_domcheck002", from: "claude@evil.lab" },
        "alice.lab",
      ),
    ).toThrow(/from domain/);
  });

  it("rejects id collision with different payload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-col-"));
    const home = svc.initProject(path.join(tmp, ".agent-mail"));
    setLocalDomain(home, "bob.lab");
    addAgent(home, "codex@bob.lab");

    const env = {
      message_id: "msg_col001aabbcc",
      thread_id: null as string | null,
      task_id: null as string | null,
      type: "message",
      from: "claude@alice.lab",
      to: "codex@bob.lab",
      effect_level: "none",
      requires_human_approval: false,
      body_md: "original",
      ts: null as string | null,
      origin_domain: "alice.lab",
    };
    expect(importEnvelope(home, env, "alice.lab")).toBe("imported");
    expect(() =>
      importEnvelope(home, { ...env, body_md: "tampered" }, "alice.lab"),
    ).toThrow(/collision|import failed/);
  });
});
