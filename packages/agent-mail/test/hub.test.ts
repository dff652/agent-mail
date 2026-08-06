import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { mintToken } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import * as svc from "../src/services.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const ROUTES = path.join(REPO, "contracts/http/mail-api-routes.json");
const NEGATIVES = path.join(REPO, "contracts/http/security-negatives.json");
const WIRE = path.join(REPO, "contracts/http/wire-contracts.json");

async function jsonFetch(
  base: string,
  method: string,
  p: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("Hub R3 Mail Data API", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-hub-"));
  const home = svc.initProject(path.join(dir, ".agent-mail"));
  let base = "";
  let server: { close: () => void } | null = null;
  let tokenClaude = "";
  let tokenCodex = "";

  it("starts hub and mints tokens", async () => {
    tokenClaude = mintToken(home, "claude-code@local");
    tokenCodex = mintToken(home, "codex@local");
    const listened = await listenHub({ home, host: "127.0.0.1", port: 0 });
    server = listened.server;
    base = listened.url;
    const health = await jsonFetch(base, "GET", "/healthz");
    expect(health.status).toBe(200);
    expect(health.json.status).toBe("ok");
    expect(health.json.home).toBeUndefined();
  });

  it("GET /v1/mail/me requires bearer", async () => {
    const missing = await jsonFetch(base, "GET", "/v1/mail/me");
    expect([401, 403]).toContain(missing.status);

    const wrong = await jsonFetch(base, "GET", "/v1/mail/me", {
      token: "not-a-real-token",
    });
    expect([401, 403]).toContain(wrong.status);

    const ok = await jsonFetch(base, "GET", "/v1/mail/me", {
      token: tokenClaude,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.agent_id).toBe("claude-code@local");
  });

  it("rejects body identity impersonation", async () => {
    const res = await jsonFetch(base, "POST", "/v1/mail/messages", {
      token: tokenClaude,
      body: {
        from: "codex@local",
        to: "codex@local",
        type: "message",
        body: "impersonation",
      },
    });
    expect(res.status).toBe(403);
  });

  it("send + inbox + claim happy path", async () => {
    const sent = await jsonFetch(base, "POST", "/v1/mail/messages", {
      token: tokenClaude,
      body: {
        to: "codex@local",
        type: "task",
        body: "hub review please",
        effect: "read",
      },
    });
    expect(sent.status).toBe(201);
    expect(sent.json.id).toBeTruthy();
    const mid = String(sent.json.id);

    const inbox = await jsonFetch(base, "GET", "/v1/mail/inbox", {
      token: tokenCodex,
    });
    expect(inbox.status).toBe(200);
    expect(Number(inbox.json.count)).toBeGreaterThanOrEqual(1);
    const item = (inbox.json.items as Array<Record<string, unknown>>).find(
      (candidate) => candidate.message_id === mid,
    );
    expect(item).toMatchObject({
      requires_human_approval: false,
      approval_id: null,
      approval_status: null,
    });

    const claim = await jsonFetch(base, "POST", `/v1/mail/messages/${mid}/claim`, {
      token: tokenCodex,
    });
    expect(claim.status).toBe(200);
    expect(claim.json.status).toBe("claimed");
  });

  it("contract route table is documented", () => {
    const routes = JSON.parse(fs.readFileSync(ROUTES, "utf8")) as {
      routes: Array<{ method: string; path: string }>;
    };
    expect(routes.routes.length).toBeGreaterThanOrEqual(10);
    const negatives = JSON.parse(fs.readFileSync(NEGATIVES, "utf8")) as {
      cases: Array<{ id: string }>;
    };
    const ids = new Set(negatives.cases.map((c) => c.id));
    expect(ids.has("sec.missing_bearer")).toBe(true);
    expect(ids.has("sec.body_cannot_impersonate")).toBe(true);
    const wire = JSON.parse(fs.readFileSync(WIRE, "utf8")) as {
      health: { path: string };
      mail: { send: { created_status: number } };
    };
    expect(wire.health.path).toBe("/healthz");
    expect(wire.mail.send.created_status).toBe(201);
  });

  afterAll(() => {
    server?.close();
  });
});
