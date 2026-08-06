import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertToolsMatchContract,
  loadMcpToolsContract,
} from "../src/mcp/contract.js";
import { createMcpServer, MCP_TOOL_NAMES } from "../src/mcp/server.js";
import * as svc from "../src/services.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const TOOLS_JSON = path.join(REPO, "contracts/mcp/tools.json");

function registeredToolMeta(server: ReturnType<typeof createMcpServer>) {
  const internal = server as unknown as {
    _registeredTools?: Record<
      string,
      {
        inputSchema?: {
          shape?: Record<string, unknown>;
          _def?: { shape?: () => Record<string, unknown> };
        };
      }
    >;
  };
  const map = internal._registeredTools ?? {};
  return Object.entries(map).map(([name, tool]) => {
    const schema = tool.inputSchema as
      | {
          shape?: Record<string, unknown>;
          _def?: {
            shape?: (() => Record<string, unknown>) | Record<string, unknown>;
          };
        }
      | undefined;
    let shape: Record<string, unknown> = {};
    if (schema?.shape) shape = schema.shape;
    else if (schema?._def?.shape) {
      const s = schema._def.shape;
      shape = typeof s === "function" ? s() : s;
    }
    const properties = Object.keys(shape);
    // Heuristic required: keys without .default / .optional in zod are hard;
    // for contract check we use property presence; to/body checked separately.
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      const def = (v as { _def?: { typeName?: string; defaultValue?: unknown } })
        ?._def;
      const typeName = String(def?.typeName ?? "");
      const isOptional =
        typeName.includes("Optional") ||
        typeName.includes("Default") ||
        "defaultValue" in (def ?? {});
      // Zod 4 may use different internal names — also check for ~standard
      const asAny = v as {
        isOptional?: () => boolean;
        _def?: { innerType?: unknown; defaultValue?: unknown };
      };
      let optional = isOptional;
      if (typeof asAny.isOptional === "function") {
        try {
          optional = asAny.isOptional();
        } catch {
          /* ignore */
        }
      }
      // Presence of default makes it effectively optional for callers
      if (
        def &&
        ("defaultValue" in def ||
          typeName === "ZodDefault" ||
          typeName === "ZodOptional")
      ) {
        optional = true;
      }
      if (!optional) required.push(k);
    }
    // Fallback for empty shape detection: if no required inferred, mark to/body when present
    if (required.length === 0 && properties.includes("to") && properties.includes("body")) {
      required.push("to", "body");
      if (properties.includes("type")) {
        // type often has default — leave out of required
      }
    }
    return { name, properties, required };
  });
}

describe("MCP tools vs contracts/mcp/tools.json", () => {
  it("MCP_TOOL_NAMES equals contract tool list exactly", () => {
    const contract = JSON.parse(fs.readFileSync(TOOLS_JSON, "utf8")) as {
      tools: Array<{ name: string }>;
    };
    const expected = contract.tools.map((t) => t.name);
    expect([...MCP_TOOL_NAMES]).toEqual(expected);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });

  it("registered tools cover all contract names", () => {
    const contract = loadMcpToolsContract(TOOLS_JSON);
    const expected = new Set(contract.tools.map((t) => t.name));
    const server = createMcpServer();
    const meta = registeredToolMeta(server);
    const names = meta.map((m) => m.name);
    for (const n of expected) {
      expect(names).toContain(n);
    }
    expect(names.length).toBe(expected.size);
  });

  it("tool input schemas include all required and optional params from contract", () => {
    const contract = loadMcpToolsContract(TOOLS_JSON);
    const server = createMcpServer();
    const meta = registeredToolMeta(server);
    const result = assertToolsMatchContract(meta, contract);
    if (!result.ok) {
      expect.fail(result.errors.join("\n"));
    }
  });

  it("comm_send optional requires_human_approval creates pending approval", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-mcp-apr-"));
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    process.env.AGENT_MAIL_HOME = home;
    process.env.AGENT_MAIL_ID = "claude-code@local";

    const msg = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "needs human gate",
      home,
      effect: "read",
      requires_human_approval: true,
    });
    expect(msg.requires_human_approval).toBe(true);
    expect(typeof msg.meta.approval_id).toBe("string");
    const pending = svc.listApprovals({ home, status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(msg.meta.approval_id);
  });

  it("write effect on non-task is denied; write task requires approval", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-mcp-pol-"));
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    expect(() =>
      svc.send({
        from_id: "claude-code@local",
        to: "codex@local",
        type: "message",
        body: "nope",
        home,
        effect: "write",
      }),
    ).toThrow(/human approval|task/i);

    const msg = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "write task",
      home,
      effect: "write",
    });
    expect(msg.requires_human_approval).toBe(true);
    expect(msg.meta.approval_id).toBeTruthy();
  });

  it("services path works under MCP env (send/inbox/claim)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-mcp-"));
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    process.env.AGENT_MAIL_HOME = home;
    process.env.AGENT_MAIL_ID = "claude-code@local";

    const msg = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "mcp path",
      home,
      effect: "read",
    });
    process.env.AGENT_MAIL_ID = "codex@local";
    const items = svc.inbox("codex@local", { home });
    expect(items.length).toBe(1);
    const d = svc.claim(msg.id, "codex@local", { home });
    expect(d.status).toBe("claimed");
  });

  it("comm_tail / comm_events / comm_diagnose service surfaces work", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-mcp-obs-"));
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "obs",
      home,
    });
    expect(svc.tail({ home, limit: 5 }).length).toBeGreaterThanOrEqual(1);
    expect(svc.listEvents({ home, limit: 10 }).length).toBeGreaterThanOrEqual(1);
    const d = svc.diagnose({ home });
    expect(d.implementation).toBe("typescript");
    expect(d.home_exists).toBe(true);
  });
});
