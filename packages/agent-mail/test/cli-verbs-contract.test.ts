/**
 * Capability contract: the CLI verb surface must match contracts/cli-verbs.json.
 *
 * Every documented verb must exist in the CLI and every implemented verb must
 * be documented. This turns capability drift into a CI failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const CONTRACT = path.join(REPO, "contracts", "cli-verbs.json");
const CLI_SOURCE = path.join(__dirname, "..", "src", "cli.ts");

interface VerbContract {
  binary: string;
  verbs: Array<{ name: string; purpose: string }>;
  not_implemented: Array<{ name: string; reason: string }>;
}

function loadContract(): VerbContract {
  return JSON.parse(fs.readFileSync(CONTRACT, "utf8")) as VerbContract;
}

/** Verbs the CLI actually dispatches, read from its `cmd === "..."` guards. */
function implementedVerbs(): Set<string> {
  const source = fs.readFileSync(CLI_SOURCE, "utf8");
  return new Set(
    [...source.matchAll(/cmd === "([a-z][a-z0-9-]*)"/g)].map((m) => m[1]!),
  );
}

describe("CLI verb capability contract", () => {
  const contract = loadContract();

  it("implements every verb the contract declares", () => {
    const implemented = implementedVerbs();
    const missing = contract.verbs
      .map((v) => v.name)
      .filter((name) => !implemented.has(name));
    expect(missing).toEqual([]);
  });

  it("declares every verb the CLI implements", () => {
    const declared = new Set(contract.verbs.map((v) => v.name));
    const undeclared = [...implementedVerbs()].filter(
      (name) => !declared.has(name),
    );
    expect(undeclared).toEqual([]);
  });

  it("documents each verb and each deliberate omission", () => {
    for (const verb of contract.verbs) {
      expect(verb.name, JSON.stringify(verb)).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(verb.purpose.length, verb.name).toBeGreaterThan(0);
    }
    for (const skipped of contract.not_implemented) {
      expect(skipped.reason.length, skipped.name).toBeGreaterThan(0);
    }
    const declared = new Set(contract.verbs.map((v) => v.name));
    for (const skipped of contract.not_implemented) {
      expect(declared.has(skipped.name), `${skipped.name} is both`).toBe(false);
    }
  });

  it("lists every verb in the CLI usage text", () => {
    const usage = fs.readFileSync(CLI_SOURCE, "utf8");
    const usageBlock = usage.slice(
      usage.indexOf("Usage:"),
      usage.indexOf("`);"),
    );
    const undocumented = contract.verbs
      .map((v) => v.name)
      .filter((name) => !usageBlock.includes(`agent-mail ${name}`));
    expect(undocumented).toEqual([]);
  });
});
