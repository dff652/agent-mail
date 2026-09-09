import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAuthenticatedManagementListener,
  type AuthenticatedManagementListener,
} from "../src/management-session.js";
import type { EnrollmentTransport } from "../src/enrollment-client.js";
import { initProject } from "../src/services.js";

const servers: http.Server[] = [];
const listeners: AuthenticatedManagementListener[] = [];
const roots: string[] = [];

interface CookieJar {
  cookie?: string;
}

afterEach(async () => {
  for (const listener of listeners.splice(0)) listener.dispose();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function transport(): EnrollmentTransport {
  const unexpected = async () => {
    throw new Error("unexpected mutation");
  };
  return {
    verify: async () => ({ tls_verified: true, status: 401 }),
    redeem: unexpected,
    recover: unexpected,
    status: unexpected,
    commit: unexpected,
    cancel: unexpected,
  };
}

async function start(options: {
  now?: () => number;
  sessionTtlMs?: number;
  allowedProfiles?: readonly string[];
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "management-session-"));
  roots.push(root);
  const homeA = initProject(path.join(root, "profile-a", ".agent-mail"));
  const homeB = initProject(path.join(root, "profile-b", ".agent-mail"));
  const passwordFile = path.join(root, "management-password");
  const password = randomBytes(32).toString("base64url");
  fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });

  // The server must bind before the exact Origin (including its port) can be
  // passed to the listener.
  let listener: AuthenticatedManagementListener;
  const server = http.createServer((req, res) => {
    void listener.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener address");
  const origin = `http://127.0.0.1:${address.port}`;
  const listenerOptions = {
    origin,
    profiles: new Map([
      ["profile-a", { label: "Primary", home: homeA, allowedHubUrls: ["https://hub-a.example"], transport: transport() }],
      ["profile-b", { label: "Secondary", home: homeB, allowedHubUrls: ["https://hub-b.example"], transport: transport() }],
    ]),
    operator: {
      principal: "operator@local",
      passwordFile,
      allowedProfiles: options.allowedProfiles ?? ["profile-a"],
    },
    now: options.now,
    sessionTtlMs: options.sessionTtlMs,
  } as const;
  const makeListener = () => createAuthenticatedManagementListener(listenerOptions);
  listener = makeListener();
  listeners.push(listener);

  async function request(
    route: string,
    body: unknown,
    requestOptions: {
      cookie?: string;
      csrf?: string;
      origin?: string;
      method?: string;
      jar?: CookieJar;
    } = {},
  ) {
    const cookie = requestOptions.cookie ?? requestOptions.jar?.cookie;
    const response = await fetch(`${origin}${route}`, {
      method: requestOptions.method ?? "POST",
      headers: {
        Origin: requestOptions.origin ?? origin,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(requestOptions.csrf ? { "X-Agent-Mail-CSRF": requestOptions.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (requestOptions.jar) {
      const setCookie = response.headers.get("set-cookie");
      if (setCookie?.includes("Max-Age=0")) {
        delete requestOptions.jar.cookie;
      } else if (setCookie) {
        const token = setCookie.match(/(?:^|,\s*)agent_mail_session=([^;]+)/)?.[1];
        if (token) requestOptions.jar.cookie = `agent_mail_session=${token}`;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json() as Record<string, unknown>,
    };
  }

  return {
    origin,
    password,
    passwordFile,
    listener,
    request,
    replaceListener: () => {
      listener = makeListener();
      listeners.push(listener);
      return listener;
    },
  };
}

function sessionCookie(headers: Headers): string {
  const value = headers.get("set-cookie");
  if (!value) throw new Error("missing session cookie");
  const token = value.match(/(?:^|,\s*)agent_mail_session=([^;]+)/)?.[1];
  if (!token) throw new Error("missing session token");
  return `agent_mail_session=${token}`;
}

function value(body: Record<string, unknown>): Record<string, unknown> {
  return body.value as Record<string, unknown>;
}

describe("authenticated connection-management session", () => {
  it("authenticates real HTTP requests, returns scoped DTOs and enforces CSRF and ACL", async () => {
    const host = await start();
    expect((await host.request("/v1/management-session/status", {})).body)
      .toEqual({ ok: true, value: { authenticated: false } });

    const login = await host.request("/v1/management-session/login", { password: host.password });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login.headers);
    const loginValue = value(login.body);
    const csrf = String(loginValue.csrf_token);
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(login.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
    expect(login.headers.get("set-cookie")).toMatch(/Path=\/v1\//);
    expect(login.headers.get("set-cookie")).not.toMatch(/Secure/);
    expect(loginValue.profiles).toEqual([
      { handle: "profile-a", label: "Primary", endpoints: ["https://hub-a.example"] },
    ]);
    expect(JSON.stringify(login.body)).not.toContain(host.password);
    expect(JSON.stringify(login.body)).not.toContain(host.passwordFile);

    const status = await host.request("/v1/management-session/status", {}, { cookie });
    expect(status.status).toBe(200);
    expect(value(status.body)).toMatchObject({ authenticated: true, csrf_token: csrf });

    const begin = await host.request(
      "/v1/connection-management/begin",
      { profile_handle: "profile-a", endpoint: "https://hub-a.example" },
      { cookie, csrf },
    );
    expect(begin.status).toBe(200);
    expect(value(begin.body)).toMatchObject({ endpoint: "https://hub-a.example", state: "context_ready" });

    const csrfDenied = await host.request(
      "/v1/connection-management/begin",
      { profile_handle: "profile-a", endpoint: "https://hub-a.example" },
      { cookie },
    );
    expect(csrfDenied.status).toBe(403);

    const aclDenied = await host.request(
      "/v1/connection-management/begin",
      { profile_handle: "profile-b", endpoint: "https://hub-b.example" },
      { cookie, csrf },
    );
    expect(aclDenied.status).toBe(403);

    const logoutDenied = await host.request(
      "/v1/management-session/logout",
      {},
      { cookie, csrf: `${csrf}x` },
    );
    expect(logoutDenied.status).toBe(403);
    const logout = await host.request(
      "/v1/management-session/logout",
      {},
      { cookie, csrf },
    );
    expect(logout.status).toBe(200);
    expect(value(logout.body)).toEqual({ authenticated: false });
    expect((await host.request("/v1/management-session/status", {}, { cookie })).status).toBe(401);
  });

  it("rotates login cookies, rejects malformed inputs and expires/disposes sessions", async () => {
    let current = Date.now();
    const host = await start({ now: () => current, sessionTtlMs: 100 });
    const first = await host.request("/v1/management-session/login", { password: host.password });
    const firstCookie = sessionCookie(first.headers);
    const firstCsrf = String(value(first.body).csrf_token);
    const second = await host.request(
      "/v1/management-session/login",
      { password: host.password },
      { cookie: firstCookie },
    );
    const secondCookie = sessionCookie(second.headers);
    expect(secondCookie).not.toBe(firstCookie);
    expect((await host.request("/v1/management-session/status", {}, { cookie: firstCookie })).status).toBe(401);
    expect((await host.request("/v1/management-session/status", {}, { cookie: secondCookie })).status).toBe(200);

    const duplicate = await host.request(
      "/v1/management-session/status",
      {},
      { cookie: `${secondCookie}; ${secondCookie}` },
    );
    expect(duplicate.status).toBe(401);
    const extra = await host.request(
      "/v1/management-session/login",
      { password: host.password, extra: "field" },
    );
    expect(extra.status).toBe(400);
    const wrongOrigin = await host.request(
      "/v1/management-session/status",
      {},
      { cookie: secondCookie, origin: "http://127.0.0.1:1" },
    );
    expect(wrongOrigin.status).toBe(403);

    current += 101;
    expect((await host.request("/v1/management-session/status", {}, { cookie: secondCookie })).status).toBe(401);
    const expired = await host.request(
      "/v1/management-session/status",
      {},
      { cookie: secondCookie },
    );
    expect(expired.status).toBe(401);
    expect(expired.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    // A browser keeps the old HttpOnly cookie when its in-memory session has
    // expired. Correct credentials must still establish a new generation.
    const jar: CookieJar = { cookie: secondCookie };
    const fresh = await host.request(
      "/v1/management-session/login",
      { password: host.password },
      { jar },
    );
    expect(fresh.status).toBe(200);
    expect(firstCsrf).not.toBe(String(value(fresh.body).csrf_token));
    const freshCookie = jar.cookie;
    expect(freshCookie).toBeTruthy();
    host.listener.dispose();
    host.replaceListener();
    // Recreating the host loses all sessions. The browser still presents the
    // prior cookie, so login must again validate the password and rotate it.
    const afterRestart = await host.request(
      "/v1/management-session/login",
      { password: host.password },
      { cookie: freshCookie, jar },
    );
    expect(afterRestart.status).toBe(200);
    expect(jar.cookie).toBeTruthy();
    expect(jar.cookie).not.toBe(freshCookie);
    expect(
      (await host.request("/v1/management-session/status", {}, { jar })).status,
    ).toBe(200);
  });

  it("requires an explicit known profile ACL and rejects weak password files", async () => {
    await expect(start({ allowedProfiles: [] })).rejects.toThrow();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "management-session-config-"));
    roots.push(root);
    const home = initProject(path.join(root, ".agent-mail"));
    const passwordFile = path.join(root, "password");
    fs.writeFileSync(passwordFile, "weak-password\n", { mode: 0o600 });
    expect(() => createAuthenticatedManagementListener({
      origin: "http://127.0.0.1:8123",
      profiles: new Map([["profile-a", {
        label: "Primary",
        home,
        allowedHubUrls: ["https://hub.example"],
        transport: transport(),
      }]]),
      operator: { principal: "operator@local", passwordFile, allowedProfiles: ["profile-a"] },
    })).toThrow();
  });

  it("rejects credential-bearing or query-bearing profile endpoints at setup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "management-session-target-"));
    roots.push(root);
    const home = initProject(path.join(root, ".agent-mail"));
    const passwordFile = path.join(root, "password");
    fs.writeFileSync(passwordFile, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
    for (const endpoint of [
      "https://user:password@hub.example",
      "https://hub.example/?credential=secret",
    ]) {
      expect(() => createAuthenticatedManagementListener({
        origin: "http://127.0.0.1:8123",
        profiles: new Map([["profile-a", {
          label: "Primary",
          home,
          allowedHubUrls: [endpoint],
          transport: transport(),
        }]]),
        operator: {
          principal: "operator@local",
          passwordFile,
          allowedProfiles: ["profile-a"],
        },
      })).toThrow();
    }
  });
});
