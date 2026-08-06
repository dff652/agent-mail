/**
 * Execute contracts/http/wire-contracts.json against the TypeScript Hub.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listPendingForPeer } from "../src/federation/outbox.js";
import { addPeer, setLocalDomain } from "../src/federation/peers.js";
import { mintToken } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import { createPairing } from "../src/pairing.js";
import * as svc from "../src/services.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const WIRE = JSON.parse(
  fs.readFileSync(path.join(REPO, "contracts/http/wire-contracts.json"), "utf8"),
) as {
  health: {
    method: string;
    path: string;
    success_status: number;
    required_fields: string[];
  };
  errors: { required_fields: string[] };
  pairing: {
    redeem: {
      method: string;
      path: string;
      success_status: number;
      required_response_fields: string[];
    };
  };
  mail: {
    send: {
      method: string;
      path: string;
      created_status: number;
      duplicate_status: number;
      required_response_fields: string[];
    };
    inbox_item_required_fields: string[];
    approval_required_fields: string[];
    task_terminal_created_status: number;
  };
  federation: {
    pull: {
      method: string;
      path: string;
      required_response_fields: string[];
    };
    ack: {
      method: string;
      path: string;
      required_response_fields: string[];
    };
    push: {
      method: string;
      path: string;
      imported_status: number;
      duplicate_status: number;
      domain_mismatch_status: number;
      required_response_fields: string[];
    };
  };
};

function addAgent(home: string, id: string): void {
  const rosterPath = path.join(home, "agents.json");
  const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8")) as {
    agents: Array<{ id: string; display_name: string; skills: string[] }>;
  };
  if (!roster.agents.some((agent) => agent.id === id)) {
    roster.agents.push({
      id,
      display_name: id.split("@")[0] || id,
      skills: ["wire-contract"],
    });
    fs.writeFileSync(rosterPath, `${JSON.stringify(roster, null, 2)}\n`);
  }
}

async function request(
  base: string,
  method: string,
  pathname: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

function expectFields(
  payload: Record<string, unknown>,
  fields: string[],
): void {
  for (const field of fields) expect(payload).toHaveProperty(field);
}

describe("wire-contracts.json (TypeScript Hub)", () => {
  it("matches health, Mail, approvals, terminal status, and federation shapes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-wire-ts-"));
    const home = svc.initProject(path.join(tmp, "mail", ".agent-mail"));
    const claude = mintToken(home, "claude-code@local");
    const codex = mintToken(home, "codex@local");
    const human = mintToken(home, "human@local");
    const hub = await listenHub({
      home,
      host: "127.0.0.1",
      port: 0,
      requireAuth: true,
    });
    try {
      const health = await request(
        hub.url,
        WIRE.health.method,
        WIRE.health.path,
        { token: claude },
      );
      expect(health.status).toBe(WIRE.health.success_status);
      expectFields(health.json, WIRE.health.required_fields);
      expect(health.json).not.toHaveProperty("home");

      const unauthorized = await request(hub.url, "GET", "/v1/mail/me");
      expect(unauthorized.status).toBe(401);
      expectFields(unauthorized.json, WIRE.errors.required_fields);

      const pairing = createPairing(home, "wire-pair@local");
      const redeemed = await request(
        hub.url,
        WIRE.pairing.redeem.method,
        WIRE.pairing.redeem.path,
        { body: { code: pairing.code } },
      );
      expect(redeemed.status).toBe(WIRE.pairing.redeem.success_status);
      expectFields(
        redeemed.json,
        WIRE.pairing.redeem.required_response_fields,
      );

      const body = {
        id: "msg_wire_typescript_task_01",
        to: "codex@local",
        type: "task",
        body: "wire contract task",
        effect: "write",
        requires_human_approval: true,
        doc_refs: ["docs/wire.md"],
      };
      const sent = await request(
        hub.url,
        WIRE.mail.send.method,
        WIRE.mail.send.path,
        { token: claude, body },
      );
      expect(sent.status).toBe(WIRE.mail.send.created_status);
      expectFields(sent.json, WIRE.mail.send.required_response_fields);
      expect(sent.json.doc_refs).toEqual(["docs/wire.md"]);
      expect(sent.json.requires_human_approval).toBe(true);

      const duplicate = await request(
        hub.url,
        WIRE.mail.send.method,
        WIRE.mail.send.path,
        { token: claude, body },
      );
      expect(duplicate.status).toBe(WIRE.mail.send.duplicate_status);
      expectFields(duplicate.json, WIRE.mail.send.required_response_fields);
      expect(duplicate.json.duplicate).toBe(true);

      const inbox = await request(hub.url, "GET", "/v1/mail/inbox", {
        token: codex,
      });
      const inboxItems = inbox.json.items as Array<Record<string, unknown>>;
      const item = inboxItems.find(
        (candidate) => candidate.message_id === sent.json.id,
      );
      expect(item).toBeDefined();
      expectFields(item!, WIRE.mail.inbox_item_required_fields);

      const approvals = await request(
        hub.url,
        "GET",
        "/v1/mail/approvals?status=pending",
        { token: human },
      );
      const approvalItems = approvals.json.items as Array<
        Record<string, unknown>
      >;
      const approval = approvalItems.find(
        (candidate) => candidate.id === sent.json.approval_id,
      );
      expect(approval).toBeDefined();
      expectFields(approval!, WIRE.mail.approval_required_fields);

      const plainTask = await request(
        hub.url,
        "POST",
        "/v1/mail/messages",
        {
          token: claude,
          body: {
            to: "codex@local",
            type: "task",
            body: "terminal status task",
          },
        },
      );
      await request(
        hub.url,
        "POST",
        `/v1/mail/messages/${String(plainTask.json.id)}/claim`,
        { token: codex, body: {} },
      );
      const done = await request(
        hub.url,
        "POST",
        `/v1/mail/tasks/${String(plainTask.json.task_id)}/done`,
        {
          token: codex,
          body: {
            to: "claude-code@local",
            thread_id: plainTask.json.thread_id,
            body: "done",
          },
        },
      );
      expect(done.status).toBe(WIRE.mail.task_terminal_created_status);
    } finally {
      hub.server.close();
    }

    const federationHome = svc.initProject(
      path.join(tmp, "federation", ".agent-mail"),
    );
    setLocalDomain(federationHome, "source.lab");
    addAgent(federationHome, "source@source.lab");
    const peer = addPeer(federationHome, {
      domain: "peer.lab",
      base_url: "http://127.0.0.1:9",
    });
    addPeer(federationHome, {
      domain: "other.lab",
      base_url: "http://127.0.0.1:9",
    });
    const outbound = svc.send({
      from_id: "source@source.lab",
      to: "target@peer.lab",
      type: "message",
      body: "federation wire contract",
      home: federationHome,
    });
    const otherOutbound = svc.send({
      from_id: "source@source.lab",
      to: "target@other.lab",
      type: "message",
      body: "must not be acked by peer.lab",
      home: federationHome,
    });
    const federationHub = await listenHub({
      home: federationHome,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const pull = await request(
        federationHub.url,
        WIRE.federation.pull.method,
        `${WIRE.federation.pull.path}?domain=peer.lab&after=0&limit=1`,
        { token: peer.inbound_token },
      );
      expect(pull.status).toBe(200);
      expectFields(pull.json, WIRE.federation.pull.required_response_fields);
      expect(
        (pull.json.envelopes as Array<Record<string, unknown>>)[0].message_id,
      ).toBe(outbound.id);

      const crossPeerAck = await request(
        federationHub.url,
        WIRE.federation.ack.method,
        WIRE.federation.ack.path,
        {
          token: peer.inbound_token,
          body: {
            message_ids: [otherOutbound.id],
            receiver_domain: "peer.lab",
          },
        },
      );
      expect(crossPeerAck.json.acked).toEqual([]);
      expect(
        listPendingForPeer(federationHome, "other.lab").map(
          (item) => item.message_id,
        ),
      ).toContain(otherOutbound.id);

      const ack = await request(
        federationHub.url,
        WIRE.federation.ack.method,
        WIRE.federation.ack.path,
        {
          token: peer.inbound_token,
          body: {
            message_ids: [outbound.id],
            receiver_domain: "peer.lab",
          },
        },
      );
      expect(ack.status).toBe(200);
      expectFields(ack.json, WIRE.federation.ack.required_response_fields);
      expect(ack.json.acked).toEqual([outbound.id]);
    } finally {
      federationHub.server.close();
    }

    const destinationHome = svc.initProject(
      path.join(tmp, "destination", ".agent-mail"),
    );
    setLocalDomain(destinationHome, "destination.lab");
    addAgent(destinationHome, "target@destination.lab");
    const sourcePeer = addPeer(destinationHome, {
      domain: "source.lab",
      base_url: "http://127.0.0.1:9",
    });
    const destinationHub = await listenHub({
      home: destinationHome,
      host: "127.0.0.1",
      port: 0,
    });
    const envelope = {
      message_id: "msg_wire_ts_push_01",
      from: "source@source.lab",
      to: "target@destination.lab",
      type: "message",
      body_md: "wire push",
      effect_level: "none",
      requires_human_approval: false,
      origin_domain: "source.lab",
    };
    try {
      const pushed = await request(
        destinationHub.url,
        WIRE.federation.push.method,
        WIRE.federation.push.path,
        {
          token: sourcePeer.inbound_token,
          body: { envelope },
        },
      );
      expect(pushed.status).toBe(WIRE.federation.push.imported_status);
      expectFields(
        pushed.json,
        WIRE.federation.push.required_response_fields,
      );
      expect(pushed.json.status).toBe("imported");

      const duplicate = await request(
        destinationHub.url,
        WIRE.federation.push.method,
        WIRE.federation.push.path,
        {
          token: sourcePeer.inbound_token,
          body: { envelope },
        },
      );
      expect(duplicate.status).toBe(WIRE.federation.push.duplicate_status);
      expect(duplicate.json.status).toBe("duplicate");

      const mismatch = await request(
        destinationHub.url,
        WIRE.federation.push.method,
        WIRE.federation.push.path,
        {
          token: sourcePeer.inbound_token,
          body: {
            envelope: { ...envelope, message_id: "msg_wire_ts_bad_domain", to: "x@other.lab" },
          },
        },
      );
      expect(mismatch.status).toBe(
        WIRE.federation.push.domain_mismatch_status,
      );
      expectFields(mismatch.json, WIRE.errors.required_fields);
    } finally {
      destinationHub.server.close();
    }
  });
});
