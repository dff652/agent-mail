import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendRuntimeLog,
  readRuntimeLogs,
} from "../src/observability.js";
import * as svc from "../src/services.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(dirname, "..");
const temporary: string[] = [];

function tempDir(label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporary.push(target);
  return target;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporary.length > 0) {
    fs.rmSync(temporary.pop()!, { recursive: true, force: true });
  }
});

describe("TypeScript runtime observability", () => {
  it("redacts nested credentials, bearer text and private keys", () => {
    const root = tempDir("am-runtime-redaction");
    const missing = path.join(root, "missing", ".agent-mail");
    appendRuntimeLog(missing, "cli.missing", "error", {
      error: new Error("ignored"),
    });
    expect(fs.existsSync(missing)).toBe(false);

    const home = svc.initProject(path.join(root, ".agent-mail"));
    const privateKey = [
      "-----BEGIN ",
      "PRIVATE KEY-----\nPRIVATE-KEY-DATA\n-----END PRIVATE KEY-----",
    ].join("");
    appendRuntimeLog(home, "mcp.comm_send", "error", {
      actor: "codex@local",
      context: {
        body: "PRIVATE-BODY",
        payload: {
          note: "PRIVATE-NOTE",
          api_key: "PRIVATE-API-KEY",
        },
        safe: `token=PRIVATE-TOKEN ${privateKey}`,
      },
      error: new Error(
        "authorization=Bearer PRIVATE-AUTH password=PRIVATE-PASSWORD",
      ),
    });

    const entries = readRuntimeLogs(home, {
      outcome: "error",
      operation: "mcp.comm_send",
    });
    const encoded = JSON.stringify(entries);
    expect(entries).toHaveLength(1);
    for (const secret of [
      "PRIVATE-BODY",
      "PRIVATE-NOTE",
      "PRIVATE-API-KEY",
      "PRIVATE-TOKEN",
      "PRIVATE-AUTH",
      "PRIVATE-PASSWORD",
      "PRIVATE-KEY-DATA",
    ]) {
      expect(encoded).not.toContain(secret);
    }
    expect(
      (entries[0]!.context as Record<string, unknown>).body,
    ).toBe("<redacted>");
    expect(
      fs.statSync(path.join(home, "logs", "runtime.jsonl")).mode & 0o777,
    ).toBe(0o600);
  });

  it("rotates bounded JSONL files and reads newest entries first", () => {
    const root = tempDir("am-runtime-rotate");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    for (let index = 0; index < 8; index += 1) {
      appendRuntimeLog(home, "test.rotate", "success", {
        context: { index, padding: "x".repeat(300) },
        maxBytes: 512,
        backups: 3,
      });
    }

    expect(fs.existsSync(path.join(home, "logs", "runtime.jsonl.1"))).toBe(
      true,
    );
    const entries = readRuntimeLogs(home, {
      limit: 3,
      operation: "test.rotate",
    });
    expect(entries).toHaveLength(3);
    expect(
      (entries[0]!.context as Record<string, unknown>).index,
    ).toBe(7);
    expect(
      (entries[1]!.context as Record<string, unknown>).index,
    ).toBe(6);
  });

  it("refuses a symlinked log directory", () => {
    const root = tempDir("am-runtime-symlink");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.rmSync(path.join(home, "logs"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, "logs"), "dir");

    appendRuntimeLog(home, "test.symlink", "error", {
      error: new Error("must not escape"),
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("diagnose reports store counts, integrity and recent runtime errors", () => {
    const root = tempDir("am-runtime-diagnose");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    svc.send({
      from_id: "codex@local",
      to: "grok@local",
      type: "message",
      body: "not included in diagnose",
      home,
    });
    appendRuntimeLog(home, "cli.claim", "error", {
      context: { message_id: "msg_missing" },
      error: new Error("missing delivery"),
    });
    vi.stubEnv("AGENT_MAIL_ID", "token=INVALID-ENV-SECRET");

    const report = svc.diagnose({ home });
    const database = report.database as Record<string, unknown>;
    const counts = database.counts as Record<string, number>;
    const runtime = report.runtime_logs as Array<Record<string, unknown>>;
    expect(database.integrity).toEqual(["ok"]);
    expect(database.journal_mode).toBe("wal");
    expect(database.foreign_keys).toBe(true);
    expect(counts.messages).toBe(1);
    expect(counts.events).toBe(1);
    expect(runtime[0]?.operation).toBe("cli.claim");
    expect(report.agent_id_env).toBeNull();
    expect(report.warnings).toContain("AGENT_MAIL_ID is invalid");
    expect(JSON.stringify(report)).not.toContain("not included in diagnose");
    expect(JSON.stringify(report)).not.toContain("INVALID-ENV-SECRET");
  });

  it("CLI logs failures, filters logs and emits diagnose JSON", () => {
    const root = tempDir("am-runtime-cli");
    svc.initProject(path.join(root, ".agent-mail"));
    const failure = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "claim",
        "--as",
        "codex@local",
        "--message-id",
        "msg_missing",
        "--path",
        root,
      ],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(failure.status).toBe(5);

    const logs = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "logs",
        "--path",
        root,
        "--outcome",
        "error",
        "--operation",
        "cli.claim",
        "--json",
      ],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(logs.status).toBe(0);
    const entries = JSON.parse(logs.stdout) as Array<Record<string, unknown>>;
    expect(entries[0]?.operation).toBe("cli.claim");
    expect(entries[0]?.outcome).toBe("error");

    const diagnose = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "diagnose",
        "--path",
        root,
        "--json",
      ],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(diagnose.status).toBe(0);
    const report = JSON.parse(diagnose.stdout) as Record<string, unknown>;
    expect(report.implementation).toBe("typescript");
    expect(
      (report.runtime_logs as Array<Record<string, unknown>>)[0]?.operation,
    ).toBe("cli.claim");
  });
});
