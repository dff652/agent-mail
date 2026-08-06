import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { setConnection } from "../src/connection.js";
import {
  listPullDeadLetters,
  recordPullFailure,
} from "../src/federation/pull-dlq.js";
import { setLocalDomain } from "../src/federation/peers.js";
import {
  authenticateBearer,
  mintToken,
  tokensPath,
} from "../src/hub/auth.js";
import { createPairing, listPairings } from "../src/pairing.js";
import {
  createBackup,
  restoreBackup,
  verifyBackup,
} from "../src/recovery.js";
import * as svc from "../src/services.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

function tempRoot(prefix = "am-recovery-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function seedProject(root: string): {
  home: string;
  token: string;
  messageId: string;
} {
  const home = svc.initProject(path.join(root, "source", ".agent-mail"));
  const message = svc.send({
    from_id: "claude-code@local",
    to: "codex@local",
    type: "task",
    body: "pre-upgrade recovery fixture",
    effect: "read",
    home,
  });
  setLocalDomain(home, "source.lab");
  const token = mintToken(home, "codex@local", "recovery-fixture");
  createPairing(home, "grok@local", { label: "pending fixture" });
  recordPullFailure(home, {
    sourceDomain: "peer.lab",
    messageId: "msg_pull_recovery_fixture",
    envelope: { message_id: "msg_pull_recovery_fixture" },
    error: "fixture poison",
    maxAttempts: 1,
  });
  setConnection(home, {
    hub_url: "http://127.0.0.1:7421",
    token_file: "operator-token",
  });
  return { home, token, messageId: message.id };
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("TypeScript backup and restore", () => {
  it("creates a private checked archive and restores pre-upgrade state into a new home", async () => {
    const root = tempRoot();
    const { home, token, messageId } = seedProject(root);
    const archive = path.join(root, "backup");

    const created = await createBackup(home, archive);
    expect(created.files).toBeGreaterThanOrEqual(9);
    expect(created.archive).toBe(archive);
    expect(verifyBackup(archive)).toEqual(created);
    if (process.platform !== "win32") {
      expect(fs.statSync(archive).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(archive, "manifest.json")).mode & 0o777).toBe(
        0o600,
      );
    }

    const later = svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "message",
      body: "post-backup mutation",
      home,
    });
    const restoredProject = path.join(root, "restored");
    fs.mkdirSync(restoredProject, { mode: 0o755 });
    const projectMode = fs.statSync(restoredProject).mode & 0o777;
    const restoredHome = path.join(restoredProject, ".agent-mail");
    const restored = restoreBackup(archive, restoredHome);
    expect(restored.restored_home).toBe(restoredHome);
    expect(fs.statSync(restoredProject).mode & 0o777).toBe(projectMode);

    const restoredInbox = svc.inbox("codex@local", {
      home: restoredHome,
      allItems: true,
    });
    expect(restoredInbox.map((item) => item.message.id)).toContain(messageId);
    expect(restoredInbox.map((item) => item.message.id)).not.toContain(later.id);
    expect(authenticateBearer(restoredHome, `Bearer ${token}`)).toBe(
      "codex@local",
    );
    expect(listPairings(restoredHome)).toHaveLength(1);
    expect(listPullDeadLetters(restoredHome)).toMatchObject([
      {
        message_id: "msg_pull_recovery_fixture",
        direction: "pull",
      },
    ]);
    expect(fs.existsSync(path.join(restoredHome, "connection.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(restoredHome).mode & 0o777).toBe(0o700);
      expect(fs.statSync(tokensPath(restoredHome)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on tampering, symlinks, and an existing restore target", async () => {
    const root = tempRoot();
    const { home } = seedProject(root);
    const archive = path.join(root, "backup");
    await createBackup(home, archive);

    fs.appendFileSync(
      path.join(archive, "data", "agents.json"),
      "\n",
      "utf8",
    );
    expect(() => verifyBackup(archive)).toThrow(/checksum mismatch/);

    const cleanArchive = path.join(root, "clean-backup");
    await createBackup(home, cleanArchive);
    const existing = svc.initProject(
      path.join(root, "existing", ".agent-mail"),
    );
    expect(() => restoreBackup(cleanArchive, existing)).toThrow(
      /target already exists/,
    );

    if (process.platform !== "win32") {
      fs.chmodSync(tokensPath(home), 0o644);
      await expect(
        createBackup(home, path.join(root, "wide-mode-backup")),
      ).rejects.toThrow(/accessible to group\/other/);
      expect(fs.existsSync(path.join(root, "wide-mode-backup"))).toBe(false);
      fs.chmodSync(tokensPath(home), 0o600);
    }

    const outside = path.join(root, "outside-token");
    fs.writeFileSync(outside, "outside remains unchanged\n", "utf8");
    fs.unlinkSync(tokensPath(home));
    fs.symlinkSync(outside, tokensPath(home));
    await expect(createBackup(home, path.join(root, "symlink-backup"))).rejects.toThrow(
      /symlink/,
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
    expect(fs.existsSync(path.join(root, "symlink-backup"))).toBe(false);
  });

  it("exposes create, verify, and non-destructive restore through the TS CLI", () => {
    const root = tempRoot("am-recovery-cli-");
    const { home, token } = seedProject(root);
    const project = path.dirname(home);
    const archive = path.join(root, "cli-backup");
    const restoredProject = path.join(root, "cli-restored");
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(packageRoot, "src/cli.ts"),
          "backup",
          ...args,
        ],
        { cwd: packageRoot, encoding: "utf8" },
      );

    const created = run(
      "create",
      "--path",
      project,
      "--output",
      archive,
      "--json",
    );
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ archive });
    expect(created.stdout).not.toContain(token);
    expect(created.stderr).not.toContain(token);

    const verified = run("verify", "--input", archive, "--json");
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).files).toBeGreaterThanOrEqual(9);

    const restored = run(
      "restore",
      "--input",
      archive,
      "--path",
      restoredProject,
      "--json",
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      restored_home: path.join(restoredProject, ".agent-mail"),
    });
    expect(restored.stdout).not.toContain(token);
    expect(restored.stderr).not.toContain(token);
  });
});
