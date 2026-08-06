import { ApprovalRequiredError, TaskTransitionError } from "../errors.js";
import type {
  DeliveryStatus,
  Message,
  MessageType,
  TaskStatus,
} from "../models.js";

export interface TaskSnapshot {
  id: string;
  thread_id: string;
  origin_message_id: string;
  origin_from: string;
  assignee: string;
  status: TaskStatus;
}

export interface ClaimSnapshot {
  status: DeliveryStatus;
  claim_by: string | null;
  claim_until: Date | null;
}

export interface TerminalPlan {
  new_status: TaskStatus;
  expected_current: TaskStatus;
}

export function validateDeliveryAck(opts: {
  messageType: MessageType;
  taskStatus: TaskStatus | null;
}): void {
  if (opts.messageType !== "task") return;
  if (opts.taskStatus === null) {
    throw new TaskTransitionError("task state missing for task delivery");
  }
  if (
    opts.taskStatus !== "completed" &&
    opts.taskStatus !== "failed" &&
    opts.taskStatus !== "cancelled"
  ) {
    throw new TaskTransitionError("task is not terminal; send done/error before ack");
  }
}

export type ApprovalStatusSnapshot =
  | "pending"
  | "approved"
  | "rejected"
  | null;

export function planTerminalMessage(
  message: Message,
  task: TaskSnapshot,
  opts: {
    originClaim: ClaimSnapshot | null;
    /** Latest approval on the task; null when the task never required one. */
    approvalStatus: ApprovalStatusSnapshot;
    now: Date;
  },
): TerminalPlan {
  if (message.type !== "done" && message.type !== "error" && message.type !== "cancel") {
    throw new TaskTransitionError(`not a terminal type: ${message.type}`);
  }
  if (!message.task_id || !message.thread_id) {
    throw new TaskTransitionError(`${message.type} requires task_id and thread_id`);
  }
  if (message.task_id !== task.id) throw new TaskTransitionError("task id mismatch");
  if (message.thread_id !== task.thread_id) {
    throw new TaskTransitionError("task/thread mismatch");
  }
  if (task.status !== "open" && task.status !== "in_progress") {
    throw new TaskTransitionError(`task already terminal: ${task.status}`);
  }

  if (message.type === "cancel") {
    if (message.from_id !== task.origin_from || message.to !== task.assignee) {
      throw new TaskTransitionError("only task origin may cancel for the assignee");
    }
    return { new_status: "cancelled", expected_current: task.status };
  }

  if (message.from_id !== task.assignee || message.to !== task.origin_from) {
    throw new TaskTransitionError(
      "done/error must be sent by the assignee to the task origin",
    );
  }
  if (task.status !== "in_progress") {
    throw new TaskTransitionError("task must be claimed before done/error");
  }
  const claim = opts.originClaim;
  if (!claim || claim.claim_by !== message.from_id) {
    throw new TaskTransitionError("done/error requires an active task claim");
  }
  if (claim.status === "claimed") {
    if (!claim.claim_until || claim.claim_until.getTime() <= opts.now.getTime()) {
      throw new TaskTransitionError("done/error requires an active task claim");
    }
  } else if (claim.status !== "acked") {
    throw new TaskTransitionError("done/error requires an active task claim");
  }

  if (message.type === "done") {
    // A task that asked for a human decision cannot self-complete: `error` and
    // `cancel` stay available, `done` waits for `approved`.
    if (opts.approvalStatus !== null && opts.approvalStatus !== "approved") {
      throw new ApprovalRequiredError(
        `task approval is ${opts.approvalStatus}; approved is required`,
      );
    }
    return { new_status: "completed", expected_current: task.status };
  }
  return { new_status: "failed", expected_current: task.status };
}
