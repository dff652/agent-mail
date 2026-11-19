import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseRunners,
  resolveMcpInvocation,
  runQuickstart,
} from "../src/quickstart.js";
import { loadRoster, removeAgent } from "../src/roster.js";
import * as svc from "../src/services.js";
import {
  ANTIGRAVITY_MCP_CONFIG,
  ANTIGRAVITY_PLUGIN_DIR,
  validateProjectMcpConfig,
} from "../src/wake/runner.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-quickstart-"));
  temps.push(dir);
  return dir;
}

describe("quickstart", () => {
  it("defaults to single-agent codex runner", () => {
    expect(parseRunners(null)).toEqual(["codex"]);
    expect(parseRunners("")).toEqual(["codex"]);
  });

  it("parses multi runners and rejects unknown", () => {
    expect(parseRunners("codex,claude")).toEqual(["codex", "claude"]);
    expect(parseRunners("codex,antigravity,ANTIGRAVITY")).toEqual(["codex", "antigravity"]);
    expect(() => parseRunners("cursor")).toThrow(/unknown runner/);
  });

  it("resolves MCP invocation to node + stdio script or agent-mail-mcp", () => {
    const mcp = resolveMcpInvocation();
    expect(mcp.command.length).toBeGreaterThan(0);
    if (mcp.args.length) {
      expect(mcp.args[0]).toMatch(/stdio\.js$/);
      expect(fs.existsSync(mcp.args[0]!)).toBe(true);
    }
  });

  it("writes codex MCP config and initializes home", () => {
    const project = tmpProject();
    const result = runQuickstart(project, { runners: ["codex"], force: true });
    expect(fs.existsSync(path.join(project, ".agent-mail", "config.json"))).toBe(
      true,
    );
    const codexPath = path.join(project, ".codex", "config.toml");
    expect(fs.existsSync(codexPath)).toBe(true);
    const text = fs.readFileSync(codexPath, "utf8");
    expect(text).toContain("codex@local");
    expect(text).toContain(path.join(project, ".agent-mail"));
    expect(text).toContain("AGENT_MAIL_HOME");
    expect(result.wrote).toContain(path.join(".codex", "config.toml"));
    expect(result.mcp_command).toBeTruthy();
    expect(() => validateProjectMcpConfig({
      home: result.home, project, runner: "codex", recipient: "codex@local",
    })).not.toThrow();
  });

  it("creates a native Antigravity plugin and provisions both identities in one home", () => {
    const project = path.join(tmpProject(), 'project "with spaces"');
    const home = svc.initProject(path.join(project, ".agent-mail"));
    expect(removeAgent(home, "antigravity@local")).toBe(true);
    const runners = parseRunners("codex,antigravity");
    const result = runQuickstart(project, { runners });
    const plugin = path.join(project, ANTIGRAVITY_PLUGIN_DIR);
    expect(result.wrote).toHaveLength(6);
    expect(result.configs).toEqual([path.join(".codex", "config.toml"), ANTIGRAVITY_MCP_CONFIG]);
    expect(JSON.parse(fs.readFileSync(path.join(plugin, "plugin.json"), "utf8"))).toMatchObject({
      name: "agent-mail",
      version: expect.any(String),
    });
    expect(JSON.parse(fs.readFileSync(path.join(project, ANTIGRAVITY_MCP_CONFIG), "utf8")))
      .toEqual({
        mcpServers: {
          "agent-mail": {
            command: result.mcp_command,
            args: result.mcp_args,
            env: { AGENT_MAIL_HOME: home, AGENT_MAIL_ID: "antigravity@local" },
          },
        },
      });
    const rule = path.join(plugin, "rules", "AGENTS.md");
    expect(fs.readFileSync(rule, "utf8")).toMatch(/done or error.*acknowledge.*summary.*Never send a new task/);
    expect(fs.readFileSync(path.join(plugin, "skills", "agent-mail", "SKILL.md"), "utf8"))
      .toMatch(/^---\nname: agent-mail\ndescription:/);
    expect(JSON.parse(fs.readFileSync(path.join(plugin, "hooks.json"), "utf8"))).toEqual({});
    expect(fs.existsSync(path.join(plugin, "hooks", "hooks.json"))).toBe(false);
    for (const runner of ["codex", "antigravity"] as const) {
      expect(() => validateProjectMcpConfig({
        home, project, runner, recipient: `${runner}@local`,
      })).not.toThrow();
    }
    fs.writeFileSync(rule, "# Customized rule\n");
    expect(runQuickstart(project, { runners }).skipped).toHaveLength(6);
    expect(fs.readFileSync(rule, "utf8")).toBe("# Customized rule\n");
    expect(runQuickstart(project, { runners, force: true }).wrote).toHaveLength(6);
    expect(fs.readFileSync(rule, "utf8")).toContain("# Agent Mail");
    const ids = loadRoster(home).agents.map((agent) => agent.id);
    expect(ids.filter((id) => id === "antigravity@local")).toHaveLength(1);
    expect(ids).toContain("codex@local");
  });

  it("writes claude .mcp.json with absolute home", () => {
    const project = tmpProject();
    runQuickstart(project, { runners: ["claude"], force: true });
    const mcpJson = path.join(project, ".mcp.json");
    expect(fs.existsSync(mcpJson)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(mcpJson, "utf8")) as {
      mcpServers: { "agent-mail": { env: { AGENT_MAIL_HOME: string; AGENT_MAIL_ID: string } } };
    };
    expect(doc.mcpServers["agent-mail"].env.AGENT_MAIL_ID).toBe(
      "claude-code@local",
    );
    expect(doc.mcpServers["agent-mail"].env.AGENT_MAIL_HOME).toBe(
      path.join(project, ".agent-mail"),
    );
  });

  it("skips existing configs without --force", () => {
    const project = tmpProject();
    runQuickstart(project, { runners: ["claude"], force: true });
    const r2 = runQuickstart(project, { runners: ["claude"], force: false });
    expect(r2.skipped.some((s) => s.includes("exists"))).toBe(true);
    expect(r2.wrote).toEqual([]);
  });
});
