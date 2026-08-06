/**
 * P0 N2: execute contracts/http/security-negatives.json against TS Hub.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { rejectPlaintextSecretsInConnection } from "../src/connection-policy.js";
import { addPeer } from "../src/federation/peers.js";
import { mintToken } from "../src/hub/auth.js";
import { createHubServer, listenHub } from "../src/hub/server.js";
import * as svc from "../src/services.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const NEGATIVES = path.join(REPO, "contracts/http/security-negatives.json");

type Case = {
  id: string;
  layer: string;
  expect?: { status?: number[]; reject?: boolean };
};

async function req(
  base: string,
  method: string,
  p: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { status: res.status, json };
}

describe("security-negatives.json (executable)", () => {
  const doc = JSON.parse(fs.readFileSync(NEGATIVES, "utf8")) as { cases: Case[] };
  const ids = new Set(doc.cases.map((c) => c.id));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-sec-"));
  const home = svc.initProject(path.join(dir, ".agent-mail"));
  let base = "";
  let server: { close: () => void } | null = null;
  let userToken = "";

  it("loads all required case ids", () => {
    for (const id of [
      "sec.missing_bearer",
      "sec.wrong_bearer",
      "sec.body_cannot_impersonate",
      "sec.user_token_not_federation_peer",
      "sec.non_loopback_requires_https",
      "sec.connection_json_no_plaintext_bearer",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("starts hub", async () => {
    userToken = mintToken(home, "claude-code@local");
    mintToken(home, "codex@local");
    const listened = await listenHub({ home, host: "127.0.0.1", port: 0 });
    server = listened.server;
    base = listened.url;
  });

  it("sec.missing_bearer", async () => {
    const r = await req(base, "GET", "/v1/mail/me");
    expect([401, 403]).toContain(r.status);
  });

  it("sec.wrong_bearer", async () => {
    const r = await req(base, "GET", "/v1/mail/me", {
      token: "not-a-real-token",
    });
    expect([401, 403]).toContain(r.status);
  });

  it("sec.body_cannot_impersonate", async () => {
    const r = await req(base, "POST", "/v1/mail/messages", {
      token: userToken,
      body: {
        from: "bob@local",
        to: "codex@local",
        type: "message",
        body: "impersonation attempt",
      },
    });
    expect(r.status).toBe(403);
    expect(r.json.error).toBeTruthy();
  });

  it("sec.user_token_not_federation_peer", async () => {
    addPeer(home, {
      domain: "peer.lab",
      base_url: "http://127.0.0.1:9",
    });
    // User hub-token must not authenticate federation pull
    const r = await req(base, "GET", "/v1/federation/pull?domain=peer.lab", {
      token: userToken,
    });
    expect([401, 403]).toContain(r.status);
  });

  it("sec.non_loopback_requires_https (bind policy)", () => {
    // Creating hub with non-loopback without auth throws
    expect(() => {
      createHubServer({
        home,
        host: "0.0.0.0",
        requireAuth: false,
      });
    }).toThrow(/requireAuth|token|TLS|tls/i);

    // With tokens but no TLS cert/key still rejects (HTTPS terminate required)
    mintToken(home, "sec-probe@local");
    expect(() => {
      createHubServer({
        home,
        host: "0.0.0.0",
        requireAuth: true,
      });
    }).toThrow(/TLS|tls-cert/i);
  });

  it("sec.connection_json_no_plaintext_bearer", () => {
    const bad = {
      hub_url: "https://example.com",
      bearer: "super-secret-token-should-not-live-here",
    };
    expect(() => rejectPlaintextSecretsInConnection(bad)).toThrow(/token|bearer|secret/i);
  });

  afterAll(() => {
    server?.close();
  });
});
