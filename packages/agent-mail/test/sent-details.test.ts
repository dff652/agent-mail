import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mintToken } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import { RemoteMailClient } from "../src/remote-client.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import * as svc from "../src/services.js";

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function jsonFetch(
  base: string,
  p: string,
  opts: { token?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const response = await fetch(`${base}${p}`, { headers });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function closeHub(server: { close: (callback: (error?: Error) => void) => void }) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("durable sender history and safe agent details", () => {
  it("keeps sender history scoped and status evidence durable across store reopen", () => {
    const dir = temporaryDirectory("am-sent-local-");
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    const task = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "durable task",
      home,
      effect: "read",
    });
    const note = svc.send({
      from_id: "claude-code@local",
      to: "grok@local",
      type: "message",
      body: "second sent item",
      home,
    });

    let page = svc.sent("claude-code@local", { home });
    expect(page.map((item) => item.message_id)).toEqual(
      expect.arrayContaining([task.id, note.id]),
    );
    const taskItem = page.find((item) => item.message_id === task.id)!;
    expect(taskItem).toMatchObject({
      status: "submitted",
      delivery_status: "pending",
      task_status: "open",
      status_evidence: {
        basis: "delivery",
        delivery_status: "pending",
        task_status: "open",
      },
    });

    const first = svc.sent("claude-code@local", { home, limit: 1 });
    const firstApi = {
      ...first,
      next_before:
        first.length === 1
          ? `${first[0]!.sent_at}|${first[0]!.message_id}`
          : null,
    };
    expect(firstApi.next_before).toBeTruthy();
    const older = svc.sent("claude-code@local", {
      home,
      limit: 10,
      before: firstApi.next_before,
    });
    expect(older.some((item) => item.message_id !== first[0]!.message_id)).toBe(true);

    expect(svc.claim(task.id, "codex@local", { home }).status).toBe("claimed");
    page = svc.sent("claude-code@local", { home });
    expect(page.find((item) => item.message_id === task.id)).toMatchObject({
      status: "processing",
      delivery_status: "claimed",
      task_status: "in_progress",
      status_evidence: { basis: "task", task_status: "in_progress" },
    });

    // Reopen the SQLite store to prove the UI read is based on durable rows.
    new SqliteStore(home).ensureReady();
    expect(svc.sent("claude-code@local", { home })).toEqual(page);

    const done = svc.send({
      from_id: "codex@local",
      to: "claude-code@local",
      type: "done",
      body: "finished",
      home,
      thread_id: task.thread_id,
      task_id: task.task_id,
    });
    expect(done.task_id).toBe(task.task_id);
    expect(svc.sent("codex@local", { home })).toMatchObject([
      expect.objectContaining({
        message_id: done.id,
        // A done message has its own delivery; it must not inherit the
        // completed task state before its recipient claims it.
        status: "submitted",
        delivery_status: "pending",
        task_status: null,
      }),
    ]);
    expect(svc.ack(task.id, "codex@local", { home }).status).toBe("acked");
    expect(
      svc.sent("claude-code@local", { home }).find(
        (item) => item.message_id === task.id,
      ),
    ).toMatchObject({
      message_id: task.id,
      status: "completed",
      task_status: "completed",
      status_evidence: { basis: "task", task_status: "completed" },
    });

    // The sender can see its own history only; no project-wide tail leaks in.
    expect(svc.sent("codex@local", { home }).every((item) => item.message_id === done.id)).toBe(true);
    const details = svc.agentDetails("grok@local", {
      home,
      requester: "claude-code@local",
    });
    expect(details).toMatchObject({
      agent_id: "grok@local",
      device_name: null,
      device_ip: null,
      hub_endpoint: null,
      connection: "unknown",
      last_seen: null,
      evidence: { registration: true, heartbeat: false },
    });
    expect(details.fields_unknown).toEqual(
      expect.arrayContaining([
        "device_name",
        "device_ip",
        "connection",
        "hub_endpoint",
        "last_seen",
      ]),
    );
  });

  it("serves authenticated remote history/details with isolation after Hub restart", async () => {
    const dir = temporaryDirectory("am-sent-remote-");
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    const tokenClaude = mintToken(home, "claude-code@local");
    const tokenCodex = mintToken(home, "codex@local");
    let hub = await listenHub({ home, host: "127.0.0.1", port: 0 });
    try {
      const claude = new RemoteMailClient({
        hub_url: hub.url,
        hub_token: tokenClaude,
        hub_ca_file: null,
        hub_insecure_tls: false,
        sources: {},
        warnings: [],
      });
      const codex = new RemoteMailClient({
        hub_url: hub.url,
        hub_token: tokenCodex,
        hub_ca_file: null,
        hub_insecure_tls: false,
        sources: {},
        warnings: [],
      });

      const sent = await claude.send({
        to: "codex@local",
        type: "task",
        body: "remote durable task",
        effect: "read",
      });
      const own = await claude.sent({ limit: 10 });
      expect(own.agent_id).toBe("claude-code@local");
      expect(own.items).toEqual([
        expect.objectContaining({
          message_id: sent.id,
          status: "submitted",
          delivery_status: "pending",
          task_status: "open",
        }),
      ]);
      expect((await codex.sent({ limit: 10 })).count).toBe(0);
      expect(JSON.stringify(own)).not.toContain(tokenClaude);
      expect(JSON.stringify(own)).not.toContain(tokenCodex);

      const unauthorized = await jsonFetch(hub.url, "/v1/mail/sent");
      expect(unauthorized.status).toBe(401);
      const crossQuery = await jsonFetch(hub.url, "/v1/mail/sent?agent_id=codex%40local", {
        token: tokenClaude,
      });
      expect(crossQuery.status).toBe(403);
      const codexRaw = await jsonFetch(hub.url, "/v1/mail/sent", { token: tokenCodex });
      expect(codexRaw.status).toBe(200);
      expect(codexRaw.json.count).toBe(0);

      const recipientDetails = await claude.agentDetails("codex@local");
      expect(recipientDetails).toMatchObject({
        agent_id: "codex@local",
        hub_endpoint: hub.url,
        device_name: null,
        device_ip: null,
        connection: "unknown",
        last_seen: null,
        evidence: { registration: true, heartbeat: false },
      });
      const ownDetails = await claude.agentDetails();
      expect(ownDetails).toMatchObject({
        agent_id: "claude-code@local",
        hub_endpoint: hub.url,
        device_name: null,
        device_ip: null,
        connection: "unknown",
        evidence: {
          registration: true,
          heartbeat: false,
          authenticated_request: true,
        },
      });
      expect(typeof ownDetails.last_seen).toBe("string");

      await closeHub(hub.server);
      hub = await listenHub({ home, host: "127.0.0.1", port: 0 });
      const afterRestart = new RemoteMailClient({
        hub_url: hub.url,
        hub_token: tokenClaude,
        hub_ca_file: null,
        hub_insecure_tls: false,
        sources: {},
        warnings: [],
      });
      expect((await afterRestart.sent({ limit: 10 })).items).toEqual([
        expect.objectContaining({
          message_id: sent.id,
          delivery_status: "pending",
          task_status: "open",
          status: "submitted",
        }),
      ]);
    } finally {
      await closeHub(hub.server);
    }
  });
});
