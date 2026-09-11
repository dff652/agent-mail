import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { apiSent } from "../src/hub/mail-api.js";
import * as svc from "../src/services.js";
import { migrateStore } from "../src/store/migrate.js";

it("paginates equal timestamps without gaps and distinguishes failed task from error delivery", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-receipt-boundary-"));
  const home = svc.initProject(path.join(dir, "mail"));
  try {
    const messages = Array.from({ length: 3 }, (_, index) => svc.send({
      home, from_id: "claude-code@local", to: "codex@local",
      type: "task", body: `boundary ${index}`, effect: "read",
    }));
    const db = new Database(path.join(home, "store.sqlite"));
    try {
      db.prepare("UPDATE messages SET ts=?").run("2026-01-01T00:00:00Z");
    } finally { db.close(); }
    const seen: string[] = [];
    let before: string | null = null;
    for (let index = 0; index < 4; index += 1) {
      const page = apiSent(home, "claude-code@local", { limit: 1, before });
      const items = page.items as Array<{ message_id: string }>;
      seen.push(...items.map((item) => item.message_id));
      before = page.next_before as string | null;
      if (!before) break;
    }
    expect(seen).toEqual(messages.map((message) => message.id).sort().reverse());
    const task = messages[0]!;
    svc.claim(task.id, "codex@local", { home });
    const error = svc.send({
      home, from_id: "codex@local", to: "claude-code@local",
      type: "error", body: "cannot complete", task_id: task.task_id,
      thread_id: task.thread_id,
    });
    expect(svc.sent("claude-code@local", { home }).find((item) => item.message_id === task.id))
      .toMatchObject({ status: "failed", task_status: "failed" });
    expect(svc.sent("codex@local", { home }).find((item) => item.message_id === error.id))
      .toMatchObject({ status: "submitted", delivery_status: "pending", task_status: null });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("opening a current sender-index database does not request a schema write lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-receipt-lock-"));
  const home = svc.initProject(path.join(dir, "mail"));
  const writer = new Database(path.join(home, "store.sqlite"));
  const reader = new Database(path.join(home, "store.sqlite"), { timeout: 10 });
  try {
    writer.exec("BEGIN IMMEDIATE");
    expect(() => migrateStore(reader)).not.toThrow();
  } finally {
    writer.exec("ROLLBACK");
    reader.close();
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
