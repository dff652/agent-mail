import fs from "node:fs";
import path from "node:path";

export const RUNTIME_LOG = path.join("logs", "runtime.jsonl");
export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LOG_BACKUPS = 3;

const SENSITIVE_KEY = /(body|note|token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL = /\b(token|secret|password|api[_-]?key|authorization|cookie)\b(\s*[:=]\s*)([^\s,;]+)/gi;
const PRIVATE_KEY = /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/gi;

export interface RuntimeLogOptions {
  actor?: string | null;
  context?: Record<string, unknown>;
  error?: unknown;
  maxBytes?: number;
  backups?: number;
}

export interface ReadRuntimeLogOptions {
  limit?: number;
  outcome?: "success" | "error";
  operation?: string;
}

export function redactSensitiveText(value: string, limit = 1000): string {
  return value
    .replace(PRIVATE_KEY, "<redacted-private-key>")
    .replace(BEARER, "Bearer <redacted>")
    .replace(CREDENTIAL, "$1$2<redacted>")
    .slice(0, limit);
}

function safeValue(
  key: string,
  value: unknown,
  depth = 0,
): unknown {
  if (SENSITIVE_KEY.test(key)) return "<redacted>";
  if (depth >= 8) return "<max-depth>";
  if (typeof value === "string") return redactSensitiveText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => safeValue(key, item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([childKey, childValue]) => [
          childKey,
          safeValue(childKey, childValue, depth + 1),
        ]),
    );
  }
  return redactSensitiveText(String(value), 500);
}

export function redactSensitiveValue(value: unknown): unknown {
  return safeValue("value", value);
}

function regularOrMissing(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function privateLogDirectory(home: string): string | null {
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) return null;
  const directory = path.join(home, "logs");
  try {
    if (fs.existsSync(directory)) {
      if (!fs.lstatSync(directory).isDirectory()) return null;
    } else {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    fs.chmodSync(directory, 0o700);
    return directory;
  } catch {
    return null;
  }
}

function rotate(logPath: string, maxBytes: number, backups: number, incoming: number): boolean {
  if (!regularOrMissing(logPath)) return false;
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  if (size + incoming <= maxBytes) return true;
  if (backups < 1) {
    try {
      fs.truncateSync(logPath, 0);
      return true;
    } catch {
      return false;
    }
  }
  for (let index = backups; index >= 1; index -= 1) {
    const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
    const destination = `${logPath}.${index}`;
    if (!regularOrMissing(source) || !regularOrMissing(destination)) return false;
    if (!fs.existsSync(source)) continue;
    try {
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      fs.renameSync(source, destination);
    } catch {
      return false;
    }
  }
  return true;
}

export function appendRuntimeLog(
  home: string,
  operation: string,
  outcome: "success" | "error",
  options: RuntimeLogOptions = {},
): void {
  try {
    const directory = privateLogDirectory(path.resolve(home));
    if (!directory) return;
    const logPath = path.join(directory, "runtime.jsonl");
    const error = options.error;
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: error || outcome === "error" ? "error" : "info",
      operation: redactSensitiveText(operation, 160),
      outcome,
      actor:
        options.actor === undefined || options.actor === null
          ? null
          : redactSensitiveText(String(options.actor), 160),
      pid: process.pid,
      context: safeValue("context", options.context ?? {}),
    };
    if (error !== undefined) {
      payload.error_type =
        error instanceof Error ? error.name : typeof error;
      payload.error = redactSensitiveText(
        error instanceof Error ? error.message : String(error),
      );
    }
    const raw = `${JSON.stringify(payload)}\n`;
    const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    const backups = options.backups ?? DEFAULT_LOG_BACKUPS;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 256 ||
      !Number.isInteger(backups) ||
      backups < 0 ||
      backups > 20 ||
      !rotate(logPath, maxBytes, backups, Buffer.byteLength(raw))
    ) {
      return;
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const fd = fs.openSync(
      logPath,
      fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_WRONLY |
        noFollow,
      0o600,
    );
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, raw, null, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Runtime logging is best-effort and must not break mailbox operations.
  }
}

export function readRuntimeLogs(
  home: string,
  options: ReadRuntimeLogOptions = {},
): Array<Record<string, unknown>> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("log limit must be between 1 and 1000");
  }
  if (
    options.outcome !== undefined &&
    options.outcome !== "success" &&
    options.outcome !== "error"
  ) {
    throw new Error("log outcome must be success or error");
  }
  const logPath = path.join(path.resolve(home), RUNTIME_LOG);
  const files: string[] = [];
  for (let index = DEFAULT_LOG_BACKUPS; index >= 1; index -= 1) {
    const candidate = `${logPath}.${index}`;
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
      files.push(candidate);
    }
  }
  if (fs.existsSync(logPath) && fs.lstatSync(logPath).isFile()) {
    files.push(logPath);
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        entry =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { operation: "runtime.log.parse", outcome: "error" };
      } catch {
        entry = {
          ts: null,
          level: "error",
          operation: "runtime.log.parse",
          outcome: "error",
          error: "malformed JSONL entry",
        };
      }
      if (options.outcome && entry.outcome !== options.outcome) continue;
      if (options.operation && entry.operation !== options.operation) continue;
      entries.push(entry);
    }
  }
  return entries.slice(-limit).reverse();
}
