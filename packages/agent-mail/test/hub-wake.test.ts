import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ensureWebhookSecret,
  ReplayGuard,
  signWebhookBody,
  verifyWebhook,
  WebhookAuthError,
  WebhookValidationError,
  webhookSecretPath,
} from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import {
  encodeSseEvent,
  MAX_SSE_RESPONSE_BYTES,
  parseSseEvents,
  writeSseChunk,
} from "../src/hub/sse.js";
import { mintToken } from "../src/hub/auth.js";
import { readRuntimeLogs } from "../src/observability.js";
import * as svc from "../src/services.js";
import { pollHubEvents } from "../src/wake/bridge.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const WIRE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "contracts/http/wire-contracts.json"), "utf8"),
) as {
  wake: {
    webhook: {
      path: string;
      success_status: number;
      replay_status: number;
      auth_failure_status: number;
      skew_seconds: number;
      nonce_max_chars: number;
      required_response_fields: string[];
      body_free: boolean;
    };
    sse: {
      path: string;
      content_type: string;
      limit_min: number;
      limit_max: number;
      wait_min_seconds: number;
      wait_max_seconds: number;
      max_response_bytes: number;
      required_event_fields: string[];
      body_free: boolean;
    };
  };
};

function tmpHome(prefix = "am-hub-wake-"): string {
  return svc.initProject(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), ".agent-mail"),
  );
}

function signedHeaders(
  secret: string,
  body: Buffer,
  nonce: string,
  timestamp = new Date().toISOString(),
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Agent-Mail-Timestamp": timestamp,
    "X-Agent-Mail-Nonce": nonce,
    "X-Agent-Mail-Signature": signWebhookBody(
      secret,
      body,
      timestamp,
      nonce,
    ),
  };
}

async function webhookRequest(
  base: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${WIRE.wake.webhook.path}`, {
    method: "POST",
    headers,
    body,
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe("signed webhook doorbell", () => {
  it("loads the shared webhook contract", () => {
    expect(WIRE.wake.webhook).toMatchObject({
      success_status: 200,
      replay_status: 400,
      auth_failure_status: 401,
      skew_seconds: 300,
      nonce_max_chars: 128,
      body_free: true,
    });
  });

  it("creates a private stable secret and rejects a symlink target", () => {
    const home = tmpHome();
    const first = ensureWebhookSecret(home);
    const second = ensureWebhookSecret(home);
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(32);
    expect(fs.statSync(webhookSecretPath(home)).mode & 0o777).toBe(0o600);

    const badHome = tmpHome("am-webhook-link-");
    const outside = path.join(os.tmpdir(), `am-webhook-outside-${process.pid}`);
    fs.writeFileSync(outside, "outside remains untouched");
    fs.mkdirSync(path.dirname(webhookSecretPath(badHome)), { recursive: true });
    fs.symlinkSync(outside, webhookSecretPath(badHome));
    expect(() => ensureWebhookSecret(badHome)).toThrow(/regular file/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside remains untouched");

    if (process.platform !== "win32") {
      const insecureHome = tmpHome("am-webhook-mode-");
      ensureWebhookSecret(insecureHome);
      fs.chmodSync(webhookSecretPath(insecureHome), 0o644);
      expect(() => ensureWebhookSecret(insecureHome)).toThrow(/private/);
    }

    const linkedHome = tmpHome("am-webhook-parent-link-");
    const linkedAuth = path.dirname(webhookSecretPath(linkedHome));
    const outsideAuth = fs.mkdtempSync(
      path.join(os.tmpdir(), "am-webhook-outside-auth-"),
    );
    fs.rmSync(linkedAuth, { recursive: true, force: true });
    fs.symlinkSync(outsideAuth, linkedAuth);
    expect(() => ensureWebhookSecret(linkedHome)).toThrow(/real directory/);
    expect(fs.readdirSync(outsideAuth)).toEqual([]);
  });

  it("initializes the secret through the public CLI without implicit projects", () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-webhook-cli-"));
    svc.initProject(path.join(project, ".agent-mail"));
    const run = (target: string) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(packageRoot, "src/cli.ts"),
          "hub-token",
          "webhook-init",
          "--path",
          target,
        ],
        { cwd: packageRoot, encoding: "utf8" },
      );

    const initialized = run(project);
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(initialized.stdout.trim()).toBe(
      ensureWebhookSecret(path.join(project, ".agent-mail")),
    );
    expect(initialized.stderr).toContain("never commit");

    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "am-webhook-missing-"));
    const rejected = run(missing);
    expect(rejected.status).toBe(3);
    expect(rejected.stderr).toContain("not initialized");
    expect(fs.existsSync(path.join(missing, ".agent-mail"))).toBe(false);
  });

  it("verifies signature then enforces timestamp and nonce replay", () => {
    const home = tmpHome();
    const secret = ensureWebhookSecret(home);
    const body = Buffer.from(JSON.stringify({ recipient: "codex@local" }));
    const timestamp = new Date().toISOString();
    const signature = signWebhookBody(secret, body, timestamp, "nonce-1");
    const replay = new ReplayGuard();
    expect(() =>
      verifyWebhook(home, {
        body,
        timestamp,
        nonce: "nonce-1",
        signature,
        replay,
      }),
    ).not.toThrow();
    expect(() =>
      verifyWebhook(home, {
        body,
        timestamp,
        nonce: "nonce-1",
        signature,
        replay,
      }),
    ).toThrow(WebhookValidationError);
    expect(() =>
      verifyWebhook(home, {
        body,
        timestamp,
        nonce: "unicode-🔔",
        signature: signWebhookBody(secret, body, timestamp, "unicode-🔔"),
        replay,
      }),
    ).toThrow(/printable ASCII/);
    expect(() =>
      verifyWebhook(home, {
        body,
        timestamp,
        nonce: "nonce-2",
        signature: "0".repeat(64),
        replay,
      }),
    ).toThrow(WebhookAuthError);
  });

  it("accepts a signed hint, backfills outbox, and rejects bad/replayed/expired signatures", async () => {
    const home = tmpHome();
    const secret = ensureWebhookSecret(home);
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "private webhook fixture body",
      home,
    });
    const db = new Database(path.join(home, "store.sqlite"));
    try {
      db.prepare("DELETE FROM outbox_events").run();
    } finally {
      db.close();
    }
    const hub = await listenHub({ home, host: "127.0.0.1", port: 0 });
    try {
      const body = Buffer.from(JSON.stringify({ recipient: "codex@local" }));
      const acceptedHeaders = signedHeaders(secret, body, "endpoint-ok");
      const accepted = await webhookRequest(
        hub.url,
        body,
        acceptedHeaders,
      );
      expect(accepted.status).toBe(WIRE.wake.webhook.success_status);
      expect(Object.keys(accepted.json)).toEqual(
        expect.arrayContaining(WIRE.wake.webhook.required_response_fields),
      );
      expect(accepted.json).toMatchObject({
        status: "accepted",
        recipient: "codex@local",
        backfilled_events: 1,
      });
      expect(JSON.stringify(accepted.json)).not.toContain(
        "private webhook fixture body",
      );

      const replayed = await webhookRequest(
        hub.url,
        body,
        acceptedHeaders,
      );
      expect(replayed.status).toBe(WIRE.wake.webhook.replay_status);
      expect(replayed.json.error).toMatch(/replay/);

      const wrong = await webhookRequest(hub.url, body, {
        ...signedHeaders(secret, body, "endpoint-wrong"),
        "X-Agent-Mail-Signature": "0".repeat(64),
      });
      expect(wrong.status).toBe(WIRE.wake.webhook.auth_failure_status);
      expect(wrong.json.error).toMatch(/signature/);

      const expiredAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const expired = await webhookRequest(
        hub.url,
        body,
        signedHeaders(secret, body, "endpoint-expired", expiredAt),
      );
      expect(expired.status).toBe(400);
      expect(expired.json.error).toMatch(/skew/);

      const unsigned = await webhookRequest(hub.url, body, {
        "Content-Type": "application/json",
      });
      expect(unsigned.status).toBe(WIRE.wake.webhook.auth_failure_status);
      const logs = JSON.stringify(readRuntimeLogs(home, { limit: 50 }));
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain("private webhook fixture body");
    } finally {
      hub.server.close();
    }
  });
});

describe("SSE wait and connection governance", () => {
  it("loads the shared SSE contract", () => {
    expect(WIRE.wake.sse).toMatchObject({
      content_type: "text/event-stream",
      limit_min: 1,
      limit_max: 1000,
      wait_min_seconds: 0,
      wait_max_seconds: 30,
      max_response_bytes: MAX_SSE_RESPONSE_BYTES,
      body_free: true,
    });
  });

  it("waits for a later event and emits strict body-free SSE frames", async () => {
    const home = tmpHome();
    const token = mintToken(home, "codex@local");
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      ssePollIntervalMs: 20,
    });
    try {
      const response = await fetch(
        `${hub.url}${WIRE.wake.sse.path}?recipient=codex@local&consumer=sse:wait&wait=0.15`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: WIRE.wake.sse.content_type,
          },
        },
      );
      svc.send({
        from_id: "claude-code@local",
        to: "codex@local",
        type: "message",
        body: "private SSE fixture body",
        home,
      });
      const raw = Buffer.from(await response.arrayBuffer());
      const events = parseSseEvents(raw, "codex@local");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        WIRE.wake.sse.content_type,
      );
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0])).toEqual(
        expect.arrayContaining(WIRE.wake.sse.required_event_fields),
      );
      expect(events[0].recipient).toBe("codex@local");
      expect(raw.toString("utf8")).not.toContain("private SSE fixture body");

      const clientEvents = await pollHubEvents({
        home,
        recipient: "codex@local",
        consumerId: "sse:typed-client",
        runner: "codex",
        hubUrl: hub.url,
        hubToken: token,
        waitSeconds: 0,
      });
      expect(clientEvents).toHaveLength(1);
      expect(clientEvents[0].message_id).toBe(events[0].message_id);
    } finally {
      hub.server.close();
    }
  });

  it("returns after an idle wait and validates wait/limit parameters", async () => {
    const home = tmpHome();
    const token = mintToken(home, "codex@local");
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      ssePollIntervalMs: 10,
    });
    try {
      const started = performance.now();
      const idle = await fetch(
        `${hub.url}/v1/events?recipient=codex@local&wait=0.08`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/event-stream",
          },
        },
      );
      const raw = Buffer.from(await idle.arrayBuffer());
      expect(performance.now() - started).toBeGreaterThanOrEqual(60);
      expect(parseSseEvents(raw, "codex@local")).toEqual([]);

      const invalid = await fetch(
        `${hub.url}/v1/events?recipient=codex@local&wait=31`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } },
      );
      expect(invalid.status).toBe(400);
      const jsonWait = await fetch(
        `${hub.url}/v1/events?recipient=codex@local&wait=1`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(jsonWait.status).toBe(400);
    } finally {
      hub.server.close();
    }
  });

  it("caps concurrent SSE waits and releases the slot after cancellation", async () => {
    const home = tmpHome();
    const token = mintToken(home, "codex@local");
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      maxSseConnections: 1,
      ssePollIntervalMs: 10,
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    };
    try {
      const first = await fetch(
        `${hub.url}/v1/events?recipient=codex@local&consumer=sse:first&wait=5`,
        { headers },
      );
      const limited = await fetch(
        `${hub.url}/v1/events?recipient=codex@local&consumer=sse:second&wait=0`,
        { headers },
      );
      expect(limited.status).toBe(503);
      await first.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const afterCancel = await fetch(
        `${hub.url}/v1/events?recipient=codex@local&consumer=sse:third&wait=0`,
        { headers },
      );
      expect(afterCancel.status).toBe(200);
      await afterCancel.arrayBuffer();
    } finally {
      hub.server.close();
    }
  });

  it("times out a slow writer and strictly rejects malformed or oversized frames", async () => {
    const writer = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      writableEnded: boolean;
      write: (chunk: string) => boolean;
    };
    writer.destroyed = false;
    writer.writableEnded = false;
    writer.write = () => false;
    await expect(
      writeSseChunk(writer as unknown as http.ServerResponse, "data: x\n\n", 20),
    ).rejects.toThrow(/drain/);

    const event = {
      sequence: 1,
      id: "evt_1",
      ts: new Date().toISOString(),
      kind: "message.created",
      recipient: "codex@local",
      message_id: "msg_1",
      payload: {},
    };
    const frame = encodeSseEvent(event);
    expect(
      parseSseEvents(Buffer.from(frame), "codex@local"),
    ).toEqual([event]);
    expect(() =>
      parseSseEvents(
        Buffer.from(frame.replace("id: 1", "id: 2")),
        "codex@local",
      ),
    ).toThrow(/envelope/);
    expect(() =>
      parseSseEvents(
        Buffer.alloc(MAX_SSE_RESPONSE_BYTES + 1),
        "codex@local",
      ),
    ).toThrow(/size/);
  });
});
