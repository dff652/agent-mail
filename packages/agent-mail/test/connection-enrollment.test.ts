import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectionEnrollmentManager,
} from "../src/connection-enrollment.js";
import {
  EnrollmentClientError,
  type EnrollmentHubValue,
  type EnrollmentTransport,
} from "../src/enrollment-client.js";
import {
  loadConnection,
  loadConnectionSnapshot,
  setConnection,
} from "../src/connection.js";
import { initProject } from "../src/services.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(prefix = "connection-enrollment-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return initProject(path.join(root, ".agent-mail"));
}

function tokenPath(h: string): string {
  return path.join(h, "auth", "enrollment");
}

function remote(overrides: Partial<EnrollmentHubValue> = {}): EnrollmentHubValue {
  return {
    enrollment_id: "enroll_0123456789abcdef0123456789abcdef",
    agent_id: "joined@local",
    token: "issued-token-for-joined",
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    verified_at: new Date().toISOString(),
    state: "pending_save",
    ...overrides,
  };
}

interface FakeTransportOptions {
  redeem?: () => EnrollmentHubValue | Promise<EnrollmentHubValue>;
  recover?: () => EnrollmentHubValue | Promise<EnrollmentHubValue>;
  status?: () => EnrollmentHubValue | Promise<EnrollmentHubValue>;
  commit?: () => EnrollmentHubValue | Promise<EnrollmentHubValue>;
  cancel?: () => EnrollmentHubValue | Promise<EnrollmentHubValue>;
}

function fakeTransport(options: FakeTransportOptions = {}): EnrollmentTransport {
  return {
    verify: async () => ({ tls_verified: true, status: 401 }),
    verifyIdentity: async ({ expected_agent_id }) => ({ agent_id: expected_agent_id }),
    redeem: async () => options.redeem ? options.redeem() : remote(),
    recover: async () => options.recover ? options.recover() : remote(),
    status: async () => options.status ? options.status() : remote(),
    commit: async () => options.commit ? options.commit() : remote({ state: "committed" }),
    cancel: async () => options.cancel ? options.cancel() : remote({ state: "cancelled" }),
  };
}

async function pending(manager: ConnectionEnrollmentManager) {
  const context = await manager.begin({ endpoint: "https://hub.example" });
  const enrolled = await manager.redeem({
    context_handle: context.context_handle,
    request_id: randomUUID(),
    code: "ABCD-EFGH",
  });
  return { context, enrolled };
}

describe("provider connection enrollment manager", () => {
  it("recovers a lost redeem response with the same request and proof", async () => {
    const h = home();
    let redeemCalls = 0;
    const transport = fakeTransport({
      redeem: async () => {
        redeemCalls += 1;
        throw new EnrollmentClientError("hub_unreachable", {
          retryable: true,
          unknownOutcome: true,
        });
      },
    });
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    });
    const context = await manager.begin({ endpoint: "https://hub.example" });
    const requestId = randomUUID();
    await expect(manager.redeem({
      context_handle: context.context_handle,
      request_id: requestId,
      code: "ABCD-EFGH",
    })).rejects.toMatchObject({ code: "hub_unreachable", unknown_outcome: true });
    const journal = JSON.parse(fs.readFileSync(manager.journalPath, "utf8")) as {
      entries: Array<{ enrollment_handle: string }>;
    };
    const recovered = await manager.status({ enrollment_handle: journal.entries[0]!.enrollment_handle });
    expect(redeemCalls).toBe(1);
    expect(recovered).toMatchObject({
      state: "pending_save",
      save_state: "unsaved",
      agent_id: "joined@local",
    });
  });

  it("keeps a provisional config until a lost commit reply is reconciled", async () => {
    const h = home();
    const transportState = { commitCalls: 0, committed: false };
    const transport = fakeTransport({
      commit: async () => {
        transportState.commitCalls += 1;
        if (transportState.commitCalls === 1) {
          throw new EnrollmentClientError("hub_unreachable", {
            retryable: true,
            unknownOutcome: true,
          });
        }
        transportState.committed = true;
        return remote({ state: "committed" });
      },
      status: async () => remote({ state: transportState.committed ? "committed" : "pending_save" }),
    });
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    });
    const { context, enrolled } = await pending(manager);
    const commitId = randomUUID();
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
      commit_id: commitId,
    })).rejects.toMatchObject({ code: "hub_unreachable", unknown_outcome: true });
    expect(loadConnection(h)).toMatchObject({ hub_url: "https://hub.example" });
    expect((await manager.status({ enrollment_handle: enrolled.enrollment_handle })).state).toBe("commit_in_progress");
    const saved = await manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
      commit_id: commitId,
    });
    expect(transportState.commitCalls).toBe(2);
    expect(saved).toMatchObject({ state: "saved", save_state: "saved" });
    await manager.activate({
      enrollment_handle: enrolled.enrollment_handle,
      evidence: {
        effective_hub_url: "https://hub.example",
        agent_id: enrolled.agent_id,
        route_verified: true,
      },
    });
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
      commit_id: commitId,
    })).resolves.toMatchObject({ state: "active", commit_id: commitId });
    expect(transportState.commitCalls).toBe(2);
  });

  it("restores the exact prior connection when Hub commit definitely expires", async () => {
    const h = home();
    const priorToken = path.join(h, "prior.token");
    fs.writeFileSync(priorToken, "prior-secret\n", { mode: 0o600 });
    setConnection(h, { hub_url: "https://prior.example", token_file: priorToken });
    const before = loadConnectionSnapshot(h);
    const transport = fakeTransport({
      commit: async () => {
        throw new EnrollmentClientError("context_expired");
      },
    });
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    });
    const { context, enrolled } = await pending(manager);
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
    })).rejects.toMatchObject({ code: "context_expired" });
    expect(loadConnectionSnapshot(h).settings).toEqual(before.settings);
    expect(fs.readdirSync(tokenPath(h))).toHaveLength(0);
    expect((await manager.status({ enrollment_handle: enrolled.enrollment_handle })).cleanup_state)
      .toBe("complete");
    expect((await manager.status({ enrollment_handle: enrolled.enrollment_handle })).state).toBe("expired");
    await expect(manager.cancel({ enrollment_handle: enrolled.enrollment_handle }))
      .resolves.toMatchObject({ state: "expired", cleanup_state: "complete" });
  });

  it("propagates remote cleanup states and retains custody", async () => {
    const h = home();
    let cleanup: "cleanup_pending" | "cleanup_conflict" = "cleanup_pending";
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport: fakeTransport({ cancel: async () => remote({ state: cleanup }) }),
    });
    const { enrolled } = await pending(manager);
    await expect(manager.cancel({ enrollment_handle: enrolled.enrollment_handle }))
      .rejects.toMatchObject({ code: "cleanup_pending" });
    expect(fs.readdirSync(tokenPath(h))).toHaveLength(1);
    cleanup = "cleanup_conflict";
    await expect(manager.cancel({ enrollment_handle: enrolled.enrollment_handle }))
      .rejects.toMatchObject({ code: "cleanup_conflict" });
    expect(fs.readdirSync(tokenPath(h))).toHaveLength(1);
    expect((await manager.status({ enrollment_handle: enrolled.enrollment_handle })).cleanup_state).toBe("conflict");
  });

  it("serializes a cross-manager commit/cancel race without deleting a committed token", async () => {
    const h = home();
    let releaseCommit!: () => void;
    let commitStarted!: () => void;
    const started = new Promise<void>((resolve) => { commitStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const transport = fakeTransport({
      commit: async () => {
        commitStarted();
        await gate;
        return remote({ state: "committed" });
      },
      cancel: async () => remote({ state: "committed" }),
    });
    const options = {
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    } as const;
    const first = new ConnectionEnrollmentManager(options);
    const second = new ConnectionEnrollmentManager(options);
    const { context, enrolled } = await pending(first);
    const commit = first.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
      commit_id: randomUUID(),
    });
    await started;
    const cancel = second.cancel({ enrollment_handle: enrolled.enrollment_handle });
    releaseCommit();
    await expect(cancel).rejects.toMatchObject({ code: "cleanup_conflict" });
    await expect(commit).resolves.toMatchObject({ state: "saved" });
    expect(loadConnection(h).hub_url).toBe("https://hub.example");
    expect(fs.readdirSync(tokenPath(h))).toHaveLength(1);
  });

  it("serializes same-enrollment commits across manager instances", async () => {
    const h = home();
    let commitCalls = 0;
    let releaseCommit!: () => void;
    let commitStarted!: () => void;
    const started = new Promise<void>((resolve) => { commitStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const transport = fakeTransport({
      commit: async () => {
        commitCalls += 1;
        commitStarted();
        await gate;
        return remote({ state: "committed" });
      },
    });
    const options = {
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    } as const;
    const first = new ConnectionEnrollmentManager(options);
    const second = new ConnectionEnrollmentManager(options);
    const { context, enrolled } = await pending(first);
    const commitId = randomUUID();
    const firstCommit = first.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
      commit_id: commitId,
    });
    await started;
    const secondCommit = second.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
      commit_id: commitId,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(commitCalls).toBe(1);
    releaseCommit();
    await expect(firstCommit).resolves.toMatchObject({ state: "saved" });
    await expect(secondCommit).resolves.toMatchObject({ state: "saved" });
    expect(commitCalls).toBe(1);
  });

  it("recaptures an administrator edit for a second definite commit failure", async () => {
    const h = home();
    const transport = fakeTransport({
      commit: async () => {
        throw new EnrollmentClientError("identity_mismatch");
      },
    });
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    });
    const { context, enrolled } = await pending(manager);
    const before = loadConnectionSnapshot(h);
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
    })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(loadConnectionSnapshot(h).settings).toEqual(before.settings);
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
    })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(loadConnectionSnapshot(h).settings).toEqual(before.settings);
  });

  it("keeps the Hub handle usable after identity verification fails", async () => {
    const h = home();
    let verifyCalls = 0;
    let recoverCalls = 0;
    let statusCalls = 0;
    let cancelCalls = 0;
    const base = fakeTransport({
      recover: async () => {
        recoverCalls += 1;
        return remote();
      },
      status: async () => {
        statusCalls += 1;
        return remote({ state: "pending_save" });
      },
      cancel: async () => {
        cancelCalls += 1;
        return remote({ state: "cancelled" });
      },
    });
    const transport: EnrollmentTransport = {
      ...base,
      verifyIdentity: async () => {
        verifyCalls += 1;
        return { agent_id: "other@local" };
      },
    };
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    });
    const context = await manager.begin({ endpoint: "https://hub.example" });
    await expect(manager.redeem({
      context_handle: context.context_handle,
      request_id: randomUUID(),
      code: "ABCD-EFGH",
    })).rejects.toMatchObject({ code: "identity_mismatch" });
    const journal = JSON.parse(fs.readFileSync(manager.journalPath, "utf8")) as {
      entries: Array<{ enrollment_handle: string; hub_enrollment_id: string }>;
    };
    const handle = journal.entries[0]!.enrollment_handle;
    expect(journal.entries[0]!.hub_enrollment_id).toMatch(/^enroll_/);
    const state = await manager.status({ enrollment_handle: handle });
    expect(state.state).toBe("redeem_in_progress");
    expect(statusCalls).toBe(1);
    expect(recoverCalls).toBe(0);
    expect(verifyCalls).toBe(1);
    await expect(manager.cancel({ enrollment_handle: handle }))
      .resolves.toMatchObject({ state: "cancelled", cleanup_state: "complete" });
    expect(cancelCalls).toBe(1);
    expect(recoverCalls).toBe(0);
    expect(verifyCalls).toBe(1);
  });

  it("rebases a pre-Hub retry on the current connection revision", async () => {
    const h = home();
    const transport = fakeTransport({
      commit: async () => {
        throw new EnrollmentClientError("identity_mismatch");
      },
    });
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport,
    });
    const { context, enrolled } = await pending(manager);
    const adminToken = path.join(h, "admin.token");
    fs.writeFileSync(adminToken, "admin-secret\n", { mode: 0o600 });
    setConnection(h, { hub_url: "https://admin.example", token_file: adminToken });
    const adminRaw = fs.readFileSync(path.join(h, "connection.json"), "utf8");
    const adminRevision = loadConnectionSnapshot(h).revision;
    const journal = JSON.parse(fs.readFileSync(manager.journalPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = journal.entries[0]!;
    entry.state = "commit_in_progress";
    entry.save_state = "error";
    entry.commit_id = randomUUID();
    entry.expected_config_revision = context.observed_config_revision;
    entry.previous_connection_captured = true;
    entry.previous_connection_contents = null;
    entry.provisional_config_revision = null;
    fs.writeFileSync(manager.journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: adminRevision,
      confirmed_agent_id: enrolled.agent_id,
      commit_id: entry.commit_id as string,
    })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(fs.readFileSync(path.join(h, "connection.json"), "utf8")).toBe(adminRaw);
  });

  it("persists expiry when redeem starts after the context TTL", async () => {
    const h = home();
    let current = new Date("2026-09-09T00:00:00.000Z");
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      contextTtlMs: 1_000,
      now: () => current,
      transport: fakeTransport(),
    });
    const context = await manager.begin({ endpoint: "https://hub.example" });
    current = new Date(Date.parse(context.expires_at) + 1);
    await expect(manager.redeem({
      context_handle: context.context_handle,
      request_id: randomUUID(),
      code: "ABCD-EFGH",
    })).rejects.toMatchObject({ code: "context_expired" });
    const journal = JSON.parse(fs.readFileSync(manager.journalPath, "utf8")) as {
      entries: Array<{ state: string; last_error: { code: string } | null }>;
    };
    expect(journal.entries[0]).toMatchObject({
      state: "expired",
      last_error: { code: "context_expired" },
    });
  });

  it("binds profile and trust policy on every operation", async () => {
    const h = home();
    const ca = path.join(h, "hub-ca.pem");
    fs.writeFileSync(ca, "first-ca\n", { mode: 0o600 });
    const transport = fakeTransport();
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      targetProfileHandle: "profile-a",
      trustProfileHandle: "trust-a",
      caFile: ca,
      transport,
    });
    const context = await manager.begin({ endpoint: "https://hub.example" });
    const otherProfile = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      targetProfileHandle: "profile-b",
      trustProfileHandle: "trust-a",
      caFile: ca,
      transport,
    });
    await expect(otherProfile.status({ enrollment_handle: context.context_handle }))
      .rejects.toMatchObject({ code: "management_denied" });
    fs.writeFileSync(ca, "changed-ca\n", { mode: 0o600 });
    await expect(manager.redeem({
      context_handle: context.context_handle,
      request_id: randomUUID(),
      code: "ABCD-EFGH",
    })).rejects.toMatchObject({ code: "tls_untrusted" });
  });

  it("does not call Hub when the staged credential cannot be read", async () => {
    const h = home();
    const priorToken = path.join(h, "prior.token");
    fs.writeFileSync(priorToken, "prior-secret\n", { mode: 0o600 });
    setConnection(h, { hub_url: "https://prior.example", token_file: priorToken });
    const before = loadConnectionSnapshot(h);
    let commitCalls = 0;
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport: fakeTransport({
        commit: async () => {
          commitCalls += 1;
          return remote({ state: "committed" });
        },
      }),
    });
    const { context, enrolled } = await pending(manager);
    const custody = path.join(h, "auth", "enrollment", `${enrolled.enrollment_handle}.token`);
    fs.unlinkSync(custody);
    fs.mkdirSync(custody);
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
    })).rejects.toMatchObject({ code: "save_failed" });
    expect(commitCalls).toBe(0);
    expect(loadConnectionSnapshot(h).settings).toEqual(before.settings);
  });

  it("uses the exact connection bytes for CAS after a manual edit", async () => {
    const h = home();
    let commitCalls = 0;
    const manager = new ConnectionEnrollmentManager({
      home: h,
      owner: "operator",
      allowedHubUrls: ["https://hub.example"],
      transport: fakeTransport({
        commit: async () => {
          commitCalls += 1;
          return remote({ state: "committed" });
        },
      }),
    });
    const { context, enrolled } = await pending(manager);
    const connection = path.join(h, "connection.json");
    fs.writeFileSync(connection, JSON.stringify({
      hub_url: "https://manual.example",
      token_file: "manual.token",
      ca_file: "",
      insecure_tls: false,
      note: "manual edit",
      set_at: "manual",
      // Reusing the old metadata revision cannot bypass the byte-derived CAS.
      revision: context.observed_config_revision,
    }, null, 2) + "\n", { mode: 0o600 });
    const manual = fs.readFileSync(connection, "utf8");
    await expect(manager.commit({
      enrollment_handle: enrolled.enrollment_handle,
      expected_config_revision: context.observed_config_revision,
      confirmed_agent_id: enrolled.agent_id,
    })).rejects.toMatchObject({ code: "config_conflict" });
    expect(commitCalls).toBe(0);
    expect(fs.readFileSync(connection, "utf8")).toBe(manual);
  });
});
