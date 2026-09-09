import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import type { RequestListener } from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnrollmentHubClient } from "../src/enrollment-client.js";

let root: string;
let cert: string;
let key: string;
const servers: https.Server[] = [];
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "enrollment-client-http-"));
  cert = path.join(root, "cert.pem"); key = path.join(root, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
});
afterAll(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
async function start(handler: RequestListener) {
  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener address");
  return `https://127.0.0.1:${address.port}`;
}
function request() {
  return { code: "ABCD-EFGH", request_id: randomUUID(), recovery_proof: randomBytes(32).toString("base64url") };
}

describe("enrollment HTTPS transport", () => {
  it("verifies TLS separately from an unauthenticated health response", async () => {
    const baseUrl = await start((_req, res) => { res.writeHead(401); res.end("unauthorized"); });
    const trusted = new EnrollmentHubClient({ baseUrl, caFile: cert });
    expect(await trusted.verify()).toMatchObject({ tls_verified: true, status: 401 });
    await expect(new EnrollmentHubClient({ baseUrl }).verify()).rejects.toMatchObject({ code: "tls_untrusted" });
  });
  it("never follows redirects to another target", async () => {
    let destinationCalls = 0;
    const destination = await start((_req, res) => { destinationCalls++; res.end("{}"); });
    const baseUrl = await start((_req, res) => { res.writeHead(307, { location: destination }); res.end("{}"); });
    const client = new EnrollmentHubClient({ baseUrl, caFile: cert });
    await expect(client.redeem(request())).rejects.toMatchObject({ code: "target_not_allowed" });
    expect(destinationCalls).toBe(0);
  });
  it("does not automatically repeat a mutation when its response is lost", async () => {
    let requests = 0;
    const baseUrl = await start((req, _res) => { requests++; req.socket.destroy(); });
    const client = new EnrollmentHubClient({ baseUrl, caFile: cert });
    await expect(client.redeem(request())).rejects.toMatchObject({ unknown_outcome: true });
    expect(requests).toBe(1);
  });
  it("preserves unknown mutation outcome for a malformed successful response", async () => {
    const baseUrl = await start((_req, res) => { res.writeHead(200); res.end("broken"); });
    const client = new EnrollmentHubClient({ baseUrl, caFile: cert });
    await expect(client.redeem(request())).rejects.toMatchObject({ code: "protocol_error", unknown_outcome: true });
  });
});
