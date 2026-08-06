import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  listDeadLetters,
  listPendingForPeer,
  recordPushFailure,
  requeueDead,
  STATUS_DEAD,
  STATUS_PENDING,
} from "../src/federation/outbox.js";
import {
  addPeer,
  getPeer,
  setLocalDomain,
  setPeerOutboundToken,
} from "../src/federation/peers.js";
import {
  listPullDeadLetters,
  pullDlqPath,
  recordPullFailure,
} from "../src/federation/pull-dlq.js";
import {
  buildHealthSnapshot,
  pullFromPeer,
  MAX_FEDERATION_PULL_RESPONSE_BYTES,
  pushPending,
  readHealthSnapshot,
  runWorker,
  syncOnce,
  writeHealthSnapshot,
  healthPath,
} from "../src/federation/worker.js";
import { listenHub } from "../src/hub/server.js";
import * as svc from "../src/services.js";

function addAgent(home: string, id: string) {
  const p = path.join(home, "agents.json");
  const roster = JSON.parse(fs.readFileSync(p, "utf8")) as {
    agents: Array<{ id: string; display_name: string; skills: string[] }>;
  };
  if (!roster.agents.some((a) => a.id === id)) {
    roster.agents.push({
      id,
      display_name: id.split("@")[0] || id,
      skills: ["lab"],
    });
    fs.writeFileSync(p, JSON.stringify(roster, null, 2));
  }
}

describe("federation worker DLQ + health", () => {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-w-"));
  const homeA = svc.initProject(path.join(tmp, "a", ".agent-mail"));
  const homeB = svc.initProject(path.join(tmp, "b", ".agent-mail"));
  let closeA: (() => void) | null = null;
  let closeB: (() => void) | null = null;

  it("supports bounded ticks and abortable daemon mode", async () => {
    const home = svc.initProject(path.join(tmp, "worker-loop", ".agent-mail"));
    const bounded = await runWorker(home, { maxTicks: 2, intervalMs: 100 });
    expect(bounded.errors).toEqual([
      "local_domain not configured",
      "local_domain not configured",
    ]);

    const controller = new AbortController();
    const daemon = runWorker(home, {
      maxTicks: null,
      intervalMs: 100,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    const stopped = await daemon;
    expect(stopped.errors.length).toBeGreaterThanOrEqual(1);
    await expect(
      runWorker(home, { maxTicks: 0, intervalMs: 100 }),
    ).rejects.toThrow(/ticks/);
  });

  it("completes two-sided peer bootstrap without printing the stored token", () => {
    const home = svc.initProject(
      path.join(tmp, "peer-bootstrap", ".agent-mail"),
    );
    addPeer(home, {
      domain: "remote.lab",
      base_url: "http://127.0.0.1:7421",
      push_enabled: true,
    });
    const outbound = "peer-bootstrap-secret";
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(packageRoot, "src/cli.ts"),
        "federation",
        "peer-set-outbound",
        "--domain",
        "remote.lab",
        "--outbound-token",
        outbound,
        "--path",
        path.dirname(home),
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      domain: "remote.lab",
      outbound_token: "[set]",
    });
    expect(result.stdout).not.toContain(outbound);
    expect(getPeer(home, "remote.lab")?.outbound_token).toBe(outbound);
  });

  it("recordPushFailure dead-letters after max attempts", () => {
    setLocalDomain(homeA, "alice.lab");
    addPeer(homeA, {
      domain: "bob.lab",
      base_url: "http://127.0.0.1:9",
      push_enabled: true,
    });
    addAgent(homeA, "claude@alice.lab");
    svc.send({
      from_id: "claude@alice.lab",
      to: "codex@bob.lab",
      type: "message",
      body: "will fail push",
      home: homeA,
    });
    const pending = listPendingForPeer(homeA, "bob.lab");
    expect(pending.length).toBe(1);
    const mid = pending[0].message_id;
    let status = STATUS_PENDING;
    for (let i = 0; i < 3; i++) {
      status = recordPushFailure(homeA, mid, "bob.lab", "net down", 3);
    }
    expect(status).toBe(STATUS_DEAD);
    const dead = listDeadLetters(homeA);
    expect(dead.some((d) => d.message_id === mid)).toBe(true);
    const requeued = requeueDead(homeA, { messageIds: [mid] });
    expect(requeued).toEqual([mid]);
    expect(listPendingForPeer(homeA, "bob.lab").length).toBe(1);
  });

  it("syncOnce push+pull writes health snapshot", async () => {
    setLocalDomain(homeA, "alice.lab");
    setLocalDomain(homeB, "bob.lab");
    addAgent(homeA, "claude@alice.lab");
    addAgent(homeB, "codex@bob.lab");

    const hubA = await listenHub({ home: homeA, host: "127.0.0.1", port: 0 });
    const hubB = await listenHub({ home: homeB, host: "127.0.0.1", port: 0 });
    closeA = () => hubA.server.close();
    closeB = () => hubB.server.close();

    const aToB = addPeer(homeA, {
      domain: "bob.lab",
      base_url: hubB.url,
      push_enabled: true,
    });
    const bToA = addPeer(homeB, {
      domain: "alice.lab",
      base_url: hubA.url,
      push_enabled: true,
    });
    setPeerOutboundToken(homeA, "bob.lab", bToA.inbound_token);
    setPeerOutboundToken(homeB, "alice.lab", aToB.inbound_token);

    svc.send({
      from_id: "claude@alice.lab",
      to: "codex@bob.lab",
      type: "task",
      body: "worker delivers",
      home: homeA,
      effect: "read",
    });

    const stats = await syncOnce(homeA, { limit: 20 });
    expect(stats.pushed).toBeGreaterThanOrEqual(1);
    expect(stats.errors).toEqual([]);
    expect(fs.existsSync(healthPath(homeA))).toBe(true);

    const inbox = svc.inbox("codex@bob.lab", { home: homeB });
    expect(inbox.some((i) => i.message.body_md.includes("worker delivers"))).toBe(
      true,
    );

    const snap = buildHealthSnapshot(homeA, { lastSync: stats });
    writeHealthSnapshot(homeA, snap);
    expect(snap.ok).toBe(true);
    expect((snap.outbox as { pending?: number }).pending ?? 0).toBe(0);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(healthPath(homeA))).mode & 0o777).toBe(
        0o700,
      );
      expect(fs.statSync(healthPath(homeA)).mode & 0o777).toBe(0o600);
      const outside = path.join(tmp, "outside-health");
      fs.writeFileSync(outside, "outside remains unchanged\n", "utf8");
      fs.unlinkSync(healthPath(homeA));
      fs.symlinkSync(outside, healthPath(homeA));
      expect(() => writeHealthSnapshot(homeA, snap)).toThrow(/real file/);
      expect(() => readHealthSnapshot(homeA)).toThrow(/real file/);
      expect(fs.readFileSync(outside, "utf8")).toBe(
        "outside remains unchanged\n",
      );
    }
  });

  it("pushPending to dead peer records failure without throw", async () => {
    const home = svc.initProject(path.join(tmp, "c", ".agent-mail"));
    setLocalDomain(home, "carol.lab");
    addAgent(home, "c@carol.lab");
    addPeer(home, {
      domain: "gone.lab",
      base_url: "http://127.0.0.1:1",
      push_enabled: true,
      outbound_token: "x".repeat(40),
    });
    // force outbound token
    setPeerOutboundToken(home, "gone.lab", "tok_for_gone");
    svc.send({
      from_id: "c@carol.lab",
      to: "x@gone.lab",
      type: "message",
      body: "no peer",
      home,
    });
    const stats = await pushPending(home, { maxAttempts: 2 });
    expect(stats.push_failed).toBeGreaterThanOrEqual(1);
  });

  it("dead-letters a repeated pull poison, acknowledges it, then requeues after repair", async () => {
    const source = svc.initProject(path.join(tmp, "pull-source", ".agent-mail"));
    const destination = svc.initProject(
      path.join(tmp, "pull-destination", ".agent-mail"),
    );
    setLocalDomain(source, "source.lab");
    setLocalDomain(destination, "destination.lab");
    addAgent(source, "source@source.lab");
    const sourcePeer = addPeer(source, {
      domain: "destination.lab",
      base_url: "http://127.0.0.1:9",
    });
    const sent = svc.send({
      from_id: "source@source.lab",
      to: "missing@destination.lab",
      type: "message",
      body: "private pull poison body",
      home: source,
    });
    const sourceHub = await listenHub({
      home: source,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      addPeer(destination, {
        domain: "source.lab",
        base_url: sourceHub.url,
      });
      setPeerOutboundToken(
        destination,
        "source.lab",
        sourcePeer.inbound_token,
      );
      const peer = getPeer(destination, "source.lab");
      expect(peer).not.toBeNull();

      const first = await pullFromPeer(
        destination,
        peer!,
        "destination.lab",
        10,
        { maxAttempts: 2 },
      );
      expect(first.pull_failed).toBe(1);
      expect(first.dead_lettered).toBe(0);
      expect(listPendingForPeer(source, "destination.lab")).toHaveLength(1);

      const second = await pullFromPeer(
        destination,
        peer!,
        "destination.lab",
        10,
        { maxAttempts: 2 },
      );
      expect(second.pull_failed).toBe(1);
      expect(second.dead_lettered).toBe(1);
      expect(second.acked).toBe(1);
      expect(listPendingForPeer(source, "destination.lab")).toHaveLength(0);

      const dead = listPullDeadLetters(destination);
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({
        direction: "pull",
        source_domain: "source.lab",
        message_id: sent.id,
        attempts: 2,
      });
      expect(JSON.stringify(dead)).not.toContain("private pull poison body");
      if (process.platform !== "win32") {
        expect(fs.statSync(pullDlqPath(destination)).mode & 0o777).toBe(0o600);
      }

      const runDlq = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            path.join(packageRoot, "src/cli.ts"),
            "federation",
            "dlq",
            ...args,
            "--path",
            path.dirname(destination),
          ],
          { cwd: packageRoot, encoding: "utf8" },
        );
      const listed = runDlq("list");
      expect(listed.status, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout).pull_items).toHaveLength(1);
      expect(listed.stdout).not.toContain("private pull poison body");

      addAgent(destination, "missing@destination.lab");
      const replayed = runDlq("requeue", "--id", sent.id);
      expect(replayed.status, replayed.stderr).toBe(0);
      expect(JSON.parse(replayed.stdout)).toMatchObject({
        pull_requeued: [sent.id],
        pull_errors: [],
      });
      expect(listPullDeadLetters(destination)).toEqual([]);
      expect(
        svc
          .inbox("missing@destination.lab", { home: destination })
          .some((item) => item.message.id === sent.id),
      ).toBe(true);
    } finally {
      sourceHub.server.close();
    }
  });

  it("refuses a symlink or wide-permission pull DLQ", () => {
    const symlinkHome = svc.initProject(
      path.join(tmp, "pull-dlq-symlink", ".agent-mail"),
    );
    const outside = path.join(tmp, "outside-pull-dlq.sqlite");
    fs.writeFileSync(outside, "outside stays unchanged");
    fs.symlinkSync(outside, pullDlqPath(symlinkHome));
    expect(() =>
      recordPullFailure(symlinkHome, {
        sourceDomain: "source.lab",
        messageId: "msg_pull_symlink",
        envelope: { message_id: "msg_pull_symlink" },
        error: "fixture",
        maxAttempts: 1,
      }),
    ).toThrow(/private regular file/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside stays unchanged");

    if (process.platform !== "win32") {
      const modeHome = svc.initProject(
        path.join(tmp, "pull-dlq-mode", ".agent-mail"),
      );
      recordPullFailure(modeHome, {
        sourceDomain: "source.lab",
        messageId: "msg_pull_mode",
        envelope: { message_id: "msg_pull_mode" },
        error: "fixture",
        maxAttempts: 1,
      });
      fs.chmodSync(pullDlqPath(modeHome), 0o644);
      expect(() => listPullDeadLetters(modeHome)).toThrow(/private/);
    }
  });

  it("bounds chunked pull responses and times out a stalled peer", async () => {
    const home = svc.initProject(path.join(tmp, "pull-limits", ".agent-mail"));
    setLocalDomain(home, "destination.lab");

    const oversizedServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"envelopes":["');
      const chunk = Buffer.alloc(64 * 1024, "x");
      for (
        let sent = 0;
        sent <= MAX_FEDERATION_PULL_RESPONSE_BYTES;
        sent += chunk.length
      ) {
        res.write(chunk);
      }
      res.end('"]}');
    });
    await new Promise<void>((resolve) =>
      oversizedServer.listen(0, "127.0.0.1", resolve),
    );
    const oversizedPort = (oversizedServer.address() as AddressInfo).port;
    addPeer(home, {
      domain: "oversized.lab",
      base_url: `http://127.0.0.1:${oversizedPort}`,
    });
    setPeerOutboundToken(home, "oversized.lab", "oversized-token");
    try {
      const peer = getPeer(home, "oversized.lab");
      const stats = await pullFromPeer(
        home,
        peer!,
        "destination.lab",
        10,
        { timeoutMs: 2_000 },
      );
      expect(stats.errors.join(" ")).toContain("response too large");
      expect(listPullDeadLetters(home)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => oversizedServer.close(() => resolve()));
    }

    const stalledServer = http.createServer(() => {
      // Deliberately leave the authenticated peer request unanswered.
    });
    await new Promise<void>((resolve) =>
      stalledServer.listen(0, "127.0.0.1", resolve),
    );
    const stalledPort = (stalledServer.address() as AddressInfo).port;
    addPeer(home, {
      domain: "stalled.lab",
      base_url: `http://127.0.0.1:${stalledPort}`,
    });
    setPeerOutboundToken(home, "stalled.lab", "stalled-token");
    try {
      const peer = getPeer(home, "stalled.lab");
      const started = performance.now();
      const stats = await pullFromPeer(
        home,
        peer!,
        "destination.lab",
        10,
        { timeoutMs: 100 },
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(stats.errors.join(" ")).toMatch(/timeout|abort/i);
    } finally {
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
    }
  });

  afterAll(() => {
    closeA?.();
    closeB?.();
  });
});
