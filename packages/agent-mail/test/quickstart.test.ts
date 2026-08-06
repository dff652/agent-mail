import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseRunners,
  resolveMcpInvocation,
  runQuickstart,
} from "../src/quickstart.js";

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
