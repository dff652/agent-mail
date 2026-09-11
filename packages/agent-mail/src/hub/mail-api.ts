import { AgentMailError } from "../errors.js";
import { dtToIso, validateAgentId } from "../ids.js";
import type { Message } from "../models.js";
import * as svc from "../services.js";

export class MailApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MailApiError";
    this.status = status;
  }
}

function forbidIdentityOverride(payload: Record<string, unknown>, agentId: string): void {
  for (const key of ["from", "from_id", "as", "actor", "agent_id", "sender"]) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") {
      throw new MailApiError(`${JSON.stringify(key)} must be a string if present`, 400);
    }
    let claimed: string;
    try {
      claimed = validateAgentId(value);
    } catch (e) {
      throw new MailApiError(e instanceof Error ? e.message : String(e), 400);
    }
    if (claimed !== agentId) {
      throw new MailApiError(
        `identity is derived from the bearer token; cannot act as ${JSON.stringify(claimed)}`,
        403,
      );
    }
  }
}

function mapAgentError(error: AgentMailError): never {
  let status = 400;
  if (error.exitCode === 4) status = 404;
  else if (error.exitCode === 6) status = 403;
  else if (error.exitCode === 5) status = 409;
  throw new MailApiError(error.message, status);
}

export function messagePublic(msg: Message): Record<string, unknown> {
  return {
    id: msg.id,
    from: msg.from_id,
    to: msg.to,
    type: msg.type,
    thread_id: msg.thread_id,
    task_id: msg.task_id,
    in_reply_to: msg.in_reply_to,
    body_md: msg.body_md,
    effect_level: msg.effect_level,
    requires_human_approval: msg.requires_human_approval,
    doc_refs: [...msg.doc_refs],
    ts: msg.ts.toISOString(),
  };
}

function parseApprovalFlag(payload: Record<string, unknown>): boolean | null {
  const canonical = payload.requires_human_approval;
  const legacy = payload.require_approval;
  if (canonical !== undefined && typeof canonical !== "boolean") {
    throw new MailApiError("'requires_human_approval' must be a boolean");
  }
  if (legacy !== undefined && typeof legacy !== "boolean") {
    throw new MailApiError("'require_approval' must be a boolean");
  }
  if (
    canonical !== undefined &&
    legacy !== undefined &&
    canonical !== legacy
  ) {
    throw new MailApiError(
      "'requires_human_approval' conflicts with legacy 'require_approval'",
    );
  }
  if (typeof canonical === "boolean") return canonical;
  return typeof legacy === "boolean" ? legacy : null;
}

function normalizeSentCursor(value: string): string | null {
  const separator = value.indexOf("|");
  const rawTimestamp = separator >= 0 ? value.slice(0, separator) : value;
  const messageId = separator >= 0 ? value.slice(separator + 1) : "";
  if (!rawTimestamp || (separator >= 0 && !messageId)) return null;
  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return separator >= 0
    ? `${dtToIso(parsed)}|${messageId}`
    : dtToIso(parsed);
}

function approvalPublic(
  approval: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: approval.id,
    message_id: approval.message_id,
    task_id: approval.task_id,
    requested_for: approval.requested_for,
    status: approval.status,
    decided_by: approval.decided_by ?? null,
    decided_at: approval.decided_at ?? null,
    note: approval.note ?? "",
    created_at: approval.created_at ?? null,
  };
}

export function apiSend(
  home: string,
  agentId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  forbidIdentityOverride(payload, agentId);
  const to = payload.to;
  const body = payload.body;
  if (typeof to !== "string" || !to.trim()) throw new MailApiError("'to' is required");
  if (typeof body !== "string") throw new MailApiError("'body' must be a string");
  const rawType = payload.type;
  if (
    rawType !== undefined &&
    rawType !== null &&
    rawType !== "" &&
    typeof rawType !== "string"
  ) {
    throw new MailApiError("'type' must be a string");
  }
  const msgType =
    typeof rawType === "string" && rawType ? rawType : "message";
  const rawClientId = payload.id || payload.message_id;
  const clientId =
    typeof rawClientId === "string" && rawClientId.trim()
      ? rawClientId.trim()
      : null;
  const docRefs = payload.doc_refs;
  if (
    docRefs !== undefined &&
    (!Array.isArray(docRefs) ||
      !docRefs.every((item): item is string => typeof item === "string"))
  ) {
    throw new MailApiError("'doc_refs' must be a list of strings");
  }
  const requiresHumanApproval = parseApprovalFlag(payload);

  try {
    let duplicate = false;
    if (clientId) {
      const existing = svc.getStore(home).getMessage(clientId);
      if (existing) {
        if (existing.from_id !== agentId) {
          throw new MailApiError("message id already used by another sender", 409);
        }
        duplicate = true;
        const result = messagePublic(existing);
        result.duplicate = true;
        const approval = existing.task_id
          ? svc.getApprovalForTask(existing.task_id, { home })
          : null;
        result.approval_id = approval?.id ?? null;
        return result;
      }
    }
    const msg = svc.send({
      from_id: agentId,
      to,
      type: msgType,
      body,
      home,
      thread_id: typeof payload.thread_id === "string" ? payload.thread_id : null,
      task_id: typeof payload.task_id === "string" ? payload.task_id : null,
      effect: typeof payload.effect === "string" ? payload.effect : "none",
      message_id: clientId,
      in_reply_to:
        typeof payload.in_reply_to === "string" ? payload.in_reply_to : null,
      requires_human_approval: requiresHumanApproval,
      doc_refs: docRefs as string[] | undefined,
    });
    const result = messagePublic(msg);
    result.duplicate = duplicate;
    const approval = msg.task_id
      ? svc.getApprovalForTask(msg.task_id, { home })
      : null;
    result.approval_id =
      approval?.id ??
      (typeof msg.meta?.approval_id === "string" ? msg.meta.approval_id : null);
    return result;
  } catch (e) {
    if (e instanceof MailApiError) throw e;
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiInbox(
  home: string,
  agentId: string,
  allItems = false,
): Record<string, unknown> {
  try {
    const items = svc.inbox(agentId, { home, allItems });
    const approvalsByTask = new Map(
      svc
        .listApprovals({ home, status: null })
        .filter((approval) => typeof approval.task_id === "string")
        .map((approval) => [String(approval.task_id), approval]),
    );
    return {
      agent_id: agentId,
      count: items.length,
      items: items.map((i) => {
        const approval = i.message.task_id
          ? approvalsByTask.get(i.message.task_id) ?? null
          : null;
        return {
          message_id: i.message.id,
          type: i.message.type,
          from: i.message.from_id,
          to: i.message.to,
          body_md: i.message.body_md,
          thread_id: i.message.thread_id,
          task_id: i.message.task_id,
          delivery_status: i.delivery.status,
          effect_level: i.message.effect_level,
          requires_human_approval: i.message.requires_human_approval,
          approval_id: approval?.id ?? null,
          approval_status: approval?.status ?? null,
          claim_by: i.delivery.claim_by,
          claim_until: i.delivery.claim_until?.toISOString() ?? null,
        };
      }),
    };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiSent(
  home: string,
  agentId: string,
  opts: { before?: string | null; limit?: number } = {},
): Record<string, unknown> {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new MailApiError("limit must be between 1 and 1000", 400);
  }
  let before = opts.before ?? null;
  if (before !== null) {
    before = normalizeSentCursor(before);
    if (before === null) {
      throw new MailApiError("before must be an ISO timestamp", 400);
    }
  }
  try {
    const items = svc.sent(agentId, { home, before, limit });
    const last = items.at(-1);
    return {
      agent_id: agentId,
      count: items.length,
      items,
      // The message id disambiguates rows sharing the second-precision ts.
      next_before:
        items.length === limit && last
          ? `${last.sent_at}|${last.message_id}`
          : null,
    };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiAgentDetails(
  home: string,
  requesterId: string,
  targetId: string,
  opts: { hubEndpoint?: string | null; authenticatedAt?: string | null } = {},
): Record<string, unknown> {
  try {
    return {
      ...svc.agentDetails(targetId, {
        home,
        requester: requesterId,
        hubEndpoint: opts.hubEndpoint,
        authenticatedAt: opts.authenticatedAt,
      }),
    };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiClaim(
  home: string,
  agentId: string,
  messageId: string,
): Record<string, unknown> {
  try {
    const d = svc.claim(messageId, agentId, { home });
    return {
      message_id: d.message_id,
      status: d.status,
      claim_by: d.claim_by,
      claim_until: d.claim_until?.toISOString() ?? null,
      agent_id: agentId,
    };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiAck(
  home: string,
  agentId: string,
  messageId: string,
): Record<string, unknown> {
  try {
    const d = svc.ack(messageId, agentId, { home });
    return { message_id: d.message_id, status: d.status, agent_id: agentId };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiMe(agentId: string): Record<string, unknown> {
  return { agent_id: agentId };
}

export function apiAgents(home: string): Record<string, unknown> {
  try {
    const agents = svc.listAgents({ home });
    return { agents, count: agents.length };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiThread(
  home: string,
  threadId: string,
  limit = 50,
): Record<string, unknown> {
  try {
    const messages = svc.tail({ home, threadId, limit });
    return {
      thread_id: threadId,
      count: messages.length,
      messages: messages.map(messagePublic),
    };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiTaskOutcome(
  home: string,
  agentId: string,
  taskId: string,
  outcome: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  forbidIdentityOverride(payload, agentId);
  if (!["done", "error", "cancel"].includes(outcome)) {
    throw new MailApiError("outcome must be done|error|cancel");
  }
  const to = payload.to;
  const threadId = payload.thread_id;
  let body = payload.body;
  if (typeof to !== "string" || !to.trim()) {
    throw new MailApiError("'to' is required (original requester / peer)");
  }
  if (typeof threadId !== "string" || !threadId.trim()) {
    throw new MailApiError("'thread_id' is required");
  }
  if (body === undefined || body === null) body = `task ${outcome}`;
  if (typeof body !== "string") throw new MailApiError("'body' must be a string");
  try {
    const msg = svc.send({
      from_id: agentId,
      to,
      type: outcome,
      body,
      home,
      thread_id: threadId,
      task_id: taskId,
    });
    return messagePublic(msg);
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiListApprovals(
  home: string,
  agentId: string,
  status: string | null = "pending",
): Record<string, unknown> {
  try {
    let items = svc.listApprovals({ home, status });
    if (agentId !== "human@local") {
      items = items.filter((a) => a.requested_for === agentId);
    }
    return {
      agent_id: agentId,
      count: items.length,
      items: items.map(approvalPublic),
    };
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}

export function apiDecideApproval(
  home: string,
  agentId: string,
  approvalId: string,
  approve: boolean,
  note = "",
): Record<string, unknown> {
  if (agentId !== "human@local") {
    throw new MailApiError("only human@local token may approve/reject", 403);
  }
  try {
    const record = approve
      ? svc.approve(approvalId, agentId, { home, note })
      : svc.reject(approvalId, agentId, { home, note });
    return approvalPublic(record);
  } catch (e) {
    if (e instanceof AgentMailError) mapAgentError(e);
    throw e;
  }
}
