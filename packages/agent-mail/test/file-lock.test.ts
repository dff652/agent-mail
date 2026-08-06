import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  atomicWriteText,
  FileLockError,
  withFileLockSync,
} from "../src/atomic-file.js";

function lockOwner(pid: number, createdAt: string): string {
  return `${JSON.stringify({
    token: "test-owner",
    pid,
    hostname: os.hostname(),
    created_at: createdAt,
  })}\n`;
}

describe("cross-process file lock", () => {
  it("atomically replaces a target symlink without writing through it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-atomic-"));
    const outside = path.join(dir, "outside");
    const target = path.join(dir, "state");
    fs.writeFileSync(outside, "outside remains unchanged\n", "utf8");
    fs.symlinkSync(outside, target);

    atomicWriteText(target, "private state\n", 0o600);

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("private state\n");
    expect(fs.readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
  });

  it("releases after success and callback failure", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-lock-"));
    const target = path.join(dir, "state");

    expect(withFileLockSync(target, () => "done")).toBe("done");
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
    expect(() =>
      withFileLockSync(target, () => {
        throw new Error("callback failed");
      }),
    ).toThrow(/callback failed/);
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
  });

  it("rejects a symlink at the lock path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-lock-"));
    const target = path.join(dir, "state");
    fs.symlinkSync(dir, `${target}.lock`);

    expect(() =>
      withFileLockSync(target, () => undefined, { timeoutMs: 0 }),
    ).toThrow(/symlink lock path/);
  });

  it("recovers an abandoned stale lock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-lock-"));
    const target = path.join(dir, "state");
    const lockDirectory = `${target}.lock`;
    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(
      path.join(lockDirectory, "owner.json"),
      lockOwner(2_147_483_647, new Date(Date.now() - 5_000).toISOString()),
    );

    let called = false;
    withFileLockSync(
      target,
      () => {
        called = true;
      },
      { timeoutMs: 100, staleMs: 1_000, pollMs: 5 },
    );
    expect(called).toBe(true);
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("times out instead of stealing a live process lock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-lock-"));
    const target = path.join(dir, "state");
    const lockDirectory = `${target}.lock`;
    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(
      path.join(lockDirectory, "owner.json"),
      lockOwner(process.pid, new Date(Date.now() - 5_000).toISOString()),
    );

    expect(() =>
      withFileLockSync(target, () => undefined, {
        timeoutMs: 20,
        staleMs: 1_000,
        pollMs: 5,
      }),
    ).toThrow(FileLockError);
    expect(fs.existsSync(lockDirectory)).toBe(true);
  });
});
