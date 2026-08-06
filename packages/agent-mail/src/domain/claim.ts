import type { DeliveryStatus, MessageType } from "../models.js";

export interface DeliveryClaimSnapshot {
  status: DeliveryStatus;
  claim_by: string | null;
  claim_until: Date | null;
}

export interface ClaimPlan {
  claim_until: Date;
  reclaimed: boolean;
  advance_task_to_in_progress: boolean;
}

export function planClaim(
  snap: DeliveryClaimSnapshot,
  opts: {
    agentId: string;
    now: Date;
    leaseSeconds: number;
    messageType: MessageType | null;
  },
): ClaimPlan {
  const { agentId, now, leaseSeconds, messageType } = opts;
  if (leaseSeconds < 1) throw new Error("lease_seconds must be >= 1");

  const expired =
    snap.status === "claimed" &&
    snap.claim_until !== null &&
    snap.claim_until.getTime() <= now.getTime();

  if (snap.status === "acked") throw new Error("delivery already acked");
  if (snap.status === "claimed" && !expired) {
    if (snap.claim_by === agentId) {
      return {
        claim_until: new Date(now.getTime() + leaseSeconds * 1000),
        reclaimed: false,
        advance_task_to_in_progress: false,
      };
    }
    throw new Error(`already claimed by ${snap.claim_by}`);
  }
  if (snap.status !== "pending" && snap.status !== "claimed") {
    throw new Error(`cannot claim delivery in status ${snap.status}`);
  }

  return {
    claim_until: new Date(now.getTime() + leaseSeconds * 1000),
    reclaimed: expired,
    advance_task_to_in_progress: messageType === "task",
  };
}

export function planAck(
  snap: DeliveryClaimSnapshot,
  opts: { agentId: string; now: Date },
): void {
  if (snap.status === "acked") return;
  if (snap.status !== "claimed" || snap.claim_by !== opts.agentId) {
    throw new Error("only active claim owner can ack");
  }
  if (snap.claim_until !== null && snap.claim_until.getTime() <= opts.now.getTime()) {
    throw new Error("claim lease expired; re-claim first");
  }
}
