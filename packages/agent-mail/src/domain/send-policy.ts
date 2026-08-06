/** Outbound policy decision shared by CLI, MCP, and Hub sends. */

import type { EffectLevel, MessageType } from "../models.js";
import type { ProjectPolicy } from "../policy-shape.js";

export type PolicyOutcome = "allow" | "deny" | "require_approval";

export interface SendPolicyDecision {
  outcome: PolicyOutcome;
  reason?: string;
  requires_human_approval: boolean;
}

function canSend(
  policy: ProjectPolicy,
  fromId: string,
  to: string,
  messageType: MessageType,
): boolean {
  if (policy.roster_mode !== "allowlist") return true;
  return policy.allow_edges.some(
    (edge) =>
      edge.from === fromId &&
      edge.to === to &&
      (!edge.types ||
        edge.types.length === 0 ||
        edge.types.includes(messageType)),
  );
}

function requiresHumanForEffect(
  policy: ProjectPolicy,
  effect: EffectLevel,
): boolean {
  if (policy.default_execution_mode === "view-only") return false;
  if (policy.default_execution_mode === "autonomous") {
    return effect === "dangerous";
  }
  const rule = policy.effect_rules[effect];
  return (
    rule === "requires_human_ack" ||
    rule === "requires_human_approval" ||
    effect === "write" ||
    effect === "dangerous"
  );
}

export function decideSendPolicy(
  policy: ProjectPolicy,
  opts: {
    fromId: string;
    to: string;
    type: MessageType;
    effect: EffectLevel;
    /** Caller-set requires_human_approval (MCP optional). */
    callerRequires?: boolean | null;
  },
): SendPolicyDecision {
  if (!canSend(policy, opts.fromId, opts.to, opts.type)) {
    return {
      outcome: "deny",
      reason: `policy denies ${opts.fromId} -> ${opts.to} type=${opts.type}`,
      requires_human_approval: false,
    };
  }

  if (
    policy.default_execution_mode === "view-only" &&
    (opts.effect === "write" || opts.effect === "dangerous")
  ) {
    return {
      outcome: "deny",
      reason: `view-only policy denies effect=${opts.effect}`,
      requires_human_approval: false,
    };
  }

  const policyRequires = requiresHumanForEffect(policy, opts.effect);
  const needs = policyRequires || Boolean(opts.callerRequires);

  if (needs && opts.type !== "task") {
    return {
      outcome: "deny",
      reason: "human approval is supported only for task messages",
      requires_human_approval: false,
    };
  }
  if (needs) {
    return {
      outcome: "require_approval",
      requires_human_approval: true,
    };
  }
  return { outcome: "allow", requires_human_approval: false };
}
