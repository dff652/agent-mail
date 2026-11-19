import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { coalesceEvents, executionMode } from "../src/domain/wake-gate.js";
import { mintToken } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import { readRuntimeLogs } from "../src/observability.js";
import * as svc from "../src/services.js";
import {
  pollAndProcessLocal,
  pollAndProcessLocalLive,
  runBridgeLoop,
} from "../src/wake/bridge.js";
import {
  ANTIGRAVITY_MCP_CONFIG,
  buildRunnerInvocation,
  preflightWakeRunner,
  runChildProcess,
  validateProjectMcpConfig,
  WAKE_COST_NOTICE,
  type RunnerResult,
  type WakeRunnerExecutor,
} from "../src/wake/runner.js";
import type { Delivery, Message } from "../src/models.js";

function tmpHome(): string {
  return svc.initProject(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "am-wake-")), ".agent-mail"),
  );
}

function runnerOk(): RunnerResult {
  return {
    exit_code: 0,
    duration_ms: 1,
    timed_out: false,
    cancelled: false,
    failure_class: null,
  };
}

function runnerSnapshot(body = "private body") {
  const message: Message = {
    id: "msg_runner",
    ts: new Date(),
    from_id: "claude-code@local",
    to: "codex@local",
    type: "task",
    thread_id: "thr_runner",
    in_reply_to: null,
    task_id: "tsk_runner",
    body_md: body,
    doc_refs: [],
    effect_level: "write",
    requires_human_approval: true,
    meta: {},
  };
  const delivery: Delivery = {
    id: "dlv_runner",
    message_id: message.id,
    recipient: message.to,
    status: "pending",
    claim_by: null,
    claim_until: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  return {
    message,
    delivery,
    task: null,
    approval: { status: "approved" },
  };
}

describe("wake dual-gate", () => {
  it("coalesce keeps latest sequence per message", () => {
    const out = coalesceEvents([
      { sequence: 1, id: "a", kind: "message.created", recipient: "r", message_id: "m1" },
      { sequence: 2, id: "b", kind: "message.created", recipient: "r", message_id: "m1" },
      { sequence: 3, id: "c", kind: "message.created", recipient: "r", message_id: "m2" },
    ]);
    expect(out.map((e) => e.sequence)).toEqual([2, 3]);
  });

  it("dangerous never auto-starts; write needs approval + allowWrite", () => {
    const baseMsg = {
      id: "msg_w1",
      ts: new Date(),
      from_id: "a@local",
      to: "b@local",
      type: "task" as const,
      thread_id: "thr_1",
      in_reply_to: null,
      task_id: "tsk_1",
      body_md: "x",
      doc_refs: [],
      effect_level: "write" as const,
      requires_human_approval: true,
      meta: {},
    };
    const delivery: Delivery = {
      id: "d1",
      message_id: "msg_w1",
      recipient: "b@local",
      status: "pending",
      claim_by: null,
      claim_until: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    expect(() =>
      executionMode(
        {
          message: { ...baseMsg, effect_level: "dangerous" },
          delivery,
          task: null,
          approval: null,
        },
        true,
      ),
    ).toThrow(/dangerous/);

    expect(() =>
      executionMode(
        { message: baseMsg, delivery, task: null, approval: null },
        true,
      ),
    ).toThrow(/approved/);

    expect(() =>
      executionMode(
        {
          message: baseMsg,
          delivery,
          task: null,
          approval: { status: "approved" },
        },
        false,
      ),
    ).toThrow(/allow-write/);

    expect(
      executionMode(
        {
          message: baseMsg,
          delivery,
          task: null,
          approval: { status: "approved" },
        },
        true,
      ),
    ).toBe("write");
  });
});

describe("wake outbox + bridge dry-run", () => {
  it("local send creates outbox event and dry-run plans read mode", () => {
    const home = tmpHome();
    const msg = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "please review",
      home,
      effect: "read",
    });
    const events = svc.listOutboxEvents("codex@local", { home });
    expect(events.length).toBe(1);
    expect(events[0].message_id).toBe(msg.id);
    expect(events[0].kind).toBe("message.created");

    const results = pollAndProcessLocal({
      home,
      recipient: "codex@local",
      consumerId: "wake:codex:codex@local",
      runner: "codex",
      dryRun: true,
    });
    expect(results.length).toBe(1);
    expect(results[0].action).toBe("run");
    expect(results[0].mode).toBe("read");
    expect(results[0].command?.[0]).toBe("codex");
  });

  it("approval decision appends a body-free wake event", () => {
    const home = tmpHome();
    const task = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "private write task body",
      home,
      effect: "write",
      requires_human_approval: true,
    });
    const approval = svc.getApprovalForTask(task.task_id!, { home });
    expect(approval).not.toBeNull();
    svc.approve(String(approval!.id), "human@local", {
      home,
      note: "private approval note",
    });

    const events = svc.listOutboxEvents("codex@local", { home });
    expect(events.map((event) => event.kind)).toEqual([
      "message.created",
      "approval.approved",
    ]);
    expect(events[1].payload).toEqual({
      approval_id: approval!.id,
      task_id: task.task_id,
      status: "approved",
    });
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain("private write task body");
    expect(encoded).not.toContain("private approval note");
  });

  it("ack advances consumer cursor", () => {
    const home = tmpHome();
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "hi",
      home,
    });
    const ev = svc.listOutboxEvents("codex@local", { home })[0];
    const cursor = svc.ackOutbox("wake:test:codex@local", "codex@local", ev.sequence, {
      home,
    });
    expect(cursor).toBe(ev.sequence);
    const again = svc.listOutboxEvents("codex@local", {
      home,
      consumerId: "wake:test:codex@local",
    });
    expect(again.length).toBe(0);
  });

  it("hub /v1/events and /v1/outbox/ack work with token", async () => {
    const home = tmpHome();
    const token = mintToken(home, "codex@local");
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "hub wake",
      home,
    });
    const hub = await listenHub({ home, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(
        `${hub.url}/v1/events?recipient=codex@local&consumer=wake:hub:codex@local&limit=10`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number; events: Array<{ sequence: number }> };
      expect(body.count).toBeGreaterThanOrEqual(1);
      const seq = body.events[0].sequence;
      const ack = await fetch(`${hub.url}/v1/outbox/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          consumer_id: "wake:hub:codex@local",
          recipient: "codex@local",
          sequence: seq,
        }),
      });
      expect(ack.status).toBe(200);
    } finally {
      hub.server.close();
    }
  });
});

describe("wake runner adapters", () => {
  it.each([
    ["codex", "read", "read-only"],
    ["codex", "write", "workspace-write"],
    ["grok", "read", "read-only"],
    ["grok", "write", "workspace"],
    ["claude", "read", "dontAsk"],
    ["claude", "write", "acceptEdits"],
  ] as const)(
    "%s %s command is constrained and contains no message body",
    (runner, mode, expected) => {
      const snapshot = runnerSnapshot("do not copy this private body");
      const invocation = buildRunnerInvocation(
        {
          home: "/tmp/project/.agent-mail",
          project: "/tmp/project",
          recipient: "codex@local",
          runner,
        },
        { kind: "approval.approved", message_id: snapshot.message.id },
        snapshot,
        mode,
      );
      const encoded = JSON.stringify(invocation);
      expect(encoded).toContain(expected);
      expect(encoded).toContain(snapshot.message.id);
      expect(encoded).not.toContain(snapshot.message.body_md);
      expect(encoded).not.toContain("bypassPermissions");
      expect(encoded).not.toContain("dangerously");
      if (runner === "grok" && mode === "read") {
        expect(encoded).not.toContain('"Edit"');
        expect(encoded).not.toContain('"Write"');
      }
      if (runner === "claude") {
        expect(invocation.command).toContain("--strict-mcp-config");
        expect(invocation.command).toContain("Bash");
      }
    },
  );

  it.each(["read", "write"] as const)("constrains agy print mode for %s wakes", (mode) => {
    const snapshot = runnerSnapshot("do not leak this task body");
    const invocation = buildRunnerInvocation(
      {
        home: "/tmp/project/.agent-mail",
        project: "/tmp/project",
        recipient: "antigravity@local",
        runner: "antigravity",
        executable: mode === "write" ? "/custom/bin/agy" : undefined,
      },
      { kind: "message.created", message_id: snapshot.message.id },
      snapshot,
      mode,
    );
    const [binary, sandbox, settingsFlag, settingsJson, format, json, disableSlash, print, prompt] =
      invocation.command;
    expect(binary).toBe(mode === "write" ? "/custom/bin/agy" : "agy");
    expect([sandbox, settingsFlag, format, json, disableSlash, print]).toEqual([
      "--sandbox", "--settings", "--output-format", "json", "--disable-slash-commands", "-p",
    ]);
    expect(invocation.stdin).toBeNull();
    expect(prompt).toContain(snapshot.message.id);
    expect(prompt).toContain("only ack the preclaimed delivery, report a summary, and exit");
    expect(prompt).toContain("Never send a new task automatically in response");
    expect(prompt).not.toContain(snapshot.message.body_md);
    expect(JSON.parse(settingsJson)).toMatchObject({
      agentMode: mode === "write" ? "accept-edits" : "",
      toolPermission: "request-review",
      allowNonWorkspaceAccess: false,
      permissions: {
        allow: expect.arrayContaining([
          "mcp(agent-mail_agent-mail/comm_send)",
          "mcp(agent-mail_agent-mail/comm_ack)",
        ]),
        deny: expect.arrayContaining([
          "command(*)",
          mode === "read" ? "write_file(*)" : "write_file(.agent-mail/)",
        ]),
      },
    });
    expect(settingsJson).not.toContain("mcp(*)");
    expect(invocation.command).not.toContain("--dangerously-skip-permissions");
    if (mode === "write") expect(settingsJson).not.toContain("write_file(*)");
  });

  it("preflights only the native Antigravity plugin's local MCP configuration", () => {
    const home = tmpHome();
    const project = path.dirname(home);
    const recipient = "antigravity@local";
    const config = { home, project, recipient, runner: "antigravity" as const };
    const configPath = path.join(project, ANTIGRAVITY_MCP_CONFIG);
    const server = {
      command: process.execPath,
      args: [path.join(project, "dist", "mcp", "stdio.js")],
      env: { AGENT_MAIL_HOME: home, AGENT_MAIL_ID: recipient },
    };
    expect(() => validateProjectMcpConfig(config)).toThrow(/mcp_config\.json/);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const writeConfig = (servers: object) =>
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }));
    writeConfig({ "agent-mail": server });
    expect(() => preflightWakeRunner({ ...config, executable: process.execPath })).not.toThrow();
    expect(() => preflightWakeRunner({ ...config, executable: project })).toThrow(/not a file/);
    expect(() => validateProjectMcpConfig({ ...config, recipient: "codex@local" })).toThrow(/identity mismatch/);
    writeConfig({ "agent-mail": { ...server, env: { ...server.env, AGENT_MAIL_HOME: project } } });
    expect(() => validateProjectMcpConfig(config)).toThrow(/HOME does not match/);
    writeConfig({ "agent-mail": { ...server, disabled: true } });
    expect(() => validateProjectMcpConfig(config)).toThrow(/disabled/);
    writeConfig({ "agent-mail": { ...server, url: "https://example.invalid" } });
    expect(() => validateProjectMcpConfig(config)).toThrow(/local agent-mail MCP server/);
    writeConfig({ "agent-mail": server, other: server });
    expect(() => validateProjectMcpConfig(config)).toThrow(/one local agent-mail MCP server/);
    fs.writeFileSync(configPath, "{broken");
    expect(() => validateProjectMcpConfig(config)).toThrow(/invalid project Agent Mail MCP config/);
  });

  it.each(["codex", "grok", "claude"] as const)(
    "%s preflight binds project, home, executable, and identity",
    (runner) => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-preflight-"));
      const home = svc.initProject(path.join(project, ".agent-mail"));
      const recipient =
        runner === "grok"
          ? "grok@local"
          : runner === "claude"
            ? "claude-code@local"
            : "codex@local";
      const typescriptServer = path.join(
        project,
        "dist",
        "mcp",
        "stdio.js",
      );
      if (runner === "claude") {
        fs.writeFileSync(
          path.join(project, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              "agent-mail": {
                command: process.execPath,
                args: [typescriptServer],
                env: {
                  AGENT_MAIL_HOME: home,
                  AGENT_MAIL_ID: recipient,
                },
              },
            },
          }),
        );
      } else {
        const directory = path.join(project, `.${runner}`);
        fs.mkdirSync(directory);
        fs.writeFileSync(
          path.join(directory, "config.toml"),
          `[mcp_servers.agent-mail]
command = "${process.execPath}"
args = ["${typescriptServer}"]
enabled = true

[mcp_servers.agent-mail.env]
AGENT_MAIL_HOME = "${home}"
AGENT_MAIL_ID = "${recipient}"
`,
        );
      }
      const config = { home, project, recipient, runner };
      expect(() => validateProjectMcpConfig(config)).not.toThrow();
      expect(() =>
        validateProjectMcpConfig({ ...config, recipient: "human@local" }),
      ).toThrow(/identity mismatch/);
    },
  );

  it("classifies output without returning or persisting raw runner output", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-runner-"));
    const result = await runChildProcess(
      {
        command: [
          process.execPath,
          "-e",
          "process.stderr.write('MCP unavailable: private runner output'); process.exit(7)",
        ],
        stdin: null,
      },
      {
        home: path.join(project, ".agent-mail"),
        project,
        recipient: "codex@local",
        timeoutMs: 2_000,
      },
    );
    expect(result.exit_code).toBe(7);
    expect(result.failure_class).toBe("mcp_unavailable");
    expect(JSON.stringify(result)).not.toContain("private runner output");
  });

  it("does not report a failure class when a runner exits successfully", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-runner-ok-"));
    const result = await runChildProcess(
      {
        command: [
          process.execPath,
          "-e",
          "process.stderr.write('MCP unavailable in unrelated startup output')",
        ],
        stdin: null,
      },
      {
        home: path.join(project, ".agent-mail"),
        project,
        recipient: "codex@local",
        timeoutMs: 2_000,
      },
    );
    expect(result.exit_code).toBe(0);
    expect(result.failure_class).toBeNull();
  });

  it("classifies an unavailable OS sandbox without persisting raw output", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-sandbox-"));
    const result = await runChildProcess(
      {
        command: [
          process.execPath,
          "-e",
          "process.stderr.write('bwrap: setting up uid map: Permission denied'); process.exit(1)",
        ],
        stdin: null,
      },
      {
        home: path.join(project, ".agent-mail"),
        project,
        recipient: "grok@local",
        timeoutMs: 2_000,
      },
    );
    expect(result.exit_code).toBe(1);
    expect(result.failure_class).toBe("sandbox_unavailable");
    expect(JSON.stringify(result)).not.toContain("setting up uid map");
  });

  it("terminates a process group on timeout", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-timeout-"));
    const result = await runChildProcess(
      {
        command: [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
        ],
        stdin: null,
      },
      {
        home: path.join(project, ".agent-mail"),
        project,
        recipient: "codex@local",
        timeoutMs: 30,
        terminateGraceMs: 20,
      },
    );
    expect(result.exit_code).toBe(124);
    expect(result.timed_out).toBe(true);
    expect(result.failure_class).toBe("timed_out");
  });

  it("terminates a process group on explicit cancellation", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-cancel-"));
    const controller = new AbortController();
    const pending = runChildProcess(
      {
        command: [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
        ],
        stdin: null,
      },
      {
        home: path.join(project, ".agent-mail"),
        project,
        recipient: "codex@local",
        timeoutMs: 2_000,
        terminateGraceMs: 20,
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result.exit_code).toBe(130);
    expect(result.cancelled).toBe(true);
    expect(result.failure_class).toBe("cancelled");
  });
});

describe("bridge loop", () => {
  it("polls for newly queued tasks and processes both directions and their receipts", async () => {
    const home = tmpHome();
    const codex = "codex@local";
    const antigravity = "antigravity@local";
    const executor: WakeRunnerExecutor = async (config, event, item, mode) => {
      expect(mode).toBe("read");
      if (item.message.type === "task") {
        svc.claim(event.message_id, config.recipient, { home });
        svc.send({
          from_id: config.recipient,
          to: item.message.from_id,
          type: config.runner === "antigravity" ? "done" : "error",
          body: "fixture receipt",
          home,
          task_id: item.message.task_id,
          thread_id: item.message.thread_id,
        });
      } else {
        expect(item.delivery.status).toBe("claimed");
        expect(item.delivery.claim_by).toBe(config.recipient);
      }
      svc.ack(event.message_id, config.recipient, { home });
      return runnerOk();
    };
    const toAntigravity = {
      home, recipient: antigravity, consumerId: "wake:antigravity:test",
      runner: "antigravity" as const, runnerExecutor: executor,
    };
    const toCodex = {
      home, recipient: codex, consumerId: "wake:codex:test",
      runner: "codex" as const, runnerExecutor: executor,
    };
    const queueTasks = () => {
      for (const [from_id, to] of [[codex, antigravity], [antigravity, codex]]) {
        svc.send({ from_id, to, type: "task", effect: "read", body: "fixture task", home });
      }
    };
    const first = await runBridgeLoop(toAntigravity, {
      maxTicks: 2,
      intervalMs: 100,
      onTick(results, tick) {
        if (tick === 1) {
          expect(results).toEqual([]);
          queueTasks();
        } else {
          expect(results).toMatchObject([{ action: "acked", business_state: "complete" }]);
        }
      },
    });
    expect(first).toEqual({ ticks: 2, count: 1, failed: false });
    expect(await runBridgeLoop(toCodex)).toEqual({ ticks: 1, count: 2, failed: false });
    expect(await runBridgeLoop(toAntigravity)).toEqual({ ticks: 1, count: 1, failed: false });
    for (const { recipient, consumerId } of [toAntigravity, toCodex]) {
      expect(svc.inbox(recipient, { home })).toEqual([]);
      expect(svc.listOutboxEvents(recipient, { home, consumerId })).toEqual([]);
    }
    expect(svc.tail({ home }).map((message) => message.type).sort()).toEqual([
      "done", "error", "task", "task",
    ]);
  });

  it("reports repeated dry-run plans without launching or moving the cursor", async () => {
    const home = tmpHome();
    const recipient = "antigravity@local";
    const consumerId = "wake:dry:antigravity";
    const task = svc.send({
      from_id: "codex@local", to: recipient, type: "task", effect: "read", body: "test", home,
    });
    const summary = await runBridgeLoop({
      home, recipient, consumerId, runner: "antigravity", dryRun: true,
      runnerExecutor: async () => { throw new Error("dry-run launched a runner"); },
    }, {
      maxTicks: 2,
      intervalMs: 100,
      onTick(results) {
        expect(results).toMatchObject([{ message_id: task.id, action: "run", mode: "read" }]);
      },
    });
    expect(summary).toEqual({ ticks: 2, count: 2, failed: false });
    expect(svc.inbox(recipient, { home })[0].delivery.status).toBe("pending");
    expect(svc.listOutboxEvents(recipient, { home, consumerId })).toHaveLength(1);
  });

  it("cancels an idle forever loop and validates loop arguments", async () => {
    const home = tmpHome();
    const controller = new AbortController();
    const opts = {
      home, recipient: "antigravity@local", consumerId: "wake:idle:antigravity",
      runner: "antigravity" as const, signal: controller.signal,
    };
    await expect(runBridgeLoop(opts, { maxTicks: 0 })).rejects.toThrow(/bridge ticks/);
    await expect(runBridgeLoop(opts, { intervalMs: 99 })).rejects.toThrow(/interval/);
    const result = await runBridgeLoop(opts, {
      maxTicks: null,
      intervalMs: 60_000,
      onTick() { setTimeout(() => controller.abort(), 0); },
    });
    expect(result).toEqual({ ticks: 1, count: 0, failed: false });
  });

  it("stops on the first failed wake and keeps the event for a deliberate retry", async () => {
    const home = tmpHome();
    const recipient = "antigravity@local";
    const consumerId = "wake:failure:antigravity";
    svc.send({ from_id: "codex@local", to: recipient, type: "message", body: "test", home });
    let calls = 0;
    const summary = await runBridgeLoop({
      home, recipient, consumerId, runner: "antigravity",
      runnerExecutor: async () => {
        calls += 1;
        return { ...runnerOk(), exit_code: 9, failure_class: "runner_exit" };
      },
    }, { maxTicks: 3, intervalMs: 100 });
    expect(summary).toEqual({ ticks: 1, count: 1, failed: true });
    expect(calls).toBe(1);
    expect(svc.listOutboxEvents(recipient, { home, consumerId })).toHaveLength(1);
  });
});

describe("wake live lifecycle with deterministic runner", () => {
  it("claims pending approval, wakes again after approval, then closes and deduplicates", async () => {
    const home = tmpHome();
    const task = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "approved write fixture",
      home,
      effect: "write",
      requires_human_approval: true,
    });
    const consumerId = "wake:test-live:codex@local";
    const modes: string[] = [];
    const executor: WakeRunnerExecutor = async (_config, event, item, mode) => {
      modes.push(mode);
      if (item.delivery.status === "pending") {
        svc.claim(event.message_id, "codex@local", { home });
      }
      if (item.approval?.status === "approved") {
        svc.send({
          from_id: "codex@local",
          to: item.message.from_id,
          type: "done",
          body: "fixture complete",
          home,
          task_id: item.message.task_id,
          thread_id: item.message.thread_id,
        });
        svc.ack(event.message_id, "codex@local", { home });
      }
      return runnerOk();
    };
    const base = {
      home,
      recipient: "codex@local",
      consumerId,
      runner: "codex" as const,
      runnerExecutor: executor,
    };

    const waiting = await pollAndProcessLocalLive(base);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].action).toBe("acked");
    expect(waiting[0].business_state).toBe("waiting_approval");
    expect(waiting[0].cost_notice).toBe(WAKE_COST_NOTICE);
    expect(modes).toEqual(["read"]);

    const approval = svc.getApprovalForTask(task.task_id!, { home });
    svc.approve(String(approval!.id), "human@local", { home });
    const completed = await pollAndProcessLocalLive({
      ...base,
      allowWrite: true,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0].action).toBe("acked");
    expect(completed[0].business_state).toBe("complete");
    expect(modes).toEqual(["read", "write"]);
    expect(svc.taskStatus(task.task_id!, { home })).toBe("completed");

    const replay = await pollAndProcessLocalLive(base);
    expect(replay).toEqual([]);
    expect(modes).toEqual(["read", "write"]);
  });

  it("leaves cursor unacked on runner failure and false success", async () => {
    const home = tmpHome();
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "retry fixture",
      home,
    });
    const consumerId = "wake:test-failure:codex@local";
    const base = {
      home,
      recipient: "codex@local",
      consumerId,
      runner: "grok" as const,
    };
    const failed = await pollAndProcessLocalLive({
      ...base,
      runnerExecutor: async () => ({
        ...runnerOk(),
        exit_code: 9,
        failure_class: "runner_exit",
      }),
    });
    expect(failed[0].action).toBe("runner_failed");
    expect(
      svc.listOutboxEvents("codex@local", { home, consumerId }),
    ).toHaveLength(1);

    const falseSuccess = await pollAndProcessLocalLive({
      ...base,
      runnerExecutor: async () => runnerOk(),
    });
    expect(falseSuccess[0].action).toBe("verification_failed");
    expect(
      svc.listOutboxEvents("codex@local", { home, consumerId }),
    ).toHaveLength(1);
    expect(JSON.stringify(readRuntimeLogs(home, { limit: 50 }))).not.toContain(
      "retry fixture",
    );
  });

  it("fails preflight before runner.started when project MCP config is absent", async () => {
    const home = tmpHome();
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "preflight must not start a model",
      home,
    });
    const consumerId = "wake:test-preflight:codex@local";
    const results = await pollAndProcessLocalLive({
      home,
      recipient: "codex@local",
      consumerId,
      runner: "codex",
    });
    expect(results[0].action).toBe("runner_failed");
    expect(results[0].failure_class).toBe("preflight_failed");
    expect(
      svc.listOutboxEvents("codex@local", { home, consumerId }),
    ).toHaveLength(1);
    const operations = readRuntimeLogs(home, { limit: 50 }).map(
      (entry) => entry.operation,
    );
    expect(operations).toContain("runner.preflight");
    expect(operations).not.toContain("runner.started");
  });

  it("rejects dangerous effects without calling or advancing the runner", async () => {
    const home = tmpHome();
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "danger fixture",
      home,
      effect: "dangerous",
    });
    let calls = 0;
    const consumerId = "wake:test-danger:codex@local";
    const results = await pollAndProcessLocalLive({
      home,
      recipient: "codex@local",
      consumerId,
      runner: "claude",
      runnerExecutor: async () => {
        calls += 1;
        return runnerOk();
      },
    });
    expect(results[0].action).toBe("reject");
    expect(results[0].reason).toContain("dangerous");
    expect(calls).toBe(0);
    expect(
      svc.listOutboxEvents("codex@local", { home, consumerId }),
    ).toHaveLength(1);
  });

  it("holds one cross-process recipient lock across the asynchronous runner", async () => {
    const home = tmpHome();
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "single runner fixture",
      home,
    });
    let releaseRunner!: () => void;
    let markStarted!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const options = {
      home,
      recipient: "codex@local",
      consumerId: "wake:test-lock:codex@local",
      runner: "codex" as const,
      runnerExecutor: async (
        _config: Parameters<WakeRunnerExecutor>[0],
        event: Parameters<WakeRunnerExecutor>[1],
      ) => {
        svc.claim(event.message_id, "codex@local", { home });
        markStarted();
        await runnerGate;
        svc.ack(event.message_id, "codex@local", { home });
        return runnerOk();
      },
    };
    const first = pollAndProcessLocalLive(options);
    await started;
    await expect(
      pollAndProcessLocalLive({ ...options, lockTimeoutMs: 0 }),
    ).rejects.toThrow(/timed out waiting for file lock/);
    releaseRunner();
    const results = await first;
    expect(results[0].action).toBe("acked");
  });
});
