import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { initProject } from "../src/services.js";
import { createPairing, pairingStatus } from "../src/pairing.js";
import { redeemEnrollment, commitEnrollment } from "../src/enrollment.js";

it("legacy redemption waits for the Hub lock without holding SQLite against guarded commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enrollment-lock-order-"));
  const home = initProject(path.join(root, ".agent-mail"));
  const proof = randomBytes(32).toString("base64url");
  const guarded = createPairing(home, "guarded@local");
  const legacy = createPairing(home, "legacy@local");
  const enrollment = redeemEnrollment(home, {
    code: guarded.code, request_id: randomUUID(), recovery_proof: proof,
  });
  const ready = path.join(root, "ready"), release = path.join(root, "release");
  // Pause the real legacy API at its first Hub lock attempt. Before the fix,
  // that point was already inside a SQLite write transaction, blocking commit.
  const script = `
    import fs from 'node:fs'; import path from 'node:path';
    import { redeemPairing } from './src/pairing.ts';
    const args = JSON.parse(process.env.ENROLLMENT_LOCK_INPUT);
    const mkdir = fs.mkdirSync;
    let paused = false;
    fs.mkdirSync = function(target, ...options) {
      if (!paused && path.basename(String(target)) === 'hub_state.lock') {
        paused = true;
        fs.writeFileSync(args.ready, 'ready');
        const until = Date.now() + 15000;
        while (!fs.existsSync(args.release)) {
          if (Date.now() >= until) throw new Error('release timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return mkdir.call(fs, target, ...options);
    };
    redeemPairing(args.home, args.code);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, ENROLLMENT_LOCK_INPUT: JSON.stringify({ home, code: legacy.code, ready, release }) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  try {
    const until = Date.now() + 10_000;
    while (!fs.existsSync(ready)) {
      if (child.exitCode !== null || Date.now() >= until) throw new Error(`child not ready: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const committed = commitEnrollment(home, {
      enrollment_id: enrollment.enrollment_id, recovery_proof: proof, commit_id: randomUUID(),
    });
    expect(committed.state).toBe("committed");
    fs.writeFileSync(release, "release");
    expect(await exited, errors).toBe(0);
    expect(pairingStatus(home, legacy.pair_id)).toBe("redeemed");
  } finally {
    fs.writeFileSync(release, "release");
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
