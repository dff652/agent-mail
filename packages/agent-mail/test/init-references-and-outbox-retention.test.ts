/**
 * Follow-ups from project-evaluation-2026-08-01:
 * P1-2 — init must land the behaviour-contract files agents are told to read.
 * P1-3 — the wake outbox must be prunable, not append-only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/doctor.js";
import * as svc from "../src/services.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");

function freshHome(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `am-${label}-`));
  return svc.initProject(path.join(dir, ".agent-mail"));
}

describe("P1-2 behaviour contract files", () => {
  it("init writes PROTOCOL.md and the schemas byte-identical to refs/", () => {
    const home = freshHome("refs");
    for (const name of svc.REFERENCE_FILES) {
      const landed = path.join(home, name);
      expect(fs.existsSync(landed), name).toBe(true);
      expect(
        fs.readFileSync(landed).equals(fs.readFileSync(path.join(REPO, "refs", name))),
        `${name} differs from refs/`,
      ).toBe(true);
    }
  });

  it("init does not overwrite a project's edited copies", () => {
    const home = freshHome("refs-keep");
    const target = path.join(home, "PROTOCOL.md");
    fs.writeFileSync(target, "# local house rules\n".repeat(10), "utf8");
    const before = fs.readFileSync(target, "utf8");
    svc.initProject(home);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("rejects a dangling reference symlink without writing outside home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-refs-link-"));
    const home = path.join(root, "project", ".agent-mail");
    const outsideDir = path.join(root, "outside");
    const outsideTarget = path.join(outsideDir, "escaped-protocol.md");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideTarget, path.join(home, "PROTOCOL.md"));

    expect(() => svc.initProject(home)).toThrow(/reference must be a regular file/i);
    expect(fs.existsSync(outsideTarget)).toBe(false);
    expect(fs.lstatSync(path.join(home, "PROTOCOL.md")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("doctor rejects a reference symlink instead of following it", async () => {
    const home = freshHome("refs-doctor-link");
    const outside = path.join(path.dirname(home), "outside-protocol.md");
    fs.writeFileSync(outside, "not the packaged contract\n".repeat(10), "utf8");
    fs.rmSync(path.join(home, "PROTOCOL.md"));
    fs.symlinkSync(outside, path.join(home, "PROTOCOL.md"));

    const report = await runDoctor(home, {});
    const references = report.checks.find((check) => check.id === "references");
    expect(references?.status).toBe("fail");
    expect(references?.message).toContain("PROTOCOL.md");
  });

  it("doctor fails when a behaviour contract file is missing or truncated", async () => {
    const home = freshHome("refs-doctor");
    const healthy = await runDoctor(home, {});
    expect(healthy.checks.find((c) => c.id === "references")?.status).toBe("pass");

    fs.writeFileSync(path.join(home, "PROTOCOL.md"), "stub\n", "utf8");
    const truncated = await runDoctor(home, {});
    const check = truncated.checks.find((c) => c.id === "references");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("PROTOCOL.md");
    expect(truncated.ok).toBe(false);

    fs.rmSync(path.join(home, "roster.schema.json"));
    const missing = await runDoctor(home, {});
    expect(
      missing.checks.find((c) => c.id === "references")?.message,
    ).toContain("roster.schema.json");
  });

  it("the packaged snapshot is what a published install would copy", () => {
    const packaged = path.join(REPO, "packages", "agent-mail", "refs");
    for (const name of svc.REFERENCE_FILES) {
      expect(
        fs
          .readFileSync(path.join(packaged, name))
          .equals(fs.readFileSync(path.join(REPO, "refs", name))),
        `packaged ${name} drifted from refs/`,
      ).toBe(true);
    }
  });
});

describe("P1-3 outbox retention", () => {
  function seed(home: string, count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        svc.send({
          from_id: "codex@local",
          to: "grok@local",
          type: "message",
          body: `retention ${i}`,
          home,
        }).id,
      );
    }
    return ids;
  }

  it("keeps everything while no consumer has acknowledged", () => {
    const home = freshHome("retain-none");
    seed(home, 3);
    expect(svc.purgeOutbox({ home })).toBe(0);
    expect(svc.listOutboxEvents("grok@local", { home })).toHaveLength(3);
  });

  it("purges at or below the consumer watermark and keeps the rest", () => {
    const home = freshHome("retain-cursor");
    seed(home, 4);
    const events = svc.listOutboxEvents("grok@local", { home });
    svc.ackOutbox("wake:test", "grok@local", events[1]!.sequence, { home });

    expect(svc.purgeOutbox({ home })).toBe(2);
    const remaining = svc.listOutboxEvents("grok@local", { home });
    expect(remaining.map((e) => e.sequence)).toEqual(
      events.slice(2).map((e) => e.sequence),
    );
    // The cursor still resolves, so the bridge does not replay purged hints.
    expect(
      svc
        .listOutboxEvents("grok@local", { home, consumerId: "wake:test" })
        .map((e) => e.sequence),
    ).toEqual(events.slice(2).map((e) => e.sequence));
  });

  it("retain-after lowers the watermark", () => {
    const home = freshHome("retain-floor");
    seed(home, 4);
    const events = svc.listOutboxEvents("grok@local", { home });
    svc.ackOutbox("wake:test", "grok@local", events[3]!.sequence, { home });

    expect(
      svc.purgeOutbox({ home, retainAfterSequence: events[0]!.sequence }),
    ).toBe(1);
    expect(svc.listOutboxEvents("grok@local", { home })).toHaveLength(3);
  });

  it("never purges a recipient that has no consumer", () => {
    const home = freshHome("retain-unattached");
    seed(home, 2);
    const other = svc.send({
      from_id: "grok@local",
      to: "claude-code@local",
      type: "message",
      body: "unattached recipient",
      home,
    });
    const events = svc.listOutboxEvents("grok@local", { home });
    svc.ackOutbox("wake:test", "grok@local", events[1]!.sequence, { home });

    svc.purgeOutbox({ home });
    // sequence is a global AUTOINCREMENT: a global watermark would have taken
    // claude-code@local's pending hint with it.
    expect(
      svc.listOutboxEvents("claude-code@local", { home }).map((e) => e.message_id),
    ).toEqual([other.id]);
  });

  it("rejects a negative retain floor", () => {
    const home = freshHome("retain-invalid");
    expect(() => svc.purgeOutbox({ home, retainAfterSequence: -1 })).toThrow(
      /retain_after_sequence/,
    );
  });
});
