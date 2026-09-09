import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/services.js";
import { createPairing } from "../src/pairing.js";
import { redeemEnrollment, recoverEnrollment, commitEnrollment, cancelEnrollment } from "../src/enrollment.js";
import { authenticateBearer, listTokenMetadata } from "../src/hub/auth.js";
import { loadRoster } from "../src/roster.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const childScript = `
import fs from 'node:fs'; import path from 'node:path';
import {redeemEnrollment,commitEnrollment,cancelEnrollment} from './src/enrollment.ts';
const args=JSON.parse(process.env.ENROLLMENT_FAULT_INPUT);
const rename=fs.renameSync;
fs.renameSync=function(source,target){
  const result=rename(source,target);
  if(path.basename(String(target))===args.target){
    let match=true;
    if(args.state){ const doc=JSON.parse(fs.readFileSync(target,'utf8')); match=doc.enrollments.some(e=>e.state===args.state); }
    if(match) process.exit(73);
  }
  return result;
};
({redeem:redeemEnrollment,commit:commitEnrollment,cancel:cancelEnrollment})[args.operation](args.home,args.input);
process.exit(74);
`;
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enrollment-crash-")); roots.push(root);
  const home = initProject(path.join(root, ".agent-mail"));
  const pair = createPairing(home, "crash@local");
  const input = { code: pair.code, request_id: randomUUID(), recovery_proof: randomBytes(32).toString("base64url") };
  return { home, input };
}
function crash(home: string, operation: string, input: unknown, target: string, state?: string) {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { PATH: process.env.PATH, ENROLLMENT_FAULT_INPUT: JSON.stringify({ home, operation, input, target, state }) },
    encoding: "utf8", timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(73);
  // Simulate the existing lock's five-minute stale lease elapsing. The child
  // really exited mid-operation; journal/token/roster bytes are left intact.
  function ageOwnedLocks(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.name.endsWith(".lock")) {
        const ownerPath = path.join(filename, "owner.json");
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        expect(owner.pid).toBe(child.pid);
        owner.created_at = new Date(Date.now() - 360_000).toISOString();
        fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      } else ageOwnedLocks(filename);
    }
  }
  ageOwnedLocks(home);
}

describe("Hub enrollment actual process-crash recovery", () => {
  it("permits only one new identity when two provider processes redeem concurrently", async () => {
    const { home, input } = setup();
    const second = { ...input, code: createPairing(home, "crash@local").code,
      request_id: randomUUID(), recovery_proof: randomBytes(32).toString("base64url") };
    const script = `import {redeemEnrollment} from './src/enrollment.ts';
      const args=JSON.parse(process.env.ENROLLMENT_FAULT_INPUT);
      try { const result=redeemEnrollment(args.home,args.input); console.log(JSON.stringify({ok:true,id:result.enrollment_id})); }
      catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }`;
    function attempt(candidate: typeof input) {
      return new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { PATH: process.env.PATH, ENROLLMENT_FAULT_INPUT: JSON.stringify({ home, input: candidate }) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "", errors = "";
        child.stdout.on("data", chunk => { output += chunk.toString(); });
        child.stderr.on("data", chunk => { errors += chunk.toString(); });
        child.on("error", reject);
        child.on("close", code => {
          if (code !== 0) { reject(new Error(errors || "child failed")); return; }
          try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
      });
    }
    const results = await Promise.all([attempt(input), attempt(second)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)?.code).toBe("identity_conflict");
    const winner = results[0]!.ok ? input : second;
    const recovered = recoverEnrollment(home, winner);
    expect(authenticateBearer(home, `Bearer ${recovered.token}`)).toBe("crash@local");
    expect(listTokenMetadata(home).filter(token => token.agent_id === "crash@local")).toHaveLength(1);
  });
  it.each([
    ["agents.json", undefined],
    ["hub_tokens.json", undefined],
    ["enrollments.json", "pending_save"],
  ])("recovers exactly one credential after durable write to %s (%s)", (target, state) => {
    const { home, input } = setup();
    crash(home, "redeem", input, target!, state);
    const recovered = recoverEnrollment(home, input);
    const again = recoverEnrollment(home, input);
    expect(again.token).toBe(recovered.token);
    expect(listTokenMetadata(home).filter(token => token.agent_id === "crash@local")).toHaveLength(1);
    expect(authenticateBearer(home, `Bearer ${recovered.token}`)).toBe("crash@local");
    expect(cancelEnrollment(home, { enrollment_id: recovered.enrollment_id, recovery_proof: input.recovery_proof }).state).toBe("cancelled");
    expect(loadRoster(home).agents.some(agent => agent.id === "crash@local")).toBe(false);
    expect(() => authenticateBearer(home, `Bearer ${recovered.token}`)).toThrow();
  });
  it("retains a durable commit after its response is lost to process exit", () => {
    const { home, input } = setup();
    const enrolled = redeemEnrollment(home, input);
    const owner = { enrollment_id: enrolled.enrollment_id, recovery_proof: input.recovery_proof };
    const commit = { ...owner, commit_id: randomUUID() };
    crash(home, "commit", commit, "enrollments.json", "committed");
    expect(commitEnrollment(home, commit).state).toBe("committed");
    expect(() => cancelEnrollment(home, owner)).toThrow();
    expect(authenticateBearer(home, `Bearer ${enrolled.token}`)).toBe("crash@local");
  });
  it("finishes cancellation after the token deletion survives a process exit", () => {
    const { home, input } = setup();
    const enrolled = redeemEnrollment(home, input);
    const owner = { enrollment_id: enrolled.enrollment_id, recovery_proof: input.recovery_proof };
    crash(home, "cancel", owner, "hub_tokens.json");
    expect(cancelEnrollment(home, owner).state).toBe("cancelled");
    expect(() => authenticateBearer(home, `Bearer ${enrolled.token}`)).toThrow();
    expect(loadRoster(home).agents.some(agent => agent.id === "crash@local")).toBe(false);
  });
});
