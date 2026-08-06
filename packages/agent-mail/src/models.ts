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
