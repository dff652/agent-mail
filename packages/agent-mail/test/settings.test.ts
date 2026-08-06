import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import * as svc from "../src/services.js";
import {
  loadSettingsRegistry,
  mirrorErrors,
} from "../src/settings.js";

describe("S0/E8 settings registry", () => {
  it("parses the required language-neutral settings", () => {
    const registry = loadSettingsRegistry();
    expect(registry.version).toBe("0.1");
    expect(registry.settings.map((entry) => entry.key)).toEqual([
      "project.lease_seconds",
      "policy.default_execution_mode",
      "policy.roster_mode",
      "policy.effect_rules",
      "policy.allow_edges",
    ]);
    for (const entry of registry.settings) {
      expect(entry).toMatchObject({
        type: expect.any(String),
        authority: expect.any(String),
        mirrors: expect.any(Array),
        danger: expect.any(String),
        cli: expect.any(String),
      });
      expect(entry).toHaveProperty("default");
    }
  });

  it("sets authority and mirrors, and lists effective values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-settings-"));
    const home = svc.initProject(path.join(dir, ".agent-mail"));

    const updated = svc.configSet(
      "policy.default_execution_mode",
      "autonomous",
      { home },
    );
    expect(updated.value).toBe("autonomous");

    const config = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const policy = parseYaml(
      fs.readFileSync(path.join(home, "policy.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(config.default_execution_mode).toBe("autonomous");
    expect(policy.default_execution_mode).toBe("autonomous");

    svc.configSet("project.lease_seconds", "90", { home });
    svc.configSet(
      "policy.allow_edges",
      '[{"from":"claude-code@local","to":"codex@local","types":["task"]}]',
      { home },
    );
    const values = Object.fromEntries(
      svc.configList({ home }).map((entry) => [entry.key, entry.value]),
    );
    expect(values["project.lease_seconds"]).toBe(90);
    expect(values["policy.allow_edges"]).toEqual([
      {
        from: "claude-code@local",
        to: "codex@local",
        types: ["task"],
      },
    ]);
    expect(mirrorErrors(home)).toEqual([]);
  });

  it("detects mirror drift and rejects invalid values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-settings-"));
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    const configPath = path.join(home, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.roster_mode = "allowlist";
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    expect(mirrorErrors(home)[0]).toMatch(/policy\.roster_mode mirror mismatch/);
    expect(() =>
      svc.configSet("project.lease_seconds", "0", { home }),
    ).toThrow(/must be >= 1/);

    delete config.default_execution_mode;
    config.roster_mode = "open";
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(mirrorErrors(home)).toContain(
      "policy.default_execution_mode mirror missing from config.json",
    );

    const policyPath = path.join(home, "policy.yaml");
    const policy = parseYaml(fs.readFileSync(policyPath, "utf8")) as Record<
      string,
      unknown
    >;
    policy.roster_mode = "broken";
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    expect(() =>
      svc.configSet("policy.effect_rules", "{}", { home }),
    ).toThrow(/policy\.roster_mode must be one of/);

    fs.unlinkSync(policyPath);
    expect(mirrorErrors(home)).toEqual(
      expect.arrayContaining([expect.stringMatching(/missing policy\.yaml/)]),
    );
  });

  it("exposes get, set, and list through the TypeScript CLI", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-settings-cli-"));
    svc.initProject(path.join(dir, ".agent-mail"));
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(packageRoot, "src/cli.ts"),
          "config",
          ...args,
          "--path",
          dir,
        ],
        {
          cwd: packageRoot,
          encoding: "utf8",
        },
      );

    const get = run("get", "project.lease_seconds");
    expect(get.status, get.stderr).toBe(0);
    expect(get.stdout.trim()).toBe("3600");

    const set = run("set", "project.lease_seconds", "120", "--json");
    expect(set.status, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout).value).toBe(120);

    const list = run("list", "--json");
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(5);
  });
});
