import { randomUUID } from "node:crypto";

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/;

export function newMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}
export function newThreadId(): string {
  return `thr_${randomUUID().replace(/-/g, "")}`;
}
export function newTaskId(): string {
  return `tsk_${randomUUID().replace(/-/g, "")}`;
}
export function newDeliveryId(): string {
  return `dlv_${randomUUID().replace(/-/g, "")}`;
}
export function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}
export function newApprovalId(): string {
  return `apr_${randomUUID().replace(/-/g, "")}`;
}

export function utcNow(): Date {
  return new Date();
}

export function dtToIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseDt(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function validateAgentId(value: string): string {
  if (value.startsWith("channel:")) {
    throw new Error("channel addressing is not supported in M1 (D-024)");
  }
  if (!AGENT_ID_RE.test(value)) {
    throw new Error(`invalid agent id: ${JSON.stringify(value)}`);
  }
  return value;
}
