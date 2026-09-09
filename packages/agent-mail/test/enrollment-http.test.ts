import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenHub, createHubServer, type HubServer } from "../src/hub/server.js";
import { createPairing } from "../src/pairing.js";
import { authenticateBearer } from "../src/hub/auth.js";
import { initProject } from "../src/services.js";
import { redeemEnrollment } from "../src/enrollment.js";

let root: string;
let cert: string;
let key: string;
const servers: HubServer[] = [];
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "enrollment-http-"));
  cert = path.join(root, "cert.pem"); key = path.join(root, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
});
afterAll(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
async function start(enabled = true, tls = true) {
  const home = initProject(path.join(root, randomUUID(), ".agent-mail"));
  const result = await listenHub({ home, port: 0, enableEnrollment: enabled,
    ...(tls ? { tlsCertFile: cert, tlsKeyFile: key } : {}) });
  servers.push(result.server);
  return { ...result, home };
}
function post(url: string, input: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const text = JSON.stringify(input);
    const req = (url.startsWith("https:") ? https : http).request(url, {
      method: "POST", ca: fs.readFileSync(cert),
      headers: { "content-type": "application/json", ...headers },
    }, res => {
      const data: Buffer[] = [];
      res.on("data", chunk => data.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(data).toString()) }));
    });
    req.on("error", reject); req.end(text);
  });
}

describe("guarded enrollment wire boundary", () => {
  it("resumes expired cleanup on restart even when new enrollment is disabled", async () => {
    const home = initProject(path.join(root, randomUUID(), ".agent-mail"));
    const code = createPairing(home, "restart-cleanup@local");
    const issued = redeemEnrollment(home, { code: code.code, request_id: randomUUID(),
      recovery_proof: randomBytes(32).toString("base64url") }, { now: new Date(Date.now() - 11 * 60_000) });
    const restarted = await listenHub({ home, port: 0 }); servers.push(restarted.server);
    expect(() => authenticateBearer(home, `Bearer ${issued.token}`)).toThrow();
    expect((await post(restarted.url + "/v1/enrollments/redeem", {})).status).toBe(404);
  });
  it("is disabled by default and cannot be enabled over cleartext", async () => {
    const hub = await start(false, false);
    expect((await post(hub.url + "/v1/enrollments/redeem", {})).status).toBe(404);
    expect(() => createHubServer({ home: hub.home, enableEnrollment: true })).toThrow(/HTTPS/);
  });
  it("rejects browser-origin calls and unrecognized fields without consuming a code", async () => {
    const hub = await start();
    const code = createPairing(hub.home, "wire-boundary@local");
    const request = { code: code.code, request_id: randomUUID(), recovery_proof: randomBytes(32).toString("base64url") };
    expect((await post(hub.url + "/v1/enrollments/redeem", request, { origin: hub.url })).status).toBe(403);
    expect((await post(hub.url + "/v1/enrollments/redeem", { ...request, home: "ignored" })).status).toBe(400);
    expect((await post(hub.url + "/v1/enrollments/redeem", request)).status).toBe(200);
  });
  it("recovers a lost redemption reply only with the owning proof, and commits once", async () => {
    const hub = await start();
    const code = createPairing(hub.home, "wire-recover@local");
    const request = { code: code.code, request_id: randomUUID(), recovery_proof: randomBytes(32).toString("base64url") };
    const first = await post(hub.url + "/v1/enrollments/redeem", request);
    expect(first.status).toBe(200);
    const issued = first.body.value as Record<string, string>;
    const recovered = await post(hub.url + "/v1/enrollments/recover", {
      request_id: request.request_id, recovery_proof: request.recovery_proof,
    });
    expect((recovered.body.value as Record<string, string>).token).toBe(issued.token);
    expect((await post(hub.url + "/v1/enrollments/recover", {
      request_id: request.request_id, recovery_proof: randomBytes(32).toString("base64url"),
    })).status).not.toBe(200);
    const owner = { enrollment_id: issued.enrollment_id, recovery_proof: request.recovery_proof };
    const status = await post(hub.url + "/v1/enrollments/status", owner);
    expect(JSON.stringify(status.body)).not.toContain(issued.token);
    const commit = { ...owner, commit_id: randomUUID() };
    expect((await post(hub.url + "/v1/enrollments/commit", commit)).status).toBe(200);
    expect((await post(hub.url + "/v1/enrollments/commit", commit)).status).toBe(200);
    expect((await post(hub.url + "/v1/enrollments/cancel", owner)).status).not.toBe(200);
    expect(authenticateBearer(hub.home, `Bearer ${issued.token}`)).toBe("wire-recover@local");
  });
  it("cancels only the pending enrollment and hides the credential in safe state", async () => {
    const hub = await start();
    const code = createPairing(hub.home, "wire-cancel@local");
    const recovery_proof = randomBytes(32).toString("base64url");
    const first = await post(hub.url + "/v1/enrollments/redeem", { code: code.code, request_id: randomUUID(), recovery_proof });
    const issued = first.body.value as Record<string, string>;
    const cancelled = await post(hub.url + "/v1/enrollments/cancel", { enrollment_id: issued.enrollment_id, recovery_proof });
    expect(cancelled.status).toBe(200);
    expect(JSON.stringify(cancelled.body)).not.toContain(issued.token);
    expect(() => authenticateBearer(hub.home, `Bearer ${issued.token}`)).toThrow();
  });
});
