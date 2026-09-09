import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/services.js";
import { createPairing } from "../src/pairing.js";
import { authenticateBearer, listTokenMetadata } from "../src/hub/auth.js";
import { listenHub, type HubServer } from "../src/hub/server.js";
import { createConnectionManagementListener } from "../src/connection-management.js";
import { loadConnection, loadConnectionSnapshot } from "../src/connection.js";

const roots: string[] = [];
const servers: (HubServer | http.Server)[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function setup(dropRedeemResponse = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "management-e2e-")); roots.push(root);
  const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
  const home = initProject(path.join(root, "joining/.agent-mail"));
  const hubHome = initProject(path.join(root, "hub/.agent-mail"));
  const hub = await listenHub({ home: hubHome, host: "127.0.0.1", port: 0,
    tlsCertFile: cert, tlsKeyFile: key, requireAuth: true, enableEnrollment: true });
  servers.push(hub.server);
  const server = http.createServer((req, res) => {
    if (dropRedeemResponse && req.url?.endsWith("/redeem")) {
      dropRedeemResponse = false;
      // Lose only the browser-facing response after provider processing.
      res.end = (() => { res.destroy(); return res; }) as typeof res.end;
    }
    void listener(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  const listener = createConnectionManagementListener({ origin,
    profiles: new Map([["joining", { home, allowedHubUrls: [hub.url], caFile: cert }]]),
    // A test host authentication boundary; not the DSH production adapter.
    authorize: req => req.headers["x-fixture-session"] === "operator" ? {
      principal: "operator", csrfValidated: req.headers["x-fixture-csrf"] === "valid", canManageTarget: true,
    } : null });
  async function post(action: string, fields: Record<string, unknown>) {
    const response = await fetch(`${origin}/v1/connection-management/${action}`, {
      method: "POST", headers: { origin, "content-type": "application/json",
        "x-fixture-session": "operator", "x-fixture-csrf": "valid" },
      body: JSON.stringify({ profile_handle: "joining", ...fields }),
    });
    return await response.json() as { ok: boolean; value?: Record<string, string>; error?: { code: string } };
  }
  const context = await post("begin", { endpoint: hub.url });
  expect(context.ok).toBe(true);
  const pairing = createPairing(hubHome, "http-joined@local");
  const redeem = { context_handle: context.value!.context_handle, request_id: randomUUID(), code: pairing.code };
  return { home, hubHome, post, context: context.value!, redeem };
}

describe("management HTTP against the real HTTPS enrollment Hub", () => {
  it("recovers a lost browser response without consuming another code", async () => {
    const host = await setup(true);
    await expect(host.post("redeem", host.redeem)).rejects.toThrow();
    const status = await host.post("status", { enrollment_handle: host.context.context_handle });
    expect(status.ok).toBe(true);
    expect(status.value!.state).toBe("pending_save");
    expect(listTokenMetadata(host.hubHome).filter(token => token.agent_id === "http-joined@local")).toHaveLength(1);
    const commitInput = { enrollment_handle: status.value!.enrollment_handle,
      expected_config_revision: host.context.observed_config_revision, confirmed_agent_id: "http-joined@local" };
    const saved = await host.post("commit", commitInput);
    expect(saved.ok).toBe(true);
    expect(saved.value).toMatchObject({ save_state: "saved", activation_state: "restart_required" });
    const repeated = await host.post("commit", commitInput);
    expect(repeated.value!.commit_id).toBe(saved.value!.commit_id);
    const credential = fs.readFileSync(path.resolve(host.home, loadConnection(host.home).token_file), "utf8").trim();
    expect(JSON.stringify({ status, saved, repeated })).not.toContain(credential);
    expect(authenticateBearer(host.hubHome, `Bearer ${credential}`)).toBe("http-joined@local");
  });
  it("gives commit and cancel mutually exclusive outcomes across separate HTTP managers", async () => {
    const host = await setup();
    const enrolled = await host.post("redeem", host.redeem);
    expect(enrolled.ok).toBe(true);
    const handle = enrolled.value!.enrollment_handle;
    const before = loadConnectionSnapshot(host.home);
    const [commit, cancel] = await Promise.all([
      host.post("commit", { enrollment_handle: handle, expected_config_revision: host.context.observed_config_revision,
        confirmed_agent_id: "http-joined@local" }),
      host.post("cancel", { enrollment_handle: handle }),
    ]);
    expect(Number(commit.ok) + Number(cancel.ok)).toBe(1);
    if (commit.ok) {
      const credential = fs.readFileSync(path.resolve(host.home, loadConnection(host.home).token_file), "utf8").trim();
      expect(authenticateBearer(host.hubHome, `Bearer ${credential}`)).toBe("http-joined@local");
    } else {
      expect(cancel.value!.state).toBe("cancelled");
      expect(loadConnectionSnapshot(host.home).revision).toBe(before.revision);
      expect(listTokenMetadata(host.hubHome).some(token => token.agent_id === "http-joined@local")).toBe(false);
    }
  });
});
