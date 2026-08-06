import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  authenticateBearer,
  findTokenRecords,
  hashToken,
  listTokenMetadata,
  loadTokenRecords,
  mintToken,
  mintTokenWithSnapshot,
  restoreTokenRecords,
  restoreTokenRecordsIfCurrent,
  revokePreviousToken,
  revokeToken,
  rotateToken,
  tokenAuditPath,
  tokensPath,
} from "../src/hub/auth.js";
import { compensateMintedEnrollment } from "../src/pairing.js";
import { ensureAgent, loadRoster, rosterHas } from "../src/roster.js";
import * as svc from "../src/services.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const authModule = pathToFileURL(path.join(packageRoot, "src/hub/auth.ts")).href;

function tmpHome(prefix = "am-token-"): string {
  return svc.initProject(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), ".agent-mail"),
  );
}

function completion(child: ChildProcess): Promise<string> {
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`token worker exited ${code}: ${stderr || stdout}`));
    });
  });
}

function spawnTokenWorker(
  home: string,
  operation: "mintToken" | "rotateToken",
  agentId: string,
): ChildProcess {
  const script = `
    const auth = await import(process.env.AM_AUTH_MODULE);
    const token = auth[process.env.AM_OPERATION](
      process.env.AM_HOME,
      process.env.AM_AGENT,
      "concurrent",
    );
    process.stdout.write(token);
  `;
  return spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        AM_AUTH_MODULE: authModule,
        AM_OPERATION: operation,
        AM_HOME: home,
        AM_AGENT: agentId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

describe("cross-process token lifecycle", () => {
  it("supports two-token rotation grace and explicit revocation", () => {
    const home = tmpHome();
    const token1 = mintToken(home, "codex@local", "first");
    const token2 = rotateToken(home, "codex@local", "second");

    expect(authenticateBearer(home, `Bearer ${token1}`)).toBe("codex@local");
    expect(authenticateBearer(home, `Bearer ${token2}`)).toBe("codex@local");
    expect(findTokenRecords(home, "codex@local")).toHaveLength(2);

    const token3 = rotateToken(home, "codex@local", "third");
    expect(() => authenticateBearer(home, `Bearer ${token1}`)).toThrow(
      /revoked/,
    );
    expect(authenticateBearer(home, `Bearer ${token2}`)).toBe("codex@local");
    expect(authenticateBearer(home, `Bearer ${token3}`)).toBe("codex@local");
    expect(
      findTokenRecords(home, "codex@local").map((record) => record.generation),
    ).toEqual([1, 2]);

    expect(revokePreviousToken(home, "codex@local")).toBe(true);
    expect(revokePreviousToken(home, "codex@local")).toBe(false);
    expect(() => authenticateBearer(home, `Bearer ${token2}`)).toThrow(
      /revoked/,
    );
    expect(authenticateBearer(home, `Bearer ${token3}`)).toBe("codex@local");

    expect(revokeToken(home, "codex@local")).toBe(true);
    expect(revokeToken(home, "codex@local")).toBe(false);
    expect(() => authenticateBearer(home, `Bearer ${token3}`)).toThrow(
      /revoked/,
    );
  });

  it("never exposes secrets in metadata or the append-only audit", () => {
    const home = tmpHome();
    const token = mintToken(home, "grok@local", "primary");
    rotateToken(home, "grok@local", "next");
    revokePreviousToken(home, "grok@local");

    const metadata = listTokenMetadata(home);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).not.toHaveProperty("token_hash");
    const audit = fs.readFileSync(tokenAuditPath(home), "utf8");
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(hashToken(token));
    expect(audit).not.toContain("token_hash");
    expect(audit.trim().split("\n").map((line) => JSON.parse(line).operation)).toEqual([
      "mint",
      "rotate",
      "revoke_previous",
    ]);
    expect(fs.statSync(tokenAuditPath(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(tokensPath(home)).mode & 0o777).toBe(0o600);
  });

  it("preserves all unique agents during concurrent mints", async () => {
    const home = tmpHome("am-token-race-");
    const agents = Array.from(
      { length: 12 },
      (_, index) => `worker-${index}@local`,
    );
    const tokens = await Promise.all(
      agents.map((agent) => completion(spawnTokenWorker(home, "mintToken", agent))),
    );

    expect(loadTokenRecords(home)).toHaveLength(agents.length);
    for (const [index, agent] of agents.entries()) {
      expect(authenticateBearer(home, `Bearer ${tokens[index]}`)).toBe(agent);
    }
    expect(
      fs.readFileSync(tokenAuditPath(home), "utf8").trim().split("\n"),
    ).toHaveLength(agents.length);
    expect(fs.existsSync(`${tokensPath(home)}.lock`)).toBe(false);
  }, 20_000);

  it("serializes same-agent rotations and retains exactly two generations", async () => {
    const home = tmpHome("am-token-rotate-race-");
    mintToken(home, "shared@local", "initial");
    const rotated = await Promise.all(
      Array.from({ length: 8 }, () =>
        completion(spawnTokenWorker(home, "rotateToken", "shared@local")),
      ),
    );

    const records = findTokenRecords(home, "shared@local");
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.generation)).toEqual([7, 8]);
    expect(
      rotated.filter((token) => {
        try {
          return authenticateBearer(home, `Bearer ${token}`) === "shared@local";
        } catch {
          return false;
        }
      }),
    ).toHaveLength(2);
  }, 20_000);

  it("rolls token state back if the audit target is a symlink", () => {
    const home = tmpHome();
    const outside = path.join(path.dirname(home), "outside-audit");
    fs.writeFileSync(outside, "outside\n");
    fs.mkdirSync(path.dirname(tokenAuditPath(home)), { recursive: true });
    fs.symlinkSync(outside, tokenAuditPath(home));

    expect(() => mintToken(home, "codex@local")).toThrow(/audit path/);
    expect(loadTokenRecords(home)).toEqual([]);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("restores a complete grace set after failed enrollment", () => {
    const home = tmpHome();
    const first = mintToken(home, "paired@local", "first");
    const second = rotateToken(home, "paired@local", "second");
    const snapshot = findTokenRecords(home, "paired@local");
    const temporary = mintTokenWithSnapshot(
      home,
      "paired@local",
      "temporary",
    );
    let restoredWhileLocked = false;

    expect(
      restoreTokenRecordsIfCurrent(
        home,
        "paired@local",
        temporary.issued_hash,
        temporary.replaced,
        () => {
          restoredWhileLocked = fs.existsSync(`${tokensPath(home)}.lock`);
        },
      ),
    ).toBe(true);
    expect(restoredWhileLocked).toBe(true);
    expect(findTokenRecords(home, "paired@local")).toEqual(snapshot);
    expect(authenticateBearer(home, `Bearer ${first}`)).toBe("paired@local");
    expect(authenticateBearer(home, `Bearer ${second}`)).toBe("paired@local");

    const laterMint = mintTokenWithSnapshot(home, "paired@local", "temporary-2");
    const laterRotation = rotateToken(home, "paired@local", "newer");
    const current = findTokenRecords(home, "paired@local");
    expect(
      ensureAgent(home, {
        id: "paired@local",
        display_name: "Paired",
        skills: ["paired"],
      }),
    ).toBe(true);
    expect(
      compensateMintedEnrollment(
        home,
        "paired@local",
        laterMint.issued_hash,
        laterMint.replaced,
        true,
      ),
    ).toEqual({ token_restored: false, roster_removed: false });
    expect(findTokenRecords(home, "paired@local")).toEqual(current);
    expect(rosterHas(loadRoster(home), "paired@local")).toBe(true);
    expect(authenticateBearer(home, `Bearer ${laterRotation}`)).toBe(
      "paired@local",
    );

    const cleanupMint = mintTokenWithSnapshot(
      home,
      "paired@local",
      "temporary-3",
    );
    expect(
      compensateMintedEnrollment(
        home,
        "paired@local",
        cleanupMint.issued_hash,
        cleanupMint.replaced,
        true,
      ),
    ).toEqual({ token_restored: true, roster_removed: true });
    expect(rosterHas(loadRoster(home), "paired@local")).toBe(false);
    expect(authenticateBearer(home, `Bearer ${laterRotation}`)).toBe(
      "paired@local",
    );

    restoreTokenRecords(home, "paired@local", snapshot);
  });

  it("exposes lifecycle commands without listing token hashes", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "am-token-cli-"));
    svc.initProject(path.join(project, ".agent-mail"));
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(packageRoot, "src/cli.ts"),
          "hub-token",
          ...args,
          "--path",
          project,
        ],
        { cwd: packageRoot, encoding: "utf8" },
      );

    const missingProject = fs.mkdtempSync(
      path.join(os.tmpdir(), "am-token-cli-missing-"),
    );
    const missing = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(packageRoot, "src/cli.ts"),
        "hub-token",
        "list",
        "--path",
        missingProject,
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain("not initialized");
    expect(fs.existsSync(path.join(missingProject, ".agent-mail"))).toBe(false);

    const mint = run("mint", "--as", "cli@local", "--label", "first");
    expect(mint.status, mint.stderr).toBe(0);
    expect(mint.stdout.trim().length).toBeGreaterThan(20);
    const rotate = run("rotate", "--as", "cli@local");
    expect(rotate.status, rotate.stderr).toBe(0);
    const list = run("list", "--json");
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(2);
    expect(list.stdout).not.toContain("token_hash");
    expect(run("revoke-previous", "--as", "cli@local").stdout.trim()).toBe(
      "previous-revoked",
    );
    expect(run("revoke", "--as", "cli@local").stdout.trim()).toBe("revoked");
  });
});
