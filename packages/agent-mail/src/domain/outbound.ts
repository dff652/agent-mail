import { newThreadId } from "../ids.js";
import {
  createTask,
  type Message,
  type Task,
} from "../models.js";

export interface OutboundPlan {
  message: Message;
  task: Task | null;
}

export function planOutbound(message: Message): OutboundPlan {
  const threadId = message.thread_id ?? newThreadId();
  let msg: Message = { ...message, thread_id: threadId };

  if (msg.type !== "task") {
    return { message: msg, task: null };
  }

  const task = createTask({
    thread_id: threadId,
    origin_message_id: msg.id,
    assignee: msg.to,
  });
  msg = { ...msg, task_id: task.id, thread_id: task.thread_id };
  return { message: msg, task };
}
