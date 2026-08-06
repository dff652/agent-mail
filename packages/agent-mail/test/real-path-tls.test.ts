/**
 * Real-path TLS matrix (DEVELOPMENT-SOP §2.4).
 *
 * Every advertised remote capability is exercised with the *product* client
 * against a real TLS Hub and a pinned private CA. Testing the server with a
 * test-local HTTP helper while testing the client over cleartext loopback is
 * what let the Node 20 secure-client regression survive 8 days
 * (project-evaluation-2026-08-01 §2), and what hid the missing CA option on the
 * federation and bridge paths (same evaluation, P0-2).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { outboundRequest } from "../src/outbound-http.js";

import { pullFromPeer as workerPullFromPeer, pushPending } from "../src/federation/worker.js";
import {
  addPeer,
  getPeer,
  setLocalDomain,
  setPeerCaFile,
  setPeerOutboundToken,
} from "../src/federation/peers.js";
import { setConnection } from "../src/connection.js";
import { runDoctor } from "../src/doctor.js";
import { mintToken } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import * as svc from "../src/services.js";
import { pollHubEvents } from "../src/wake/bridge.js";

interface Pem {
  cert: string;
  key: string;
}

function makeLoopbackPemPair(dir: string, name: string): Pem {
  const key = path.join(dir, `${name}-key.pem`);
  const cert = path.join(dir, `${name}-cert.pem`);
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

function addAgent(home: string, id: string): void {
  const p = path.join(home, "agents.json");
  const roster = JSON.parse(fs.readFileSync(p, "utf8")) as {
    agents: Array<{ id: string; display_name: string; skills: string[] }>;
  };
  if (!roster.agents.some((a) => a.id === id)) {
    roster.agents.push({
      id,
      display_name: id.split("@", 1)[0] || id,
      skills: ["lab"],
    });
    fs.writeFileSync(p, JSON.stringify(roster, null, 2));
  }
}

describe("real-path TLS matrix: product clients against a private-CA Hub", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-realpath-tls-"));
  const closers: Array<() => void> = [];

  afterAll(() => {
    for (const close of closers) close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("federates push and pull over HTTPS when the peer CA is pinned", async () => {
    const homeA = svc.initProject(path.join(tmp, "push-a", ".agent-mail"));
    const homeB = svc.initProject(path.join(tmp, "push-b", ".agent-mail"));
    setLocalDomain(homeA, "alice.lab");
    setLocalDomain(homeB, "bob.lab");
    addAgent(homeA, "claude@alice.lab");
    addAgent(homeB, "codex@bob.lab");

    const pemA = makeLoopbackPemPair(tmp, "hub-a");
    const pemB = makeLoopbackPemPair(tmp, "hub-b");
    const hubA = await listenHub({
      home: homeA,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pemA.cert,
      tlsKeyFile: pemA.key,
    });
    closers.push(() => hubA.server.close());
    const hubB = await listenHub({
      home: homeB,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pemB.cert,
      tlsKeyFile: pemB.key,
    });
    closers.push(() => hubB.server.close());
    expect(hubA.url.startsWith("https://")).toBe(true);

    const aToB = addPeer(homeA, {
      domain: "bob.lab",
      base_url: hubB.url,
      push_enabled: true,
      ca_file: pemB.cert,
    });
    const bToA = addPeer(homeB, {
      domain: "alice.lab",
      base_url: hubA.url,
      push_enabled: true,
      ca_file: pemA.cert,
    });
    setPeerOutboundToken(homeA, "bob.lab", bToA.inbound_token);
    setPeerOutboundToken(homeB, "alice.lab", aToB.inbound_token);
    expect(getPeer(homeA, "bob.lab")?.ca_file).toBe(path.resolve(pemB.cert));

    // Cell 1: federation push, product worker → real TLS peer.
    const outbound = svc.send({
      from_id: "claude@alice.lab",
      to: "codex@bob.lab",
      type: "message",
      body: "tls push over a private CA",
      home: homeA,
    });
    const pushed = await pushPending(homeA, { domain: "bob.lab" });
    expect(pushed.errors).toEqual([]);
    expect(pushed.pushed).toBe(1);
    expect(
      svc.inbox("codex@bob.lab", { home: homeB }).map((i) => i.message.id),
    ).toContain(outbound.id);

    // Cell 2: federation pull, product worker → real TLS peer.
    const reply = svc.send({
      from_id: "codex@bob.lab",
      to: "claude@alice.lab",
      type: "message",
      body: "tls pull over a private CA",
      home: homeB,
    });
    const pulled = await workerPullFromPeer(
      homeA,
      getPeer(homeA, "bob.lab")!,
      "alice.lab",
    );
    expect(pulled.errors).toEqual([]);
    expect(pulled.imported).toBe(1);
    expect(
      svc.inbox("claude@alice.lab", { home: homeA }).map((i) => i.message.id),
    ).toContain(reply.id);
  });

  it("fails closed when the federation peer CA is not pinned", async () => {
    const home = svc.initProject(path.join(tmp, "nocap", ".agent-mail"));
    const peerHome = svc.initProject(path.join(tmp, "nocap-peer", ".agent-mail"));
    setLocalDomain(home, "local.lab");
    setLocalDomain(peerHome, "remote.lab");
    addAgent(home, "claude@local.lab");
    addAgent(peerHome, "codex@remote.lab");

    const pem = makeLoopbackPemPair(tmp, "hub-nocap");
    const hub = await listenHub({
      home: peerHome,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
    });
    closers.push(() => hub.server.close());

    addPeer(home, {
      domain: "remote.lab",
      base_url: hub.url,
      push_enabled: true,
    });
    const remoteToLocal = addPeer(peerHome, {
      domain: "local.lab",
      base_url: "https://127.0.0.1:1",
    });
    setPeerOutboundToken(home, "remote.lab", remoteToLocal.inbound_token);
    svc.send({
      from_id: "claude@local.lab",
      to: "codex@remote.lab",
      type: "message",
      body: "should not reach an unverified peer",
      home,
    });

    const failed = await pushPending(home, { domain: "remote.lab" });
    expect(failed.pushed).toBe(0);
    expect(failed.push_failed).toBe(1);
    expect(failed.errors.join(" ")).toMatch(
      /self.signed|unable to verify|certificate/i,
    );

    // Pinning the CA on the existing peer makes the next send succeed.
    // (The failed row is in retry backoff, so assert on a fresh message.)
    setPeerCaFile(home, "remote.lab", pem.cert);
    const second = svc.send({
      from_id: "claude@local.lab",
      to: "codex@remote.lab",
      type: "message",
      body: "reaches the peer once its CA is pinned",
      home,
    });
    const retried = await pushPending(home, { domain: "remote.lab" });
    expect(retried.errors).toEqual([]);
    expect(retried.pushed).toBe(1);
    expect(
      svc.inbox("codex@remote.lab", { home: peerHome }).map((i) => i.message.id),
    ).toContain(second.id);
  });

  it("runs doctor --wake against a real HTTPS Hub with a pinned CA", async () => {
    const home = svc.initProject(path.join(tmp, "doctor", ".agent-mail"));
    const pem = makeLoopbackPemPair(tmp, "hub-doctor");
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
      requireAuth: true,
    });
    closers.push(() => hub.server.close());

    const tokenFile = path.join(tmp, "doctor-token");
    fs.writeFileSync(tokenFile, `${mintToken(home, "codex@local")}\n`, {
      mode: 0o600,
    });
    setConnection(home, {
      hub_url: hub.url,
      token_file: tokenFile,
      ca_file: pem.cert,
    });

    // Cell 4: product doctor probe → real TLS Hub.
    const pinned = await runDoctor(home, { wake: true, hubUrl: hub.url });
    const health = pinned.checks.find((c) => c.id === "hub.health");
    expect(health?.status, JSON.stringify(health)).toBe("pass");

    // Without the CA the probe must fail closed rather than skip verification.
    setConnection(home, { ca_file: "" });
    const unpinned = await runDoctor(home, { wake: true, hubUrl: hub.url });
    const failed = unpinned.checks.find((c) => c.id === "hub.health");
    expect(failed?.status).toBe("fail");
    expect(failed?.message).toMatch(/self.signed|unable to verify|certificate/i);
  });

  it("stops a trickling peer at the overall deadline, not just on idle", async () => {
    // The callers previously used AbortSignal.timeout, an absolute deadline.
    // node:https `timeout` only covers inactivity, so a peer that dribbles one
    // byte per interval would never trip it; outboundRequest keeps both.
    const timers: NodeJS.Timeout[] = [];
    const trickling = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"envelopes":[');
      timers.push(setInterval(() => res.write(" "), 20));
    });
    await new Promise<void>((resolve) =>
      trickling.listen(0, "127.0.0.1", resolve),
    );
    const port = (trickling.address() as AddressInfo).port;
    try {
      const started = Date.now();
      await expect(
        outboundRequest(`http://127.0.0.1:${port}/v1/federation/pull`, {
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const timer of timers) clearInterval(timer);
      await new Promise<void>((resolve) => trickling.close(() => resolve()));
    }
  });

  it("aborts an in-flight remote bridge long poll", async () => {
    const stalled = http.createServer(() => {
      // Keep the product request open until the caller cancels it.
    });
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", resolve),
    );
    const port = (stalled.address() as AddressInfo).port;
    const controller = new AbortController();
    const started = Date.now();
    try {
      const pending = pollHubEvents({
        home: tmp,
        recipient: "grok@local",
        consumerId: "wake:abort:grok@local",
        runner: "none",
        hubUrl: `http://127.0.0.1:${port}`,
        hubToken: "fixture-token",
        waitSeconds: 0,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 25);
      await expect(pending).rejects.toThrow(/aborted/i);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it("polls the wake outbox over HTTPS when the Hub CA is pinned", async () => {
    const home = svc.initProject(path.join(tmp, "sse", ".agent-mail"));
    const pem = makeLoopbackPemPair(tmp, "hub-sse");
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
    });
    closers.push(() => hub.server.close());

    const message = svc.send({
      from_id: "codex@local",
      to: "grok@local",
      type: "message",
      body: "wake doorbell over a private CA",
      home,
    });
    const token = mintToken(home, "grok@local");
    const options = {
      home,
      recipient: "grok@local",
      consumerId: "wake:test:grok@local",
      runner: "none" as const,
      hubUrl: hub.url,
      hubToken: token,
      waitSeconds: 0,
    };

    // Cell 3: product bridge SSE client → real TLS Hub.
    const events = await pollHubEvents(
      { ...options, hubCaFile: pem.cert },
      10,
    );
    expect(events.map((e) => e.message_id)).toContain(message.id);
    expect(events.every((e) => e.recipient === "grok@local")).toBe(true);

    await expect(pollHubEvents(options, 10)).rejects.toThrow(
      /self.signed|unable to verify|certificate/i,
    );
  });
});
