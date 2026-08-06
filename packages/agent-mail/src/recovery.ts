import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { AgentMailError } from "./errors.js";
import { loadPolicy } from "./policy.js";
import { loadRoster } from "./roster.js";
import { listSettings } from "./settings.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { AGENT_MAIL_VERSION } from "./version.js";

const MANIFEST_NAME = "manifest.json";
const DATA_DIRECTORY = "data";
const BACKUP_SCHEMA_VERSION = 1;
const REQUIRED_FILES = [
  "config.json",
  "agents.json",
  "policy.yaml",
  "store.sqlite",
] as const;
const OPTIONAL_TOP_LEVEL_FILES = [
  "connection.json",
  "federation_pull_dlq.sqlite",
] as const;
const SQLITE_PATHS = new Set([
  "store.sqlite",
  "federation_pull_dlq.sqlite",
  "auth/pairing.sqlite",
]);
const SQLITE_SIDECAR_RE = /(?:-wal|-shm|-journal)$/;

export interface BackupFile {
  path: string;
  kind: "file" | "sqlite";
  size: number;
  sha256: string;
  mode: number;
}

export interface BackupManifest {
  schema_version: 1;
  product: "agent-mail";
  created_at: string;
  created_with: string;
  consistency: "stopped-writers-required";
  files: BackupFile[];
}

export interface BackupSummary {
  archive: string;
  created_at: string;
  created_with: string;
  files: number;
  bytes: number;
}

export class RecoveryError extends AgentMailError {
  constructor(message: string, exitCode = 3) {
    super(message, exitCode);
    this.name = "RecoveryError";
  }
}

function modeOf(stat: fs.Stats): number {
  return stat.mode & 0o777;
}

function restoredMode(relative: string, sourceMode: number): number {
  if (
    relative === "connection.json" ||
    relative.startsWith("auth/") ||
    SQLITE_PATHS.has(relative)
  ) {
    return 0o600;
  }
  return 0o600 | (sourceMode & 0o044);
}

function requirePrivateMode(filename: string, stat: fs.Stats): void {
  if (process.platform !== "win32" && (modeOf(stat) & 0o077) !== 0) {
    throw new RecoveryError(
      `backup path is accessible to group/other; require chmod 700 for directories and 600 for files: ${filename}`,
    );
  }
}

function ensureRealDirectory(directory: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new RecoveryError(`${label} not found: ${directory}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RecoveryError(`${label} must be a real directory: ${directory}`);
  }
}

function ensureInitializedHome(home: string): string {
  const resolved = path.resolve(home);
  ensureRealDirectory(resolved, "Agent Mail home");
  for (const relative of REQUIRED_FILES) {
    const target = path.join(resolved, ...relative.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      throw new RecoveryError(`required state file missing: ${relative}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RecoveryError(`required state path must be a real file: ${relative}`);
    }
  }
  return resolved;
}

function isAllowedRelative(relative: string): boolean {
  if (
    !relative ||
    relative.includes("\\") ||
    relative.startsWith("/") ||
    path.posix.normalize(relative) !== relative ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return false;
  }
  return (
    [...REQUIRED_FILES, ...OPTIONAL_TOP_LEVEL_FILES].includes(
      relative as (typeof REQUIRED_FILES)[number],
    ) || relative.startsWith("auth/")
  );
}

function archivePath(root: string, relative: string): string {
  if (!isAllowedRelative(relative)) {
    throw new RecoveryError(`unsafe backup path: ${JSON.stringify(relative)}`);
  }
  return path.join(root, DATA_DIRECTORY, ...relative.split("/"));
}

function privateMkdir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function hashFile(filename: string): { sha256: string; size: number } {
  const hash = createHash("sha256");
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let size = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest("hex"), size };
}

function copyRegularFile(
  source: string,
  destination: string,
  destinationMode: number,
): void {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new RecoveryError(`state path must be a real file: ${source}`);
  }
  privateMkdir(path.dirname(destination));
  const sourceFd = fs.openSync(
    source,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const destinationFd = fs.openSync(
    destination,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0),
    destinationMode,
  );
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let written = 0;
      while (written < read) {
        const count = fs.writeSync(
          destinationFd,
          buffer,
          written,
          read - written,
        );
        if (count < 1) {
          throw new RecoveryError(`short write while copying state: ${destination}`);
        }
        written += count;
      }
    }
    fs.fsyncSync(destinationFd);
    try {
      fs.fchmodSync(destinationFd, destinationMode);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  } finally {
    fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function collectAuthFiles(home: string): string[] {
  const auth = path.join(home, "auth");
  if (!fs.existsSync(auth)) return [];
  ensureRealDirectory(auth, "auth directory");
  const result: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    requirePrivateMode(directory, fs.lstatSync(directory));
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new RecoveryError(`refusing symlink in auth state: ${relative}`);
      }
      if (stat.isDirectory()) {
        if (name.endsWith(".lock")) {
          throw new RecoveryError(
            `active or stale auth lock present: ${relative}; stop writers and clear only a verified stale lock`,
          );
        }
        walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new RecoveryError(`unsupported auth state path: ${relative}`);
      }
      if (SQLITE_SIDECAR_RE.test(name)) continue;
      requirePrivateMode(absolute, stat);
      result.push(relative);
    }
  };

  walk(auth, "auth");
  return result;
}

async function snapshotSqlite(source: string, destination: string): Promise<void> {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RecoveryError(`SQLite state must be a real file: ${source}`);
  }
  privateMkdir(path.dirname(destination));
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  // A backup is deliberately a single self-contained database file. Source
  // stores may use WAL, but carrying that journal mode into the archive makes
  // even a read-only verification create -wal/-shm sidecars in the archive.
  const snapshot = new Database(destination);
  try {
    snapshot.pragma("journal_mode = DELETE");
    const rows = snapshot.pragma("quick_check") as Array<Record<string, unknown>>;
    const checks = rows.map((row) =>
      String(row.quick_check ?? Object.values(row)[0] ?? "unknown"),
    );
    if (checks.length !== 1 || checks[0] !== "ok") {
      throw new RecoveryError(
        `SQLite snapshot quick_check failed: ${checks.join("; ")}`,
      );
    }
  } finally {
    snapshot.close();
  }
  try {
    fs.chmodSync(destination, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function manifestEntry(
  filename: string,
  relative: string,
  kind: BackupFile["kind"],
  sourceMode: number,
): BackupFile {
  const digest = hashFile(filename);
  return {
    path: relative,
    kind,
    size: digest.size,
    sha256: digest.sha256,
    mode: sourceMode,
  };
}

function writePrivateJson(filename: string, value: unknown): void {
  const fd = fs.openSync(
    filename,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function createBackup(
  home: string,
  outputDirectory: string,
): Promise<BackupSummary> {
  const sourceHome = ensureInitializedHome(home);
  const archive = path.resolve(outputDirectory);
  if (fs.existsSync(archive)) {
    throw new RecoveryError(`backup output already exists: ${archive}`, 2);
  }
  if (
    archive === sourceHome ||
    archive.startsWith(`${sourceHome}${path.sep}`)
  ) {
    throw new RecoveryError("backup output must be outside the Agent Mail home", 2);
  }

  let created = false;
  try {
    privateMkdir(archive);
    created = true;
    privateMkdir(path.join(archive, DATA_DIRECTORY));
    const relatives = [
      ...REQUIRED_FILES,
      ...OPTIONAL_TOP_LEVEL_FILES.filter((relative) =>
        fs.existsSync(path.join(sourceHome, relative)),
      ),
      ...collectAuthFiles(sourceHome),
    ];
    const unique = [...new Set(relatives)].sort();
    const entries: BackupFile[] = [];
    for (const relative of unique) {
      const source = path.join(sourceHome, ...relative.split("/"));
      const destination = archivePath(archive, relative);
      const sourceStat = fs.lstatSync(source);
      if (SQLITE_PATHS.has(relative)) {
        await snapshotSqlite(source, destination);
        entries.push(
          manifestEntry(
            destination,
            relative,
            "sqlite",
            restoredMode(relative, modeOf(sourceStat)),
          ),
        );
      } else {
        copyRegularFile(source, destination, 0o600);
        entries.push(
          manifestEntry(
            destination,
            relative,
            "file",
            restoredMode(relative, modeOf(sourceStat)),
          ),
        );
      }
    }

    const manifest: BackupManifest = {
      schema_version: BACKUP_SCHEMA_VERSION,
      product: "agent-mail",
      created_at: new Date().toISOString(),
      created_with: AGENT_MAIL_VERSION,
      consistency: "stopped-writers-required",
      files: entries,
    };
    writePrivateJson(path.join(archive, MANIFEST_NAME), manifest);
    return {
      archive,
      created_at: manifest.created_at,
      created_with: manifest.created_with,
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  } catch (error) {
    if (created) {
      fs.rmSync(archive, { recursive: true, force: true });
    }
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError(
      `backup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseManifest(archive: string): BackupManifest {
  const manifestPath = path.join(archive, MANIFEST_NAME);
  let raw: unknown;
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("manifest must be a real file");
    }
    if (stat.size > 4 * 1024 * 1024) {
      throw new Error("manifest exceeds 4 MiB limit");
    }
    requirePrivateMode(manifestPath, stat);
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new RecoveryError(
      `invalid backup manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RecoveryError("invalid backup manifest object");
  }
  const candidate = raw as Partial<BackupManifest>;
  if (
    candidate.schema_version !== BACKUP_SCHEMA_VERSION ||
    candidate.product !== "agent-mail" ||
    typeof candidate.created_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.created_at)) ||
    typeof candidate.created_with !== "string" ||
    candidate.consistency !== "stopped-writers-required" ||
    !Array.isArray(candidate.files) ||
    candidate.files.length > 10_000
  ) {
    throw new RecoveryError("unsupported or malformed backup manifest");
  }
  return candidate as BackupManifest;
}

function listDataFiles(dataRoot: string): string[] {
  ensureRealDirectory(dataRoot, "backup data directory");
  const result: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    requirePrivateMode(directory, fs.lstatSync(directory));
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new RecoveryError(`refusing symlink in backup data: ${relative}`);
      }
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (stat.isFile()) {
        result.push(relative);
      } else {
        throw new RecoveryError(`unsupported backup data path: ${relative}`);
      }
    }
  };
  walk(dataRoot, "");
  return result;
}

function checkSqlite(filename: string, relative: string): void {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("quick_check") as Array<Record<string, unknown>>;
    const checks = rows.map((row) =>
      String(row.quick_check ?? Object.values(row)[0] ?? "unknown"),
    );
    if (checks.length !== 1 || checks[0] !== "ok") {
      throw new RecoveryError(
        `SQLite quick_check failed for ${relative}: ${checks.join("; ")}`,
      );
    }
  } finally {
    db.close();
  }
}

export function verifyBackup(inputDirectory: string): BackupSummary {
  const archive = path.resolve(inputDirectory);
  ensureRealDirectory(archive, "backup archive");
  requirePrivateMode(archive, fs.lstatSync(archive));
  const manifest = parseManifest(archive);
  const seen = new Set<string>();
  for (const required of REQUIRED_FILES) {
    if (!manifest.files.some((entry) => entry.path === required)) {
      throw new RecoveryError(`backup missing required state: ${required}`);
    }
  }
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !isAllowedRelative(entry.path) ||
      (entry.kind !== "file" && entry.kind !== "sqlite") ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      (entry.mode & 0o111) !== 0 ||
      (entry.mode & 0o022) !== 0 ||
      (entry.mode & 0o400) === 0 ||
      ((entry.path === "connection.json" ||
        entry.path.startsWith("auth/") ||
        SQLITE_PATHS.has(entry.path)) &&
        entry.mode !== 0o600)
    ) {
      throw new RecoveryError("malformed backup file entry");
    }
    if (seen.has(entry.path)) {
      throw new RecoveryError(`duplicate backup file entry: ${entry.path}`);
    }
    seen.add(entry.path);
    if (SQLITE_PATHS.has(entry.path) !== (entry.kind === "sqlite")) {
      throw new RecoveryError(`backup file kind mismatch: ${entry.path}`);
    }
    const filename = archivePath(archive, entry.path);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filename);
    } catch {
      throw new RecoveryError(`backup data missing: ${entry.path}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RecoveryError(`backup data must be a real file: ${entry.path}`);
    }
    requirePrivateMode(filename, stat);
    const digest = hashFile(filename);
    if (digest.size !== entry.size || digest.sha256 !== entry.sha256) {
      throw new RecoveryError(`backup checksum mismatch: ${entry.path}`);
    }
    if (entry.kind === "sqlite") checkSqlite(filename, entry.path);
  }
  const dataRoot = path.join(archive, DATA_DIRECTORY);
  requirePrivateMode(dataRoot, fs.lstatSync(dataRoot));
  const actual = listDataFiles(dataRoot);
  if (
    actual.length !== seen.size ||
    actual.some((relative) => !seen.has(relative))
  ) {
    throw new RecoveryError("backup data contains unmanifested files");
  }
  return {
    archive,
    created_at: manifest.created_at,
    created_with: manifest.created_with,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, entry) => sum + entry.size, 0),
  };
}

function validateRestoredHome(home: string): void {
  listSettings(home);
  loadPolicy(home);
  loadRoster(home);
  const store = new SqliteStore(home);
  store.ensureReady();
  const diagnostics = store.diagnostics();
  if (
    diagnostics.integrity.length !== 1 ||
    diagnostics.integrity[0] !== "ok"
  ) {
    throw new RecoveryError(
      `restored store quick_check failed: ${diagnostics.integrity.join("; ")}`,
    );
  }
}

export function restoreBackup(
  inputDirectory: string,
  targetHome: string,
): BackupSummary & { restored_home: string } {
  const summary = verifyBackup(inputDirectory);
  const archive = summary.archive;
  const manifest = parseManifest(archive);
  const destination = path.resolve(targetHome);
  if (fs.existsSync(destination)) {
    throw new RecoveryError(
      `restore target already exists: ${destination}; restore into a new project and switch over after verification`,
      2,
    );
  }
  const project = path.dirname(destination);
  if (!fs.existsSync(project)) {
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  }
  ensureRealDirectory(project, "restore project directory");
  const staging = path.join(
    project,
    `.${path.basename(destination)}.restore-${randomUUID()}`,
  );
  privateMkdir(staging);
  try {
    for (const entry of manifest.files) {
      const source = archivePath(archive, entry.path);
      const target = path.join(staging, ...entry.path.split("/"));
      copyRegularFile(source, target, entry.mode);
    }
    validateRestoredHome(staging);
    // Node does not expose renameat2(RENAME_NOREPLACE). Recheck immediately
    // before the atomic rename so a target created during validation is not
    // knowingly replaced. Operators must still keep the new target path
    // reserved while restore runs.
    if (fs.existsSync(destination)) {
      throw new RecoveryError(
        `restore target appeared during validation: ${destination}; refusing to replace it`,
        2,
      );
    }
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError(
      `restore failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ...summary, restored_home: destination };
}
