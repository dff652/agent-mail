import {
  newDeliveryId,
  newMessageId,
  newTaskId,
  utcNow,
} from "./ids.js";

export type MessageType =
  | "message"
  | "task"
  | "done"
  | "error"
  | "question"
  | "escalate"
  | "status"
  | "cancel";

export type EffectLevel = "none" | "read" | "write" | "dangerous";
export type DeliveryStatus = "pending" | "claimed" | "acked";
export type TaskStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Sender-facing status derived from durable delivery/task evidence.
 * `unknown` is retained for lifecycle states that do not have a truthful
 * representation in the compact UI vocabulary (for example cancellation).
 */
export type SentHistoryStatus =
  | "submitted"
  | "claimed"
  | "processing"
  | "completed"
  | "failed"
  | "unknown";

export interface SentHistoryItem {
  message_id: string;
  sent_at: string;
  to: string;
  type: MessageType;
  thread_id: string | null;
  task_id: string | null;
  body_md: string;
  status: SentHistoryStatus;
  /** Raw local delivery state, when the message has a local recipient row. */
  delivery_status: DeliveryStatus | null;
  /** Raw task state, when the message has a task row. */
  task_status: TaskStatus | null;
  /** Raw Hub-to-Hub state, when the message is federated outbound. */
  federation_status: "pending" | "acked" | "dead" | null;
  /** The durable row(s) that justify the derived status. */
  status_evidence: {
    basis: "delivery" | "task" | "federation" | "unknown";
    delivery_status: DeliveryStatus | null;
    task_status: TaskStatus | null;
    federation_status: "pending" | "acked" | "dead" | null;
    updated_at: string | null;
  };
  claim_by: string | null;
  claim_until: string | null;
  delivery_updated_at: string | null;
  task_updated_at: string | null;
  federation_updated_at: string | null;
}

export type AgentConnectionStatus = "connected" | "disconnected" | "unknown";

export interface AgentDetails {
  agent_id: string;
  display_name: string;
  skills: string[];
  /** Device identity is unknown until a real registration/heartbeat supplies it. */
  device_name: string | null;
  device_ip: string | null;
  /** The Hub endpoint used for this authenticated request, when known. */
  hub_endpoint: string | null;
  connection: AgentConnectionStatus;
  last_seen: string | null;
  evidence: {
    registration: boolean;
    heartbeat: boolean;
    authenticated_request: boolean;
  };
  fields_unknown: string[];
}

export interface Message {
  id: string;
  ts: Date;
  from_id: string;
  to: string;
  type: MessageType;
  thread_id: string | null;
  in_reply_to: string | null;
  task_id: string | null;
  body_md: string;
  doc_refs: string[];
  effect_level: EffectLevel;
  requires_human_approval: boolean;
  meta: Record<string, unknown>;
}

export interface Delivery {
  id: string;
  message_id: string;
  recipient: string;
  status: DeliveryStatus;
  claim_by: string | null;
  claim_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Task {
  id: string;
  thread_id: string;
  origin_message_id: string;
  assignee: string;
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
}

export interface InboxItem {
  message: Message;
  delivery: Delivery;
}

export function createMessage(input: {
  from_id: string;
  to: string;
  type: MessageType;
  body_md: string;
  thread_id?: string | null;
  task_id?: string | null;
  in_reply_to?: string | null;
  effect_level?: EffectLevel;
  requires_human_approval?: boolean;
  doc_refs?: string[];
  id?: string;
}): Message {
  return {
    id: input.id ?? newMessageId(),
    ts: utcNow(),
    from_id: input.from_id,
    to: input.to,
    type: input.type,
    thread_id: input.thread_id ?? null,
    in_reply_to: input.in_reply_to ?? null,
    task_id: input.task_id ?? null,
    body_md: input.body_md,
    doc_refs: [...(input.doc_refs ?? [])],
    effect_level: input.effect_level ?? "none",
    requires_human_approval: input.requires_human_approval ?? false,
    meta: { schema_version: "0.2" },
  };
}

export function createDelivery(messageId: string, recipient: string): Delivery {
  const now = utcNow();
  return {
    id: newDeliveryId(),
    message_id: messageId,
    recipient,
    status: "pending",
    claim_by: null,
    claim_until: null,
    created_at: now,
    updated_at: now,
  };
}

export function createTask(input: {
  id?: string;
  thread_id: string;
  origin_message_id: string;
  assignee: string;
}): Task {
  const now = utcNow();
  return {
    id: input.id ?? newTaskId(),
    thread_id: input.thread_id,
    origin_message_id: input.origin_message_id,
    assignee: input.assignee,
    status: "open",
    created_at: now,
    updated_at: now,
  };
}
