import { createMessage, type Message, type MessageType } from "../models.js";
import { newTaskId, newThreadId } from "../ids.js";
import {
  defaultRoster,
  loadRoster,
  rosterHas,
  saveRoster,
} from "../roster.js";
import { SqliteStore } from "../store/sqlite-store.js";
import {
  FederationError,
  loadLocalDomain,
  parseAgentDomain,
  requirePeerForDomain,
  validateDomain,
} from "./peers.js";

export interface FederationEnvelope {
  message_id: string;
  thread_id: string | null;
  task_id: string | null;
  type: string;
  from: string;
  to: string;
  effect_level: string;
  requires_human_approval: boolean;
  body_md: string;
  ts: string | null;
  origin_domain: string | null;
}

export function buildEnvelopeFromMessage(
  message: Message,
  originDomain: string,
): FederationEnvelope {
  return {
    message_id: message.id,
    thread_id: message.thread_id,
    task_id: message.task_id,
    type: message.type,
    from: message.from_id,
    to: message.to,
    effect_level: message.effect_level,
    requires_human_approval: message.requires_human_approval,
    body_md: message.body_md,
    ts: message.ts.toISOString(),
    origin_domain: originDomain,
  };
}

export function parseEnvelope(raw: Record<string, unknown>): FederationEnvelope {
  const type = String(raw.type || raw.message_type || "message");
  const message_id = String(raw.message_id || "");
  if (!/^msg_[A-Za-z0-9_-]+$/.test(message_id)) {
    throw new FederationError(`invalid message_id: ${message_id}`, 2);
  }
  return {
    message_id,
    thread_id: raw.thread_id != null ? String(raw.thread_id) : null,
    task_id: raw.task_id != null ? String(raw.task_id) : null,
    type,
    from: String(raw.from || ""),
    to: String(raw.to || ""),
    effect_level: String(raw.effect_level || "none"),
    requires_human_approval: Boolean(raw.requires_human_approval),
    body_md: String(raw.body_md || ""),
    ts: raw.ts != null ? String(raw.ts) : null,
    origin_domain: raw.origin_domain != null ? String(raw.origin_domain) : null,
  };
}

/**
 * Enqueue foreign send: audit message copy + federation outbox (same SQLite txn).
 */
export function enqueueForeign(home: string, message: Message): Message {
  const local = loadLocalDomain(home);
  if (!local) {
    throw new FederationError("local_domain not set; federation set-domain first");
  }
  const { domain } = parseAgentDomain(message.to);
  if (domain === local || domain === "local") {
    throw new FederationError("recipient is not foreign");
  }
  requirePeerForDomain(home, domain);

  let msg: Message = {
    ...message,
    meta: {
      ...message.meta,
      schema_version: "0.2",
      federated_outbound: true,
      origin_domain: local,
    },
  };
  if (!msg.thread_id) {
    msg = { ...msg, thread_id: newThreadId() };
  }
  if (msg.type === "task" && !msg.task_id) {
    msg = { ...msg, task_id: newTaskId() };
  }

  const envelope = buildEnvelopeFromMessage(msg, local);
  const store = new SqliteStore(home);
  store.ensureReady();
  // Idempotent re-send of same message_id: return existing without re-queue.
  const existing = store.getMessage(msg.id);
  if (existing) {
    return existing;
  }
  return store.enqueueFederatedMessage(msg, buildEnvelopeRecord(envelope));
}

/**
 * Import federated envelope into local store.
 * Validation/roster prep outside txn; business rows + wake + dedup atomic.
 */
export function importEnvelope(
  home: string,
  raw: Record<string, unknown>,
  peerDomain: string,
  opts: { autoStubSender?: boolean } = {},
): "imported" | "duplicate" {
  const autoStubSender = opts.autoStubSender !== false;
  const peer = validateDomain(peerDomain);
  const local = loadLocalDomain(home);
  if (!local) {
    throw new FederationError("local_domain not configured on this hub", 3);
  }

  const env = parseEnvelope(raw);
  const { domain: toDomain } = parseAgentDomain(env.to);
  if (toDomain !== local) {
    throw new FederationError("domain_mismatch: recipient not for this hub", 2);
  }
  const { domain: fromDomain } = parseAgentDomain(env.from);
  if (fromDomain !== peer) {
    throw new FederationError("envelope from domain does not match peer", 2);
  }

  const roster = loadRoster(home);
  if (!rosterHas(roster, env.to)) {
    throw new FederationError(`recipient not in local roster: ${env.to}`, 4);
  }
  if (!rosterHas(roster, env.from)) {
    if (!autoStubSender) {
      throw new FederationError(`sender not in local roster: ${env.from}`, 4);
    }
    ensureAgentStub(home, env.from);
  }

  const allowedTypes = new Set([
    "message",
    "task",
    "done",
    "error",
    "question",
    "escalate",
    "status",
    "cancel",
  ]);
  if (!allowedTypes.has(env.type)) {
    throw new FederationError(`invalid message type: ${env.type}`, 2);
  }
  const allowedEffects = new Set(["none", "read", "write", "dangerous"]);
  if (!allowedEffects.has(env.effect_level)) {
    throw new FederationError(`invalid effect_level: ${env.effect_level}`, 2);
  }
  if (env.type === "task" && (!env.task_id || !env.thread_id)) {
    throw new FederationError("federated task requires task_id and thread_id", 2);
  }

  const msg = createMessage({
    id: env.message_id,
    from_id: env.from,
    to: env.to,
    type: env.type as MessageType,
    body_md: env.body_md,
    thread_id: env.thread_id,
    task_id: env.task_id,
    effect_level: env.effect_level as Message["effect_level"],
    requires_human_approval: env.requires_human_approval,
  });
  msg.meta = {
    ...msg.meta,
    schema_version: "0.2",
    federated: true,
    origin_domain: fromDomain,
    peer_domain: peer,
  };
  if (env.ts) {
    const d = new Date(env.ts);
    if (!Number.isNaN(d.getTime())) msg.ts = d;
  }

  const store = new SqliteStore(home);
  store.ensureReady();
  try {
    const result = store.receiveFederatedMessage(msg, fromDomain);
    return result.status;
  } catch (e) {
    if (e instanceof FederationError) throw e;
    const errMsg = e instanceof Error ? e.message : String(e);
    throw new FederationError(`import failed: ${errMsg}`, 5);
  }
}

function ensureAgentStub(home: string, agentId: string): void {
  try {
    const roster = loadRoster(home);
    if (rosterHas(roster, agentId)) return;
    roster.agents.push({
      id: agentId,
      display_name: agentId.split("@", 1)[0] || agentId,
      skills: ["federated"],
    });
    roster.updated_at = new Date().toISOString();
    saveRoster(home, roster);
  } catch {
    const roster = defaultRoster();
    if (!rosterHas(roster, agentId)) {
      roster.agents.push({
        id: agentId,
        display_name: agentId.split("@", 1)[0] || agentId,
        skills: ["federated"],
      });
    }
    saveRoster(home, roster);
  }
}

export function buildEnvelopeRecord(env: FederationEnvelope): Record<string, unknown> {
  return {
    message_id: env.message_id,
    thread_id: env.thread_id,
    task_id: env.task_id,
    type: env.type,
    from: env.from,
    to: env.to,
    effect_level: env.effect_level,
    requires_human_approval: env.requires_human_approval,
    body_md: env.body_md,
    ts: env.ts,
    origin_domain: env.origin_domain,
  };
}
