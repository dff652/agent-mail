import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  loadConnection,
  resolveClientConnection,
  setConnection,
  validateHubUrl,
} from "../src/connection.js";
import { rejectPlaintextSecretsInConnection } from "../src/connection-policy.js";
import { mintToken } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import { openRemoteClient, RemoteMailClient } from "../src/remote-client.js";
import * as svc from "../src/services.js";

function makeLoopbackPemPair(dir: string): { cert: string; key: string } {
  const key = path.join(dir, "hub-key.pem");
  const cert = path.join(dir, "hub-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  return { cert, key };
}

describe("P1 remote client + TLS settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-remote-"));
  const home = svc.initProject(path.join(dir, ".agent-mail"));
  let base = "";
  let close: (() => void) | null = null;
  let tokenClaude = "";
  let tokenCodex = "";

  it("validateHubUrl rejects cleartext non-loopback", () => {
    expect(() => validateHubUrl("http://example.com:7421")).toThrow(/https/i);
    expect(validateHubUrl("http://127.0.0.1:7421")).toContain("127.0.0.1");
    expect(validateHubUrl("https://hub.example.com")).toContain("https://");
  });

  it("bounds retry attempts for fail-stop callers", () => {
    expect(
      () =>
        new RemoteMailClient(
          {
            hub_url: "http://127.0.0.1:7421",
            hub_token: "fixture",
            hub_ca_file: null,
            hub_insecure_tls: false,
            sources: {},
            warnings: [],
          },
          { maxAttempts: 0 },
        ),
    ).toThrow(/maxAttempts/);
  });

  it("connection.json rejects embedded bearer", () => {
    expect(() =>
      rejectPlaintextSecretsInConnection({
        hub_url: "https://x",
        bearer: "secret",
      }),
    ).toThrow(/secret|bearer|token/i);
  });

  it("remote client me/send/inbox against local hub", async () => {
    tokenClaude = mintToken(home, "claude-code@local");
    tokenCodex = mintToken(home, "codex@local");
    const tokenPath = path.join(home, "claude.token");
    fs.writeFileSync(tokenPath, tokenClaude + "\n", { mode: 0o600 });

    const hub = await listenHub({ home, host: "127.0.0.1", port: 0 });
    base = hub.url;
    close = () => hub.server.close();

    setConnection(home, {
      hub_url: base,
      token_file: "claude.token",
    });
    const stored = loadConnection(home);
    expect(stored.hub_url).toBe(base);
    expect(stored.token_file).toBe("claude.token");

    process.env.AGENT_MAIL_HUB_URL = base;
    process.env.AGENT_MAIL_HUB_TOKEN = tokenClaude;
    const client = openRemoteClient(home);
    const me = await client.me();
    expect(me.agent_id).toBe("claude-code@local");

    const sent = await client.send({
      to: "codex@local",
      type: "task",
      body: "remote path please",
      effect: "read",
    });
    expect(sent.id).toBeTruthy();

    process.env.AGENT_MAIL_HUB_TOKEN = tokenCodex;
    const codex = openRemoteClient(home);
    const inbox = await codex.inbox();
    expect(Number(inbox.count)).toBeGreaterThanOrEqual(1);

    const claim = await codex.claim(String(sent.id));
    expect(claim.status).toBe("claimed");
  });

  it("verifies a real HTTPS Hub with an explicit CA", async () => {
    const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "am-remote-tls-"));
    const tlsHome = svc.initProject(path.join(tlsDir, ".agent-mail"));
    const pem = makeLoopbackPemPair(tlsDir);
    const token = mintToken(tlsHome, "tls-client@local");
    const hub = await listenHub({
      home: tlsHome,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
      requireAuth: true,
    });
    try {
      const client = new RemoteMailClient(
        {
          hub_url: hub.url,
          hub_token: token,
          hub_ca_file: null,
          hub_insecure_tls: false,
          sources: {},
          warnings: [],
        },
        { maxAttempts: 1, ca: fs.readFileSync(pem.cert) },
      );
      await expect(client.me()).resolves.toMatchObject({
        agent_id: "tls-client@local",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        hub.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("resolve prefers env over connection.json", () => {
    process.env.AGENT_MAIL_HUB_URL = "http://127.0.0.1:9999";
    process.env.AGENT_MAIL_HUB_TOKEN = "env-token";
    const r = resolveClientConnection(home);
    expect(r.hub_url).toContain("9999");
    expect(r.sources.hub_url).toBe("env");
    expect(r.hub_token).toBe("env-token");
    delete process.env.AGENT_MAIL_HUB_URL;
    delete process.env.AGENT_MAIL_HUB_TOKEN;
  });

  afterAll(() => {
    close?.();
    delete process.env.AGENT_MAIL_HUB_URL;
    delete process.env.AGENT_MAIL_HUB_TOKEN;
  });
});
