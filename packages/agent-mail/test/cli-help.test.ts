import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(PACKAGE_ROOT, "src", "cli.ts");
const TSX = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");

const HELP_PATHS = [
  ["version"],
  ["init"],
  ["quickstart"],
  ["doctor"],
  ["diagnose"],
  ["logs"],
  ["tui"],
  ["config"],
  ["config", "get"],
  ["config", "set"],
  ["config", "list"],
  ["backup"],
  ["backup", "create"],
  ["backup", "verify"],
  ["backup", "restore"],
  ["send"],
  ["inbox"],
  ["claim"],
  ["ack"],
  ["tail"],
  ["approve"],
  ["reject"],
  ["approvals"],
  ["agents"],
  ["outbox-backfill"],
  ["outbox-purge"],
  ["events"],
  ["mcp"],
  ["hub-token"],
  ["hub-token", "mint"],
  ["hub-token", "rotate"],
  ["hub-token", "revoke"],
  ["hub-token", "revoke-previous"],
  ["hub-token", "webhook-init"],
  ["hub-token", "list"],
  ["hub"],
  ["bridge"],
  ["pair"],
  ["pair", "create"],
  ["pair", "redeem"],
  ["pair", "list"],
  ["pair", "revoke"],
  ["federation"],
  ["federation", "set-domain"],
  ["federation", "peer-add"],
  ["federation", "peer-set-outbound"],
  ["federation", "peer-set-ca"],
  ["federation", "status"],
  ["federation", "sync"],
  ["federation", "worker"],
  ["federation", "dlq"],
  ["federation", "dlq", "list"],
  ["federation", "dlq", "requeue"],
  ["connect"],
  ["connect", "set"],
  ["connect", "show"],
  ["connect", "test"],
] as const;
const HELP_CASES = HELP_PATHS.map((command) => ({
  label: command.join(" "),
  command,
}));

function snapshotTree(root: string): string[] {
  const snapshot: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot.push(`dir:${relative}`);
        visit(absolute);
      } else if (entry.isFile()) {
        snapshot.push(
          `file:${relative}:${fs.readFileSync(absolute).toString("base64")}`,
        );
      } else if (entry.isSymbolicLink()) {
        snapshot.push(`link:${relative}:${fs.readlinkSync(absolute)}`);
      } else {
        snapshot.push(`other:${relative}`);
      }
    }
  };
  visit(root);
  return snapshot;
}

function runHelp(command: readonly string[], helpFlag = "--help"): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-cli-help-"));
  try {
    const project = path.join(root, "project");
    const userHome = path.join(root, "user-home");
    fs.mkdirSync(project);
    fs.mkdirSync(userHome);
    fs.writeFileSync(path.join(project, "sentinel"), "project\n");
    fs.writeFileSync(path.join(userHome, "sentinel"), "home\n");
    const before = snapshotTree(root);

    const result = spawnSync(
      TSX,
      [CLI, ...command, helpFlag, "--path", project],
      {
        cwd: project,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          AGENT_MAIL_HOME: path.join(project, ".agent-mail"),
          AGENT_MAIL_ID: "help-fixture@local",
          CODEX_HOME: path.join(userHome, ".codex"),
          HOME: userHome,
          XDG_CONFIG_HOME: path.join(userHome, ".config"),
        },
      },
    );

    const label = ["agent-mail", ...command, helpFlag].join(" ");
    expect(result.error, label).toBeUndefined();
    expect(result.signal, label).toBeNull();
    expect(result.status, `${label}\n${result.stderr}`).toBe(0);
    expect(result.stdout, label).toContain("Usage:");
    expect(result.stderr, label).toBe("");
    expect(snapshotTree(root), `${label} changed isolated state`).toEqual(
      before,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("CLI help safety", () => {
  it("keeps root help read-only", () => {
    runHelp([]);
  });

  it.each(HELP_CASES)(
    "keeps $label --help read-only",
    ({ command }) => {
      runHelp(command);
    },
  );

  it("keeps the short help flag read-only", () => {
    runHelp(["init"], "-h");
  });
});

describe("outbox-backfill CLI compatibility", () => {
  function run(command: string[], project: string, userHome: string) {
    return spawnSync(TSX, [CLI, ...command, "--path", project], {
      cwd: project,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        AGENT_MAIL_HOME: path.join(project, ".agent-mail"),
        HOME: userHome,
        XDG_CONFIG_HOME: path.join(userHome, ".config"),
      },
    });
  }

  it("accepts the documented --as option and the --recipient compatibility alias", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-cli-backfill-"));
    try {
      const project = path.join(root, "project");
      const userHome = path.join(root, "user-home");
      fs.mkdirSync(project);
      fs.mkdirSync(userHome);
      const initialized = run(["init"], project, userHome);
      expect(initialized.status, initialized.stderr).toBe(0);

      for (const option of ["--as", "--recipient"]) {
        const result = run(
          ["outbox-backfill", option, "codex@local"],
          project,
          userHome,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          recipient: "codex@local",
          backfilled: 0,
        });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting --as and --recipient identities", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-cli-backfill-"));
    try {
      const project = path.join(root, "project");
      const userHome = path.join(root, "user-home");
      fs.mkdirSync(project);
      fs.mkdirSync(userHome);
      const result = run(
        [
          "outbox-backfill",
          "--as",
          "codex@local",
          "--recipient",
          "grok@local",
        ],
        project,
        userHome,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--as and --recipient must match");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
