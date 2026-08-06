import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decideSendPolicy } from "../src/domain/send-policy.js";
import { AgentMailError } from "../src/errors.js";
import { createHubServer } from "../src/hub/server.js";
import type { EffectLevel, MessageType } from "../src/models.js";
import { loadPolicy } from "../src/policy.js";
import type { ProjectPolicy } from "../src/policy-shape.js";
import * as svc from "../src/services.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const packageRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(
  repoRoot,
  "contracts/fixtures/policy-send-decisions.json",
);

type PolicyFixture = {
  cases: Array<{
    id: string;
    policy: ProjectPolicy;
    input: {
      from: string;
      to: string;
      type: MessageType;
      effect: EffectLevel;
      caller_requires_approval: boolean;
    };
    expect: {
      outcome: string;
      requires_human_approval: boolean;
    };
  }>;
};

function tempProject(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return svc.initProject(path.join(root, ".agent-mail"));
}

function writePolicy(home: string, policy: unknown): void {
  fs.writeFileSync(
    path.join(home, "policy.yaml"),
    `${JSON.stringify(policy, null, 2)}\n`,
    "utf8",
  );
}

describe("TypeScript policy.yaml enforcement", () => {
  it("matches the shared policy decision fixtures", () => {
    const fixture = JSON.parse(
      fs.readFileSync(fixturePath, "utf8"),
    ) as PolicyFixture;
    for (const item of fixture.cases) {
      const decision = decideSendPolicy(item.policy, {
        fromId: item.input.from,
        to: item.input.to,
        type: item.input.type,
        effect: item.input.effect,
        callerRequires: item.input.caller_requires_approval,
      });
      expect(decision.outcome, item.id).toBe(item.expect.outcome);
      expect(decision.requires_human_approval, item.id).toBe(
        item.expect.requires_human_approval,
      );
    }
  });

  it("enforces view-only and does not let callers downgrade approval", () => {
    const home = tempProject("am-policy-view");
    svc.configSet("policy.default_execution_mode", "view-only", { home });

    expect(() =>
      svc.send({
        from_id: "claude-code@local",
        to: "codex@local",
        type: "task",
        body: "must not write",
        effect: "write",
        home,
      }),
    ).toThrow(/view-only policy denies effect=write/);

    svc.configSet("policy.default_execution_mode", "approve-writes", { home });
    const message = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "still gated",
      effect: "write",
      requires_human_approval: false,
      home,
    });
    expect(message.requires_human_approval).toBe(true);
    expect(message.meta.approval_id).toEqual(expect.stringMatching(/^apr_/));
  });

  it("enforces allow_edges by sender, recipient, and message type", () => {
    const home = tempProject("am-policy-edges");
    svc.configSet("policy.default_execution_mode", "autonomous", { home });
    svc.configSet("policy.roster_mode", "allowlist", { home });
    svc.configSet(
      "policy.allow_edges",
      '[{"from":"claude-code@local","to":"codex@local","types":["task"]}]',
      { home },
    );

    expect(
      svc.send({
        from_id: "claude-code@local",
        to: "codex@local",
        type: "task",
        body: "allowed",
        effect: "write",
        home,
      }).requires_human_approval,
    ).toBe(false);

    expect(() =>
      svc.send({
        from_id: "grok@local",
        to: "codex@local",
        type: "message",
        body: "denied",
        home,
      }),
    ).toThrow(/policy denies grok@local -> codex@local type=message/);
  });

  it("fails closed on unknown or unsupported policy input", () => {
    const home = tempProject("am-policy-invalid");
    writePolicy(home, {
      default_execution_mode: "approve-writes",
      roster_mode: "open",
      effect_rules: {},
      allow_edges: [],
      unexpected_switch: true,
    });

    expect(() => loadPolicy(home)).toThrow(/unsupported policy\.yaml keys/);
    expect(() =>
      createHubServer({ home, host: "127.0.0.1", port: 0 }),
    ).toThrow(/unsupported policy\.yaml keys/);
    expect(svc.diagnose({ home }).warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unsupported policy\.yaml keys/),
      ]),
    );

    writePolicy(home, {
      default_execution_mode: "approve-writes",
      roster_mode: "open",
      effect_rules: { write: "deny" },
      allow_edges: [],
    });
    expect(() => loadPolicy(home)).toThrow(
      /unsupported policy\.effect_rules\.write/,
    );
    expect(() =>
      svc.configSet("policy.effect_rules", '{"write":"deny"}', { home }),
    ).toThrow(/unsupported policy\.effect_rules\.write/);
  });

  it("preserves configuration exit code at the agent-mail-mcp entrypoint", () => {
    const home = tempProject("am-policy-mcp-start");
    writePolicy(home, {
      default_execution_mode: "unsupported",
      roster_mode: "open",
      effect_rules: {},
      allow_edges: [],
    });

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/mcp/stdio.ts"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_MAIL_HOME: home,
          AGENT_MAIL_HUB_URL: "",
          AGENT_MAIL_HUB_TOKEN: "",
        },
        timeout: 5_000,
      },
    );

    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain(
      "policy.default_execution_mode must be one of",
    );
    expect(result.stderr).not.toContain("AgentMailError:");
  });

  it("rejects malformed edges and unsupported send inputs before storage", () => {
    const home = tempProject("am-policy-input");
    expect(() =>
      svc.configSet(
        "policy.allow_edges",
        '[{"from":"not-an-agent","to":"codex@local"}]',
        { home },
      ),
    ).toThrow(/from must be a valid agent id/);
    expect(() =>
      svc.send({
        from_id: "claude-code@local",
        to: "codex@local",
        type: "unknown",
        body: "bad",
        home,
      }),
    ).toThrow(/unsupported message type/);
    expect(() =>
      svc.send({
        from_id: "claude-code@local",
        to: "codex@local",
        type: "task",
        body: "bad",
        effect: "execute",
        home,
      }),
    ).toThrow(/unsupported effect level/);
    expect(svc.getStore(home).diagnostics().counts.messages).toBe(0);
  });

  it("loads registry defaults when optional policy keys are absent", () => {
    const home = tempProject("am-policy-defaults");
    writePolicy(home, {});
    expect(loadPolicy(home)).toEqual({
      default_execution_mode: "approve-writes",
      roster_mode: "open",
      effect_rules: {
        write: "requires_human_approval",
        dangerous: "requires_human_approval",
      },
      allow_edges: [],
    });
  });

  it("surfaces policy validation through AgentMailError exit code 3", () => {
    const home = tempProject("am-policy-code");
    writePolicy(home, []);
    try {
      loadPolicy(home);
      expect.fail("expected invalid policy");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentMailError);
      expect((error as AgentMailError).exitCode).toBe(3);
    }

    writePolicy(home, {
      default_execution_mode: null,
      roster_mode: "open",
      effect_rules: {},
      allow_edges: [],
    });
    expect(() => loadPolicy(home)).toThrow(
      /policy\.default_execution_mode must be one of/,
    );
  });
});
