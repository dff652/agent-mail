import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  cancelEnrollment,
  commitEnrollment,
  enrollmentJournalPath,
  EnrollmentError,
  getEnrollment,
  recoverEnrollment,
  redeemEnrollment,
  sweepEnrollments,
} from "../src/enrollment.js";
import {
  authenticateBearer,
  findTokenRecords,
  mintToken,
  rotateToken,
} from "../src/hub/auth.js";
import { createPairing, listPairings, pairingDbPath } from "../src/pairing.js";
import { initProject } from "../src/services.js";
import { ensureAgent, loadRoster, removeAgent, saveRoster } from "../src/roster.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(prefix = "enrollment-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return initProject(path.join(root, ".agent-mail"));
}

function proof(): string {
  return randomBytes(32).toString("base64url");
}

function request(code: string) {
  return {
    code,
    request_id: randomUUID(),
    recovery_proof: proof(),
  };
}

describe("durable Hub enrollment", () => {
  it("independently commits and cancels multiple identities on the same Hub", () => {
    const h = home();
    const entries = ["first@local", "second@local", "third@local"].map(id => {
      const input = request(createPairing(h, id).code);
      return { input, issued: redeemEnrollment(h, input) };
    });
    const first = entries[0]!, second = entries[1]!, third = entries[2]!;
    expect(commitEnrollment(h, { enrollment_id: first.issued.enrollment_id,
      recovery_proof: first.input.recovery_proof, commit_id: randomUUID() }).state).toBe("committed");
    expect(cancelEnrollment(h, { enrollment_id: second.issued.enrollment_id,
      recovery_proof: second.input.recovery_proof }).state).toBe("cancelled");
    expect(commitEnrollment(h, { enrollment_id: third.issued.enrollment_id,
      recovery_proof: third.input.recovery_proof, commit_id: randomUUID() }).state).toBe("committed");
    expect(authenticateBearer(h, `Bearer ${first.issued.token}`)).toBe("first@local");
    expect(authenticateBearer(h, `Bearer ${third.issued.token}`)).toBe("third@local");
    expect(() => authenticateBearer(h, `Bearer ${second.issued.token}`)).toThrow();
  });

  it("preserves an administrator's remove-and-readd of the same identity", () => {
    const h = home();
    const input = request(createPairing(h, "readded@local").code);
    const issued = redeemEnrollment(h, input);
    const owned = loadRoster(h).agents.find(agent => agent.id === "readded@local")!;
    removeAgent(h, owned.id);
    ensureAgent(h, { ...owned });
    expect(loadRoster(h).agents.find(agent => agent.id === owned.id)?.enrollment_generation).toBeUndefined();
    expect(cancelEnrollment(h, { enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof }).state).toBe("cleanup_conflict");
    expect(loadRoster(h).agents.some(agent => agent.id === owned.id)).toBe(true);
    expect(authenticateBearer(h, `Bearer ${issued.token}`)).toBe(owned.id);
  });

  it("recovers a lost response by proof and commits idempotently", () => {
    const h = home();
    const pair = createPairing(h, "enrolled@local");
    const input = request(pair.code);
    const first = redeemEnrollment(h, input);
    const recovered = recoverEnrollment(h, {
      request_id: input.request_id,
      recovery_proof: input.recovery_proof,
    });
    expect(recovered).toEqual(first);
    expect(() =>
      recoverEnrollment(h, {
        request_id: input.request_id,
        recovery_proof: proof(),
      }),
    ).toThrowError(new EnrollmentError("management_denied"));

    const commitId = randomUUID();
    const committed = commitEnrollment(h, {
      enrollment_id: first.enrollment_id,
      recovery_proof: input.recovery_proof,
      commit_id: commitId,
    });
    expect(committed.state).toBe("committed");
    expect(commitEnrollment(h, {
      enrollment_id: first.enrollment_id,
      recovery_proof: input.recovery_proof,
      commit_id: commitId,
    })).toEqual(committed);
    expect(() => commitEnrollment(h, {
      enrollment_id: first.enrollment_id,
      recovery_proof: input.recovery_proof,
      commit_id: randomUUID(),
    })).toThrow(/idempotency_conflict/);
    expect(() => cancelEnrollment(h, {
      enrollment_id: first.enrollment_id,
      recovery_proof: input.recovery_proof,
    })).toThrow(/idempotency_conflict/);
    expect(authenticateBearer(h, `Bearer ${first.token}`)).toBe("enrolled@local");
    expect(JSON.stringify(getEnrollment(h, {
      enrollment_id: first.enrollment_id,
      recovery_proof: input.recovery_proof,
    }))).not.toContain(first.token);
    expect(fs.readFileSync(enrollmentJournalPath(h), "utf8")).not.toContain(pair.code);
  });

  it("rejects roster or token identity conflicts without replacing the original token", () => {
    const h = home();
    const original = mintToken(h, "conflict@local", "original");
    const pair = createPairing(h, "conflict@local");
    const input = request(pair.code);
    expect(() => redeemEnrollment(h, input)).toThrow(/identity_conflict/);
    expect(authenticateBearer(h, `Bearer ${original}`)).toBe("conflict@local");
    expect(findTokenRecords(h, "conflict@local")).toHaveLength(1);
    expect(listPairings(h).find((item) => item.id === pair.pair_id)?.status).toBe("rejected");

    const h2 = home();
    ensureAgent(h2, { id: "roster-conflict@local", display_name: "Existing", skills: [] });
    const pair2 = createPairing(h2, "roster-conflict@local");
    expect(() => redeemEnrollment(h2, request(pair2.code))).toThrow(/identity_conflict/);
    expect(loadRoster(h2).agents.filter((agent) => agent.id === "roster-conflict@local")).toHaveLength(1);
    expect(findTokenRecords(h2, "roster-conflict@local")).toHaveLength(0);
  });

  it("rejects a second code for an identity already owned by pending enrollment", () => {
    const h = home();
    const firstPair = createPairing(h, "race@local");
    const secondPair = createPairing(h, "race@local");
    const first = request(firstPair.code);
    const second = request(secondPair.code);
    const issued = redeemEnrollment(h, first);
    expect(() => redeemEnrollment(h, second)).toThrow(/identity_conflict/);
    expect(authenticateBearer(h, `Bearer ${issued.token}`)).toBe("race@local");
    expect(listPairings(h).find((item) => item.id === secondPair.pair_id)?.status).toBe("rejected");
  });

  it("cleans pending credentials on cancel and expiry", () => {
    const h = home();
    const pair = createPairing(h, "cancelled@local");
    const input = request(pair.code);
    const issued = redeemEnrollment(h, input);
    const cancelled = cancelEnrollment(h, {
      enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof,
    });
    expect(cancelled.state).toBe("cancelled");
    expect(findTokenRecords(h, "cancelled@local")).toHaveLength(0);
    expect(loadRoster(h).agents.some((agent) => agent.id === "cancelled@local")).toBe(false);

    const h2 = home();
    const pair2 = createPairing(h2, "expired@local");
    const input2 = request(pair2.code);
    const issued2 = redeemEnrollment(h2, input2);
    const future = new Date(Date.parse(issued2.expires_at) + 1_000);
    const counts = sweepEnrollments(h2, { now: future });
    expect(counts.expired).toBe(1);
    expect(getEnrollment(h2, {
      enrollment_id: issued2.enrollment_id,
      recovery_proof: input2.recovery_proof,
    }).state).toBe("expired");
    expect(findTokenRecords(h2, "expired@local")).toHaveLength(0);
    expect(loadRoster(h2).agents.some((agent) => agent.id === "expired@local")).toBe(false);
  });

  it("preserves a later token mutation while cleaning its own roster entry", () => {
    const h = home();
    const pair = createPairing(h, "later@local");
    const input = request(pair.code);
    const issued = redeemEnrollment(h, input);
    const later = rotateToken(h, "later@local", "admin-rotation");
    const result = cancelEnrollment(h, {
      enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof,
    });
    expect(result.state).toBe("cleanup_conflict");
    expect(authenticateBearer(h, `Bearer ${later}`)).toBe("later@local");
    expect(loadRoster(h).agents.some((agent) => agent.id === "later@local")).toBe(true);
  });

  it("preserves a later roster mutation and its enrollment token", () => {
    const h = home();
    const pair = createPairing(h, "roster-edit@local");
    const input = request(pair.code);
    const issued = redeemEnrollment(h, input);
    const roster = loadRoster(h);
    const current = roster.agents.find((agent) => agent.id === "roster-edit@local")!;
    current.display_name = "Admin renamed";
    saveRoster(h, roster);
    const result = cancelEnrollment(h, {
      enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof,
    });
    expect(result.state).toBe("cleanup_conflict");
    expect(authenticateBearer(h, `Bearer ${issued.token}`)).toBe("roster-edit@local");
    expect(loadRoster(h).agents.find((agent) => agent.id === "roster-edit@local")?.display_name).toBe("Admin renamed");
  });

  it("rejects commit after an administrator replaces the pending token", () => {
    const h = home();
    const pair = createPairing(h, "commit-conflict@local");
    const input = request(pair.code);
    const issued = redeemEnrollment(h, input);
    const adminToken = mintToken(h, "commit-conflict@local", "admin-replacement");
    expect(() => commitEnrollment(h, {
      enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof,
      commit_id: randomUUID(),
    })).toThrow(/cleanup_conflict/);
    expect(authenticateBearer(h, `Bearer ${adminToken}`)).toBe("commit-conflict@local");
    expect(loadRoster(h).agents.some((agent) => agent.id === "commit-conflict@local")).toBe(true);
    expect(getEnrollment(h, {
      enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof,
    }).state).toBe("cleanup_conflict");
  });

  it("serializes expiry before commit and removes the pending identity", () => {
    const h = home();
    const pair = createPairing(h, "expiry-race@local");
    const input = request(pair.code);
    const issued = redeemEnrollment(h, input);
    const future = new Date(Date.parse(issued.expires_at) + 1_000);
    expect(() => commitEnrollment(h, {
      enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof,
      commit_id: randomUUID(),
    }, { now: future })).toThrow(/context_expired/);
    expect(getEnrollment(h, {
      enrollment_id: issued.enrollment_id,
      recovery_proof: input.recovery_proof,
    }).state).toBe("expired");
    expect(findTokenRecords(h, "expiry-race@local")).toHaveLength(0);
    expect(loadRoster(h).agents.some((agent) => agent.id === "expiry-race@local")).toBe(false);
  });

  it("recovers a pairing reservation after the journal missed its pair id", () => {
    const h = home();
    const pair = createPairing(h, "restart@local");
    const input = request(pair.code);
    const issued = redeemEnrollment(h, input);
    const journal = JSON.parse(fs.readFileSync(enrollmentJournalPath(h), "utf8")) as {
      schema_version: number;
      enrollments: Array<Record<string, unknown>>;
    };
    const record = journal.enrollments[0]!;
    record.state = "preparing";
    record.stage = "prepared";
    record.pair_id = null;
    fs.writeFileSync(enrollmentJournalPath(h), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    const db = new Database(pairingDbPath(h));
    db.prepare(
      `UPDATE pairing_codes SET status='enrollment_pending', enrollment_id=?,
       enrollment_request_id=?, enrollment_fingerprint=? WHERE id=?`,
    ).run(record.enrollment_id, record.request_id, record.request_fingerprint, pair.pair_id);
    db.close();

    const recovered = recoverEnrollment(h, {
      request_id: input.request_id,
      recovery_proof: input.recovery_proof,
    });
    expect(recovered.token).toBe(issued.token);
    expect(recovered.enrollment_id).toBe(issued.enrollment_id);
  });
});
