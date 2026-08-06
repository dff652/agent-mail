import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { pullFromPeer, pushPendingToPeer } from "../src/federation/client.js";
import {
  addPeer,
  setLocalDomain,
  setPeerOutboundToken,
} from "../src/federation/peers.js";
import { listPendingForPeer } from "../src/federation/outbox.js";
import { listenHub } from "../src/hub/server.js";
import * as svc from "../src/services.js";

function addAgent(home: string, id: string, skills: string[] = ["lab"]) {
  const p = path.join(home, "agents.json");
  const roster = JSON.parse(fs.readFileSync(p, "utf8")) as {
    agents: Array<{ id: string; display_name: string; skills: string[] }>;
    version?: number;
    updated_at?: string;
  };
  if (!roster.agents.some((a) => a.id === id)) {
    roster.agents.push({
      id,
      display_name: id.split("@", 1)[0] || id,
      skills,
    });
    fs.writeFileSync(p, JSON.stringify(roster, null, 2));
  }
}

describe("Federation R4 dual-hub", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-fed-"));
  const homeA = svc.initProject(path.join(tmp, "alice", ".agent-mail"));
  const homeB = svc.initProject(path.join(tmp, "bob", ".agent-mail"));
  let urlA = "";
  let urlB = "";
  let closeA: (() => void) | null = null;
  let closeB: (() => void) | null = null;

  it("pairs alice.lab ↔ bob.lab and delivers via push", async () => {
    setLocalDomain(homeA, "alice.lab");
    setLocalDomain(homeB, "bob.lab");
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(homeA, "auth")).mode & 0o777).toBe(0o700);
      expect(
        fs.statSync(path.join(homeA, "auth", "federation_config.json")).mode &
          0o777,
      ).toBe(0o600);
    }

    // Domain-qualified agents (from_domain must match authenticated peer)
    addAgent(homeA, "claude@alice.lab", ["implement"]);
    addAgent(homeB, "codex@bob.lab", ["review"]);

    const hubA = await listenHub({ home: homeA, host: "127.0.0.1", port: 0 });
    const hubB = await listenHub({ home: homeB, host: "127.0.0.1", port: 0 });
    urlA = hubA.url;
    urlB = hubB.url;
    closeA = () => hubA.server.close();
    closeB = () => hubB.server.close();

    const aToB = addPeer(homeA, {
      domain: "bob.lab",
      base_url: urlB,
      push_enabled: true,
    });
    const bToA = addPeer(homeB, {
      domain: "alice.lab",
      base_url: urlA,
      push_enabled: true,
    });
    // Cross-wire outbound tokens (peer inbound)
    setPeerOutboundToken(homeA, "bob.lab", bToA.inbound_token);
    setPeerOutboundToken(homeB, "alice.lab", aToB.inbound_token);
    if (process.platform !== "win32") {
      expect(
        fs.statSync(path.join(homeA, "auth", "federation_peers.json")).mode &
          0o777,
      ).toBe(0o600);
      expect(
        fs.statSync(path.join(homeA, "auth", "federation_outbound.json")).mode &
          0o777,
      ).toBe(0o600);
    }

    const msg = svc.send({
      from_id: "claude@alice.lab",
      to: "codex@bob.lab",
      type: "task",
      body: "federated review please",
      home: homeA,
      effect: "read",
    });
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.task_id).toMatch(/^tsk_/);
    expect(msg.thread_id).toMatch(/^thr_/);
    expect(listPendingForPeer(homeA, "bob.lab").length).toBe(1);

    const peerBob = (
      await import("../src/federation/peers.js")
    ).getPeer(homeA, "bob.lab")!;
    const push = await pushPendingToPeer(homeA, peerBob);
    expect(push.errors).toEqual([]);
    expect(push.pushed).toBe(1);

    const inbox = svc.inbox("codex@bob.lab", { home: homeB });
    expect(inbox.length).toBe(1);
    expect(inbox[0].message.body_md).toContain("federated review");
    expect(inbox[0].message.id).toBe(msg.id);
    // task id preserved across federation (assignee hub owns lifecycle)
    expect(inbox[0].message.task_id).toBe(msg.task_id);
    expect(svc.getStore(homeB).getTaskStatus(msg.task_id!)).toBe("open");
  });

  it("pull path also works for reverse direction", async () => {
    addAgent(homeA, "claude@alice.lab", ["implement"]);
    addAgent(homeB, "codex@bob.lab", ["review"]);

    svc.send({
      from_id: "codex@bob.lab",
      to: "claude@alice.lab",
      type: "message",
      body: "ack from bob hub",
      home: homeB,
    });
    const peerAlice = (
      await import("../src/federation/peers.js")
    ).getPeer(homeA, "bob.lab")!;
    // Alice pulls messages destined to alice.lab from Bob
    const pull = await pullFromPeer(homeA, peerAlice, "alice.lab");
    expect(pull.errors).toEqual([]);
    expect(pull.imported + pull.duplicates).toBeGreaterThanOrEqual(1);
    const items = svc.inbox("claude@alice.lab", { home: homeA });
    expect(items.some((i) => i.message.body_md.includes("ack from bob"))).toBe(true);
  });

  it("federation pull rejects domain not matching peer token", async () => {
    const peerBob = (
      await import("../src/federation/peers.js")
    ).getPeer(homeA, "bob.lab")!;
    // Alice's outbound token is Bob's inbound; Alice must not pull as wrong domain
    const url = new URL(`${peerBob.base_url}/v1/federation/pull`);
    url.searchParams.set("domain", "evil.lab");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${peerBob.outbound_token}` },
    });
    expect(res.status).toBe(403);
  });

  afterAll(() => {
    closeA?.();
    closeB?.();
  });
});
