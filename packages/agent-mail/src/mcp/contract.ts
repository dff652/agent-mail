/**
 * Load and validate MCP tool surface against contracts/mcp/tools.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ContractTool {
  name: string;
  required: string[];
  optional: string[];
}

export interface McpToolsContract {
  description: string;
  server: string;
  tools: ContractTool[];
}

/** Resolve monorepo contracts path from package src/mcp. */
export function contractsToolsPath(): string {
  // packages/agent-mail/src/mcp → repo root
  return path.resolve(__dirname, "../../../../contracts/mcp/tools.json");
}

export function loadMcpToolsContract(p = contractsToolsPath()): McpToolsContract {
  return JSON.parse(fs.readFileSync(p, "utf8")) as McpToolsContract;
}

export function contractToolNames(contract = loadMcpToolsContract()): string[] {
  return contract.tools.map((t) => t.name);
}

/**
 * Compare registered tool names + schema property keys to the contract.
 * Zod→JSON schema puts required fields in `required` and properties in `properties`.
 */
export function assertToolsMatchContract(
  registered: Array<{
    name: string;
    /** Zod raw shape keys or JSON-schema property names (required + optional). */
    properties: string[];
    required?: string[];
  }>,
  contract = loadMcpToolsContract(),
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const expectedNames = new Set(contract.tools.map((t) => t.name));
  const actualNames = new Set(registered.map((t) => t.name));

  for (const n of expectedNames) {
    if (!actualNames.has(n)) errors.push(`missing tool: ${n}`);
  }
  for (const n of actualNames) {
    if (!expectedNames.has(n)) errors.push(`extra tool: ${n}`);
  }

  const byName = new Map(registered.map((t) => [t.name, t]));
  for (const tool of contract.tools) {
    const reg = byName.get(tool.name);
    if (!reg) continue;
    const props = new Set(reg.properties);
    for (const r of tool.required) {
      if (!props.has(r)) errors.push(`${tool.name}: missing required param schema: ${r}`);
    }
    for (const o of tool.optional) {
      if (!props.has(o)) {
        errors.push(`${tool.name}: missing optional param schema: ${o}`);
      }
    }
    // Required keys listed by contract should appear in required[] when provided
    if (reg.required) {
      const req = new Set(reg.required);
      for (const r of tool.required) {
        // type may have a default in MCP (still "present"); only flag if absent from properties
        if (!props.has(r)) {
          // already reported
        } else if (!req.has(r) && r !== "type" && r !== "body" && r !== "to") {
          // soft: defaults allowed for type; to/body must be required without default
        }
      }
      for (const r of ["to", "body"] as const) {
        if (tool.required.includes(r) && !req.has(r)) {
          errors.push(`${tool.name}: ${r} must be required (no default)`);
        }
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
