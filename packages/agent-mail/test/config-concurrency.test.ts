import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import * as svc from "../src/services.js";
import { mirrorErrors } from "../src/settings.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const servicesModule = pathToFileURL(
  path.join(packageRoot, "src/services.ts"),
).href;

function waitForFiles(files: string[], timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (files.every((file) => fs.existsSync(file))) {
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        reject(new Error("timed out waiting for config workers"));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

function completion(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`config worker exited ${code}: ${stderr || stdout}`));
    });
  });
}

describe("cross-process settings writes", () => {
  it("serializes concurrent read-modify-write operations without mirror drift", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-config-race-"));
    const home = svc.initProject(path.join(dir, ".agent-mail"));
    const go = path.join(dir, "go");
    const settings: Array<[string, string]> = [
      ["project.lease_seconds", "120"],
      ["policy.default_execution_mode", "autonomous"],
      ["policy.roster_mode", "allowlist"],
      ["policy.effect_rules", '{"write":"requires_human_approval"}'],
      [
        "policy.allow_edges",
        '[{"from":"codex@local","to":"grok@local","types":["task"]}]',
      ],
    ];
    const readyFiles = settings.map((_, index) => path.join(dir, `ready-${index}`));
    const script = `
      import fs from "node:fs";
      const svc = await import(process.env.AM_SERVICES_MODULE);
      fs.writeFileSync(process.env.AM_READY, "ready");
      const signal = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(process.env.AM_GO)) Atomics.wait(signal, 0, 0, 5);
      svc.configSet(process.env.AM_KEY, process.env.AM_VALUE, {
        home: process.env.AM_HOME,
      });
    `;
    const children = settings.map(([key, value], index) =>
      spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            AM_SERVICES_MODULE: servicesModule,
            AM_READY: readyFiles[index]!,
            AM_GO: go,
            AM_KEY: key,
            AM_VALUE: value,
            AM_HOME: home,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    const completions = children.map(completion);
    try {
      await waitForFiles(readyFiles);
      fs.writeFileSync(go, "go");
      await Promise.all(completions);
    } finally {
      if (!fs.existsSync(go)) fs.writeFileSync(go, "go");
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
    }

    expect(
      Object.fromEntries(
        svc.configList({ home }).map((entry) => [entry.key, entry.value]),
      ),
    ).toMatchObject({
      "project.lease_seconds": 120,
      "policy.default_execution_mode": "autonomous",
      "policy.roster_mode": "allowlist",
      "policy.effect_rules": { write: "requires_human_approval" },
      "policy.allow_edges": [
        {
          from: "codex@local",
          to: "grok@local",
          types: ["task"],
        },
      ],
    });
    expect(mirrorErrors(home)).toEqual([]);
    expect(fs.existsSync(path.join(home, ".locks", "settings.lock"))).toBe(false);
  });
});
