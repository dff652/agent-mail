import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/services.js";
import { createConnectionManagementListener, type ConnectionManagementOptions } from "../src/connection-management.js";
import type { EnrollmentTransport } from "../src/enrollment-client.js";

const servers: http.Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function start(authorize?: ConnectionManagementOptions["authorize"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connection-management-")); roots.push(root);
  const home = initProject(path.join(root, ".agent-mail"));
  let mutationCount = 0;
  const mutate = async () => { mutationCount++; throw new Error("unexpected mutation"); };
  const transport: EnrollmentTransport = {
    verify: async () => ({ tls_verified: true, status: 401 }),
    redeem: mutate, recover: mutate, status: mutate, commit: mutate, cancel: mutate,
  };
  const server = http.createServer((req, res) => { void listener(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  const listener = createConnectionManagementListener({ origin, authorize,
    profiles: new Map([["profile-a", { home, allowedHubUrls: ["https://hub.example"], transport }]]) });
  async function post(action: string, body: unknown, headers: Record<string, string> = {}) {
    const result = await fetch(`${origin}/v1/connection-management/${action}`, {
      method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { status: result.status, body: await result.json() as Record<string, unknown> };
  }
  return { home, origin, post, mutations: () => mutationCount };
}
const begin = { profile_handle: "profile-a", endpoint: "https://hub.example" };

describe("host-authenticated connection management", () => {
  it("fails closed when management authorization is absent", async () => {
    const host = await start();
    expect((await host.post("begin", begin)).status).toBe(403);
    expect(fs.existsSync(path.join(host.home, "enrollment"))).toBe(false);
    expect(host.mutations()).toBe(0);
  });
  it.each([
    null,
    { principal: "operator", csrfValidated: false, canManageTarget: true },
    { principal: "operator", csrfValidated: true, canManageTarget: false },
  ])("denies missing session, CSRF or target permission", async authorization => {
    const host = await start(() => authorization);
    expect((await host.post("begin", begin)).status).toBe(403);
    expect(fs.existsSync(path.join(host.home, "enrollment"))).toBe(false);
  });
  it("rejects wrong origin, unknown profiles, unsafe targets and browser-supplied paths", async () => {
    const host = await start(() => ({ principal: "operator", csrfValidated: true, canManageTarget: true }));
    expect((await host.post("begin", begin, { origin: "https://other.example" })).status).toBe(403);
    expect((await host.post("begin", { ...begin, profile_handle: "unknown" })).status).toBe(403);
    expect((await host.post("begin", { ...begin, home: "/browser/path" })).status).toBe(400);
    expect((await host.post("begin", { ...begin, endpoint: "https://unapproved.example" })).status).not.toBe(200);
    expect(host.mutations()).toBe(0);
  });
  it("binds handles to the authenticated owner and rejects client activation evidence", async () => {
    const host = await start(req => ({ principal: req.headers["x-test-subject"] === "other" ? "other" : "operator",
      csrfValidated: true, canManageTarget: true }));
    const result = await host.post("begin", begin);
    expect(result.status).toBe(200);
    const value = result.body.value as Record<string, string>;
    expect(value.state).toBe("context_ready");
    expect(JSON.stringify(result.body)).not.toContain(host.home);
    const denied = await host.post("redeem", { profile_handle: "profile-a", context_handle: value.context_handle,
      request_id: randomUUID(), code: "ABCD-EFGH" }, { "x-test-subject": "other" });
    expect(denied.status).toBe(403);
    expect((await host.post("activate", { profile_handle: "profile-a", enrollment_handle: "unused",
      evidence: { route_verified: true } })).status).toBe(400);
    expect(host.mutations()).toBe(0);
  });
});
