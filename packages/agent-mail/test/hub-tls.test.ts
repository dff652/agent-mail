/**
 * P1: Hub TLS terminate + non-loopback bind policy.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  HubBindError,
  authConfigured,
  createHubServer,
  isLoopbackHost,
  listenHub,
  validateHubBind,
} from "../src/hub/server.js";
import { mintToken } from "../src/hub/auth.js";
import * as svc from "../src/services.js";

function makePemPair(dir: string): { cert: string; key: string } {
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
      "/CN=localhost",
    ],
    { stdio: "pipe" },
  );
  return { cert, key };
}

function httpsGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers, rejectUnauthorized: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >;
          } catch {
            /* empty */
          }
          resolve({ status: res.statusCode || 0, json });
        });
      })
      .on("error", reject);
  });
}

function waitForSocket(
  socket: net.Socket,
  event: "connect" | "close",
  timeoutMs = 1_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`socket did not emit ${event}`)),
      timeoutMs,
    );
    socket.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      if (event === "close") {
        clearTimeout(timer);
        resolve();
      } else {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

describe("Hub TLS terminate + bind policy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-hub-tls-"));
  const home = svc.initProject(path.join(tmp, ".agent-mail"));
  const pem = makePemPair(tmp);
  let close: (() => void) | null = null;

  it("isLoopbackHost covers 127/8 and localhost", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });

  it("non-loopback without tokens rejects", () => {
    expect(() =>
      validateHubBind({
        host: "0.0.0.0",
        home,
        requireAuth: true,
        tlsCertFile: pem.cert,
        tlsKeyFile: pem.key,
      }),
    ).toThrow(HubBindError);
    expect(() =>
      validateHubBind({
        host: "0.0.0.0",
        home,
        requireAuth: true,
        tlsCertFile: pem.cert,
        tlsKeyFile: pem.key,
      }),
    ).toThrow(/token/i);
  });

  it("non-loopback with tokens but without TLS rejects", () => {
    mintToken(home, "claude-code@local");
    expect(authConfigured(home)).toBe(true);
    expect(() =>
      createHubServer({
        home,
        host: "0.0.0.0",
        requireAuth: true,
      }),
    ).toThrow(/TLS|tls-cert/i);
  });

  it("non-loopback with tokens + TLS cert/key accepts bind policy", () => {
    const r = validateHubBind({
      host: "0.0.0.0",
      home,
      requireAuth: true,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
    });
    expect(r.loopback).toBe(false);
    expect(r.tls).toBe(true);
    expect(r.requireAuth).toBe(true);
  });

  it("allowCleartext lab escape requires tokens still", () => {
    expect(() =>
      validateHubBind({
        host: "0.0.0.0",
        home: svc.initProject(path.join(tmp, "empty", ".agent-mail")),
        requireAuth: true,
        allowCleartext: true,
      }),
    ).toThrow(/token/i);

    const r = validateHubBind({
      host: "0.0.0.0",
      home,
      requireAuth: true,
      allowCleartext: true,
    });
    expect(r.tls).toBe(false);
    expect(r.requireAuth).toBe(true);
  });

  it("listenHub serves HTTPS with self-signed cert on loopback", async () => {
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
    });
    close = () => hub.server.close();
    expect(hub.tls).toBe(true);
    expect(hub.url.startsWith("https://")).toBe(true);

    const health = await httpsGet(`${hub.url}/healthz`);
    expect(health.status).toBe(200);
    expect(health.json.tls).toBe(true);
    expect(health.json.status).toBe("ok");

    const token = mintToken(home, "codex@local");
    const me = await httpsGet(`${hub.url}/v1/mail/me`, {
      Authorization: `Bearer ${token}`,
    });
    expect(me.status).toBe(200);
    expect(me.json.agent_id).toBe("codex@local");
  });

  it("does not let a stalled TLS handshake block a valid client", async () => {
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
      tlsHandshakeTimeoutMs: 150,
    });
    const port = Number(new URL(hub.url).port);
    const stalled = net.createConnection({ host: "127.0.0.1", port });
    try {
      await waitForSocket(stalled, "connect");
      const valid = await Promise.race([
        httpsGet(`${hub.url}/healthz`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("valid TLS client was blocked")), 800),
        ),
      ]);
      expect(valid.status).toBe(200);
      await waitForSocket(stalled, "close");
    } finally {
      stalled.destroy();
      hub.server.close();
    }
  });

  it("enforces a server-wide socket budget and recovers after release", async () => {
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 1,
      headersTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    const port = Number(new URL(hub.url).port);
    const occupied = net.createConnection({ host: "127.0.0.1", port });
    try {
      await waitForSocket(occupied, "connect");
      occupied.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n");
      const dropped = net.createConnection({ host: "127.0.0.1", port });
      await waitForSocket(dropped, "close");
      expect(dropped.destroyed).toBe(true);

      occupied.destroy();
      await waitForSocket(occupied, "close");
      const health = await fetch(`${hub.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      occupied.destroy();
      hub.server.close();
    }
  });

  it("rejects invalid connection governance before listen", () => {
    expect(() =>
      createHubServer({
        home,
        maxConnections: 0,
      }),
    ).toThrow(/connection governance/);
    expect(() =>
      createHubServer({
        home,
        headersTimeoutMs: 2_000,
        requestTimeoutMs: 1_000,
      }),
    ).toThrow(/connection governance/);
  });

  afterAll(() => {
    close?.();
  });
});
