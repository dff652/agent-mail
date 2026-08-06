/**
 * Wake dual-gate and debounce state.
 * This module only decides read/write/skip; wake/runner.ts owns processes.
 */
import type { Delivery, Message, Task } from "../models.js";

export type WakeBusinessState = "incomplete" | "complete" | "waiting_approval";
export type WakeExecutionMode = "read" | "write";

export interface WakeInboxSnapshot {
  message: Message;
  delivery: Delivery;
  task: Task | null;
  approval: { status: string } | null;
}

export interface OutboxEventLite {
  sequence: number;
  id: string;
  kind: string;
  recipient: string;
  message_id: string;
}

const SUPPORTED_WAKE_EVENTS = new Set([
  "message.created",
  "approval.approved",
  "approval.rejected",
]);

export function businessState(
  event: OutboxEventLite,
  item: WakeInboxSnapshot,
): WakeBusinessState {
  if (item.delivery.status === "acked") return "complete";
  if (
    event.kind === "message.created" &&
    item.message.type === "task" &&
    item.approval?.status === "pending" &&
    item.delivery.status === "claimed" &&
    item.delivery.claim_by === item.message.to &&
    item.task?.status === "in_progress"
  ) {
    return "waiting_approval";
  }
  return "incomplete";
}

/**
 * Dual-gate for write effect:
 * 1) Agent Mail approval must be approved (or N/A for non-write)
 * 2) bridge allow_write must be true for write mode
 */
export function executionMode(
  item: WakeInboxSnapshot,
  allowWrite: boolean,
): WakeExecutionMode {
  const effect = item.message.effect_level;
  if (effect === "dangerous") {
    throw new Error(
      "dangerous-effect messages are never auto-started by wake bridge",
    );
  }
  if (effect !== "write") return "read";
  if (
    item.task &&
    (item.task.status === "completed" ||
      item.task.status === "failed" ||
      item.task.status === "cancelled")
  ) {
    return "read";
  }
  if (item.approval?.status === "pending") return "read";
  if (!item.approval || item.approval.status !== "approved") {
    if (item.approval?.status === "rejected") return "read";
    throw new Error("write wake has no approved Agent Mail approval");
  }
  if (!allowWrite) {
    throw new Error(
      "approved write wake requires explicit bridge option --allow-write",
    );
  }
  return "write";
}

/** Keep latest event per message_id, ordered by sequence. */
export function coalesceEvents<T extends OutboxEventLite>(events: T[]): T[] {
  if (events.length <= 1) return [...events];
  const last = new Map<string, T>();
  for (const e of events) last.set(e.message_id, e);
  return [...last.values()].sort((a, b) => a.sequence - b.sequence);
}

export function planWakeProcess(
  event: OutboxEventLite,
  item: WakeInboxSnapshot,
  opts: { allowWrite: boolean; recipient: string },
): {
  business_state: WakeBusinessState;
  mode: WakeExecutionMode | null;
  action: "ack_only" | "run" | "reject";
  reason?: string;
} {
  if (event.recipient !== opts.recipient) {
    return {
      business_state: "incomplete",
      mode: null,
      action: "reject",
      reason: "wake event recipient does not match bridge identity",
    };
  }
  if (!SUPPORTED_WAKE_EVENTS.has(event.kind)) {
    return {
      business_state: "incomplete",
      mode: null,
      action: "reject",
      reason: `unsupported wake event kind: ${event.kind}`,
    };
  }
  const state = businessState(event, item);
  if (state !== "incomplete") {
    return { business_state: state, mode: null, action: "ack_only" };
  }
  try {
    const mode = executionMode(item, opts.allowWrite);
    return { business_state: state, mode, action: "run" };
  } catch (e) {
    return {
      business_state: state,
      mode: null,
      action: "reject",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
