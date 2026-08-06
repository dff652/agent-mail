/**
 * Atomic text write with fsync.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class FileLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockError";
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

export function atomicWriteText(
  targetPath: string,
  text: string,
  mode = 0o600,
): void {
  const target = path.resolve(targetPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const fd = fs.openSync(
      tmp,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      mode,
    );
    try {
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, mode);
    } catch {
      /* best-effort on platforms that ignore mode */
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  created_at: string;
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockDirectory: string): LockOwner | null {
  const ownerPath = path.join(lockDirectory, "owner.json");
  try {
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const raw = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Partial<LockOwner>;
    if (
      typeof raw.token !== "string" ||
      !Number.isInteger(raw.pid) ||
      typeof raw.hostname !== "string" ||
      typeof raw.created_at !== "string"
    ) {
      return null;
    }
    return raw as LockOwner;
  } catch {
    return null;
  }
}

function lockAgeMs(lockDirectory: string, owner: LockOwner | null): number {
  const ownerTime = owner ? Date.parse(owner.created_at) : Number.NaN;
  if (Number.isFinite(ownerTime)) return Math.max(0, Date.now() - ownerTime);
  try {
    return Math.max(0, Date.now() - fs.statSync(lockDirectory).mtimeMs);
  } catch {
    return 0;
  }
}

function removeStaleLock(lockDirectory: string): boolean {
  const quarantine = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(lockDirectory, quarantine);
  } catch (error) {
    if (
      ["ENOENT", "EEXIST", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return false;
    }
    throw error;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

/**
 * Cross-process read/modify/write lock using atomic directory creation.
 *
 * Acquisition is synchronous and returns an idempotent release lease so an
 * asynchronous caller can hold the same portable, symlink-safe lock.
 */
export function acquireFileLockSync(
  targetPath: string,
  options: FileLockOptions = {},
): () => void {
  const target = path.resolve(targetPath);
  const lockDirectory = `${target}.lock`;
  const parent = path.dirname(lockDirectory);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 300_000;
  const pollMs = options.pollMs ?? 20;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isInteger(staleMs) ||
    staleMs < 1_000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 1_000
  ) {
    throw new FileLockError("invalid file lock timing options");
  }

  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new FileLockError(`lock parent must be a real directory: ${parent}`);
  }
  try {
    fs.chmodSync(parent, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }

  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    created_at: new Date().toISOString(),
  };
  const started = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      owner.created_at = new Date().toISOString();
      const ownerPath = path.join(lockDirectory, "owner.json");
      const fd = fs.openSync(
        ownerPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        try {
          if (readOwner(lockDirectory)?.token === owner.token) {
            const failedPath =
              `${lockDirectory}.failed.${process.pid}.${owner.token}`;
            fs.renameSync(lockDirectory, failedPath);
            fs.rmSync(failedPath, { recursive: true, force: true });
          }
        } catch {
          // A later stale-lock pass can recover an incomplete acquisition.
        }
        throw new FileLockError(
          `cannot acquire file lock ${lockDirectory}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(lockDirectory);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new FileLockError(
          `refusing non-directory or symlink lock path: ${lockDirectory}`,
        );
      }
      const currentOwner = readOwner(lockDirectory);
      const stale = lockAgeMs(lockDirectory, currentOwner) >= staleMs;
      const aliveHere =
        currentOwner?.hostname === os.hostname() &&
        processAlive(currentOwner.pid);
      if (stale && !aliveHere && removeStaleLock(lockDirectory)) continue;
      if (Date.now() - started >= timeoutMs) {
        throw new FileLockError(`timed out waiting for file lock: ${lockDirectory}`);
      }
      sleepSync(pollMs);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readOwner(lockDirectory);
    if (current?.token === owner.token) {
      const releasePath = `${lockDirectory}.release.${process.pid}.${owner.token}`;
      try {
        fs.renameSync(lockDirectory, releasePath);
        if (readOwner(releasePath)?.token === owner.token) {
          fs.rmSync(releasePath, { recursive: true, force: true });
        } else if (!fs.existsSync(lockDirectory)) {
          // Restore an unexpected replacement rather than deleting it.
          fs.renameSync(releasePath, lockDirectory);
        }
      } catch {
        // Never remove an unverified/new owner's lock. A stale pass can recover.
      }
    }
  };
}

export function withFileLockSync<T>(
  targetPath: string,
  fn: () => T,
  options: FileLockOptions = {},
): T {
  const release = acquireFileLockSync(targetPath, options);
  try {
    return fn();
  } finally {
    release();
  }
}

/** Process-local async mutex retained for non-file callers. */
const pathLocks = new Map<string, Promise<void>>();

export async function withPathLock<T>(
  lockKey: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = path.resolve(lockKey);
  const prev = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const queued = prev.then(() => gate);
  pathLocks.set(key, queued);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === queued) pathLocks.delete(key);
  }
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-mail-"));
}
