import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideSendPolicy } from "./domain/send-policy.js";
import {
  AgentMailError,
  ApprovalRequiredError,
  TaskTransitionError,
} from "./errors.js";
import { enqueueForeign } from "./federation/envelope.js";
import { FederationError, isForeignRecipient } from "./federation/peers.js";
import { validateAgentId } from "./ids.js";
import {
  createMessage,
  type Delivery,
  type Message,
  type MessageType,
} from "./models.js";
import { readRuntimeLogs } from "./observability.js";
import { loadPolicy } from "./policy.js";
import { isEffectLevel, isMessageType } from "./policy-shape.js";
import { defaultRoster, loadRoster, rosterHas, saveRoster } from "./roster.js";
import {
  getSetting,
  listSettings,
  mirrorErrors,
  settingDefault,
  settingOperationalWarnings,
  setSetting,
} from "./settings.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { AGENT_MAIL_VERSION } from "./version.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Behaviour-contract files copied into every project home. Agents are told to
 * read `.agent-mail/PROTOCOL.md`, so the mainline has to actually put it there
 * and the npm package has to carry it (evaluation P1-2).
 */
export const REFERENCE_FILES = [
  "PROTOCOL.md",
  "message.schema.json",
  "roster.schema.json",
] as const;

/** Packaged snapshot dir; falls back to the repo copy when running from src. */
export function referenceSourceDir(): string {
  const packaged = path.resolve(currentDir, "..", "refs");
  if (fs.existsSync(path.join(packaged, "PROTOCOL.md"))) return packaged;
  return path.resolve(currentDir, "..", "..", "..", "refs");
}

export function readReferenceFile(name: string): string {
  return fs.readFileSync(path.join(referenceSourceDir(), name), "utf8");
}

function referenceExistsSafely(destination: string, name: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AgentMailError(
      `reference must be a regular file, not a symlink or special entry: ${name}`,
      3,
    );
  }
  return true;
}

/** Create a missing reference without following a dangling-link or race target. */
function ensureReferenceFile(home: string, name: string): void {
  const destination = path.join(home, name);
  if (referenceExistsSafely(destination, name)) return;
  try {
    fs.writeFileSync(destination, readReferenceFile(name), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // A concurrent init may have won the exclusive create. Accept only the
      // same safe state we accept on the initial inspection.
      if (referenceExistsSafely(destination, name)) return;
    }
    throw error;
  }
}

export function defaultHome(cwd = process.cwd()): string {
  let cur = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, ".agent-mail");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.join(path.resolve(cwd), ".agent-mail");
}

function requireHome(home: string): string {
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    throw new AgentMailError(`not initialized: ${home}`, 3);
  }
  return home;
}

export function getStore(home?: string): SqliteStore {
  const h = home ?? defaultHome();
  const store = new SqliteStore(h);
  store.ensureReady();
  return store;
}

export function initProject(home?: string): string {
  const h = path.resolve(home ?? defaultHome());
  fs.mkdirSync(h, { recursive: true });
  for (const sub of ["docs", "export", "logs"]) {
    fs.mkdirSync(path.join(h, sub), { recursive: true });
  }
  const configPath = path.join(h, "config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          schema_version: "0.2",
          default_execution_mode: settingDefault("policy.default_execution_mode"),
          roster_mode: settingDefault("policy.roster_mode"),
          lease_seconds: settingDefault("project.lease_seconds"),
          remote_enabled: false,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
  const agentsPath = path.join(h, "agents.json");
  if (!fs.existsSync(agentsPath)) {
    saveRoster(h, defaultRoster());
  }
  const policyPath = path.join(h, "policy.yaml");
  if (!fs.existsSync(policyPath)) {
    fs.writeFileSync(
      policyPath,
      [
        `default_execution_mode: ${settingDefault("policy.default_execution_mode")}`,
        `roster_mode: ${settingDefault("policy.roster_mode")}`,
        `effect_rules: ${JSON.stringify(settingDefault("policy.effect_rules"))}`,
        `allow_edges: ${JSON.stringify(settingDefault("policy.allow_edges"))}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  for (const name of REFERENCE_FILES) {
    ensureReferenceFile(h, name);
  }
  getStore(h);
  return h;
}

export function configGet(key: string, opts: { home?: string } = {}) {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return getSetting(home, key);
}

export function configList(opts: { home?: string } = {}) {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return listSettings(home);
}

export function configSet(
  key: string,
  value: string,
  opts: { home?: string } = {},
) {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return setSetting(home, key, value);
}

export function configWarnings(key: string): string[] {
  return settingOperationalWarnings(key);
}

function loadLeaseSeconds(home: string): number {
  const fallback = Number(settingDefault("project.lease_seconds"));
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as {
      lease_seconds?: number;
    };
    return raw.lease_seconds ?? fallback;
  } catch {
    return fallback;
  }
}

export function send(opts: {
  from_id: string;
  to: string;
  type: MessageType | string;
  body: string;
  home?: string;
  thread_id?: string | null;
  task_id?: string | null;
  in_reply_to?: string | null;
  effect?: string;
  requires_human_approval?: boolean | null;
  doc_refs?: string[];
  message_id?: string | null;
}): Message {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const roster = loadRoster(home);
  const fromId = validateAgentId(opts.from_id);
  const to = validateAgentId(opts.to);
  if (!rosterHas(roster, fromId)) {
    throw new AgentMailError("from must be in roster", 4);
  }

  const foreign = isForeignRecipient(home, to);
  if (!foreign && !rosterHas(roster, to)) {
    throw new AgentMailError("from/to must be in roster", 4);
  }

  if (!isMessageType(opts.type)) {
    throw new AgentMailError(`unsupported message type: ${opts.type}`, 2);
  }
  const msgType = opts.type;
  if (
    (msgType === "done" || msgType === "error" || msgType === "cancel") &&
    (!opts.task_id || !opts.thread_id)
  ) {
    throw new AgentMailError(`${msgType} requires task_id and thread_id`, 2);
  }

  const rawEffect = opts.effect ?? "none";
  if (!isEffectLevel(rawEffect)) {
    throw new AgentMailError(`unsupported effect level: ${rawEffect}`, 2);
  }
  const effect = rawEffect;
  const decision = decideSendPolicy(loadPolicy(home), {
    fromId,
    to,
    type: msgType,
    effect,
    callerRequires: opts.requires_human_approval,
  });
  if (decision.outcome === "deny") {
    throw new AgentMailError(decision.reason || "policy denied send", 6);
  }

  // One store handle for the whole send: getStore() runs ensureReady(), so the
  // dedup lookup and the write used to migrate-check twice (evaluation P2-1).
  const store = getStore(home);
  if (opts.message_id) {
    const existing = store.getMessage(opts.message_id);
    if (existing) {
      if (existing.from_id !== fromId) {
        throw new AgentMailError("message id already used by another sender", 5);
      }
      return existing;
    }
  }

  const message = createMessage({
    from_id: fromId,
    to,
    type: msgType,
    body_md: opts.body,
    thread_id: opts.thread_id ?? null,
    task_id: opts.task_id ?? null,
    in_reply_to: opts.in_reply_to ?? null,
    effect_level: effect,
    requires_human_approval: decision.requires_human_approval,
    doc_refs: opts.doc_refs,
    id: opts.message_id ?? undefined,
  });

  try {
    if (foreign) {
      return enqueueForeign(home, message);
    }
    const { message: stored, approvalId } = store.sendMessage(message);
    if (approvalId) {
      stored.meta = { ...stored.meta, approval_id: approvalId };
    }
    return stored;
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      throw new AgentMailError(e.message, 6);
    }
    if (e instanceof TaskTransitionError) {
      throw new AgentMailError(e.message, 5);
    }
    if (e instanceof FederationError) {
      throw new AgentMailError(e.message, 5);
    }
    throw e;
  }
}

export function inbox(
  agentId: string,
  opts: { home?: string; allItems?: boolean } = {},
) {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const id = validateAgentId(agentId);
  if (!rosterHas(loadRoster(home), id)) {
    throw new AgentMailError(`agent not in roster: ${id}`, 4);
  }
  return getStore(home).inbox(id, !opts.allItems);
}

export function claim(
  messageId: string,
  agentId: string,
  opts: { home?: string } = {},
): Delivery {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  try {
    return getStore(home).claim(
      messageId,
      validateAgentId(agentId),
      loadLeaseSeconds(home),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AgentMailError(msg, 5);
  }
}

export function ack(
  messageId: string,
  agentId: string,
  opts: { home?: string } = {},
): Delivery {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  try {
    return getStore(home).ackDelivery(messageId, validateAgentId(agentId));
  } catch (e) {
    if (e instanceof TaskTransitionError) {
      throw new AgentMailError(e.message, 5);
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new AgentMailError(msg, 5);
  }
}

export function tail(opts: {
  home?: string;
  threadId?: string | null;
  limit?: number;
}): Message[] {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return getStore(home).listMessages({
    threadId: opts.threadId,
    limit: opts.limit,
  });
}

export function taskStatus(taskId: string, opts: { home?: string } = {}) {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return getStore(home).getTaskStatus(taskId);
}

export function listAgents(opts: { home?: string } = {}): string[] {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return loadRoster(home).agents.map((a) => a.id);
}

export function listEvents(
  opts: {
    home?: string;
    limit?: number;
    kind?: string | null;
    actor?: string | null;
    taskId?: string | null;
    threadId?: string | null;
  } = {},
): Array<Record<string, unknown>> {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return getStore(home).listEvents(opts);
}

export function listApprovals(
  opts: { home?: string; status?: string | null } = {},
): Array<Record<string, unknown>> {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return getStore(home).listApprovals(opts.status);
}

export function getApprovalForTask(
  taskId: string,
  opts: { home?: string } = {},
): Record<string, unknown> | null {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  return getStore(home).getApprovalForTask(taskId);
}

export function approve(
  approvalId: string,
  actor = "human@local",
  opts: { home?: string; note?: string } = {},
): Record<string, unknown> {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const id = validateAgentId(actor);
  if (id !== "human@local") {
    throw new AgentMailError("only human@local may approve", 6);
  }
  try {
    return getStore(home).setApproval(approvalId, id, "approved", opts.note ?? "");
  } catch (e) {
    throw new AgentMailError(e instanceof Error ? e.message : String(e), 5);
  }
}

export function reject(
  approvalId: string,
  actor = "human@local",
  opts: { home?: string; note?: string } = {},
): Record<string, unknown> {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const id = validateAgentId(actor);
  if (id !== "human@local") {
    throw new AgentMailError("only human@local may reject", 6);
  }
  try {
    return getStore(home).setApproval(approvalId, id, "rejected", opts.note ?? "");
  } catch (e) {
    throw new AgentMailError(e instanceof Error ? e.message : String(e), 5);
  }
}

export function listOutboxEvents(
  recipient: string,
  opts: {
    home?: string;
    afterSequence?: number;
    limit?: number;
    consumerId?: string | null;
  } = {},
) {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const id = validateAgentId(recipient);
  if (!rosterHas(loadRoster(home), id)) {
    throw new AgentMailError(`agent not in roster: ${id}`, 4);
  }
  const store = getStore(home);
  let after = opts.afterSequence ?? 0;
  if (opts.consumerId) {
    after = Math.max(after, store.getOutboxCursor(opts.consumerId, id));
  }
  return store.listOutboxEvents(id, after, opts.limit ?? 100);
}

export function ackOutbox(
  consumerId: string,
  recipient: string,
  sequence: number,
  opts: { home?: string } = {},
): number {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const id = validateAgentId(recipient);
  if (!rosterHas(loadRoster(home), id)) {
    throw new AgentMailError(`agent not in roster: ${id}`, 4);
  }
  try {
    return getStore(home).ackOutboxCursor(consumerId, id, sequence);
  } catch (e) {
    throw new AgentMailError(e instanceof Error ? e.message : String(e), 2);
  }
}

/**
 * Purge acknowledged wake hints. Without this the outbox only ever grows, which
 * matters for long-lived bridges and duration soaks (evaluation P1-3).
 */
export function purgeOutbox(
  opts: { home?: string; retainAfterSequence?: number | null } = {},
): number {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const retain = opts.retainAfterSequence;
  if (
    retain !== undefined &&
    retain !== null &&
    (!Number.isInteger(retain) || retain < 0)
  ) {
    throw new AgentMailError("retain_after_sequence must be >= 0", 2);
  }
  return getStore(home).purgeOutboxEvents(retain);
}

export function backfillOutbox(
  recipient: string,
  opts: { home?: string } = {},
): number {
  const home = requireHome(path.resolve(opts.home ?? defaultHome()));
  const id = validateAgentId(recipient);
  if (!rosterHas(loadRoster(home), id)) {
    throw new AgentMailError(`agent not in roster: ${id}`, 4);
  }
  return getStore(home).backfillMissingOutbox(id);
}

export function diagnose(opts: { home?: string } = {}): Record<string, unknown> {
  const homePath = path.resolve(opts.home ?? defaultHome());
  let exists = false;
  try {
    exists = fs.statSync(homePath).isDirectory();
  } catch {
    exists = false;
  }
  const warnings: string[] = [];
  let agents: string[] = [];
  let runtimeLogs: Array<Record<string, unknown>> = [];
  let agentIdEnv: string | null = null;
  let database: Record<string, unknown> = {
    integrity: ["home missing"],
    path: path.join(homePath, "store.sqlite"),
  };
  if (exists) {
    const rawAgentId = (process.env.AGENT_MAIL_ID ?? "").trim();
    if (rawAgentId) {
      try {
        agentIdEnv = validateAgentId(rawAgentId);
      } catch {
        warnings.push("AGENT_MAIL_ID is invalid");
      }
    }
    try {
      agents = listAgents({ home: homePath });
    } catch (error) {
      warnings.push(
        `roster: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      warnings.push(...mirrorErrors(homePath).map((item) => `settings: ${item}`));
    } catch (error) {
      warnings.push(
        `settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      loadPolicy(homePath);
    } catch (error) {
      warnings.push(
        `policy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      database = {
        ...getStore(homePath).diagnostics(),
        path: path.join(homePath, "store.sqlite"),
      };
    } catch (e) {
      database = {
        integrity: [e instanceof Error ? e.message : "error"],
        path: path.join(homePath, "store.sqlite"),
      };
    }
    try {
      runtimeLogs = readRuntimeLogs(homePath, { limit: 20 });
    } catch (error) {
      warnings.push(
        `runtime logs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    home: homePath,
    home_exists: exists,
    agent_id_env: agentIdEnv,
    implementation: "typescript",
    version: AGENT_MAIL_VERSION,
    phase: "ts-operations",
    agents,
    database,
    runtime_logs: runtimeLogs,
    warnings,
  };
}

/** Resolve AGENT_MAIL_HOME / default for MCP and CLI. */
export function resolveHomeFromEnv(): string {
  const raw = (process.env.AGENT_MAIL_HOME ?? "").trim();
  if (raw) {
    const p = path.resolve(raw);
    return path.basename(p) === ".agent-mail" ? p : path.join(p, ".agent-mail");
  }
  return defaultHome();
}

export function requireAgentIdEnv(): string {
  const aid = (process.env.AGENT_MAIL_ID ?? "").trim();
  if (!aid) {
    throw new AgentMailError("AGENT_MAIL_ID is required", 2);
  }
  return validateAgentId(aid);
}
