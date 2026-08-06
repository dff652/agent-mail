import { AgentMailError } from "./errors.js";
import { AGENT_ID_RE } from "./ids.js";
import type { EffectLevel, MessageType } from "./models.js";

export type ExecutionMode = "autonomous" | "approve-writes" | "view-only";
export type RosterMode = "open" | "allowlist";
export type EffectRule =
  | "requires_human_ack"
  | "requires_human_approval";

export interface PolicyAllowEdge {
  from: string;
  to: string;
  types?: MessageType[];
}

export interface ProjectPolicy {
  default_execution_mode: ExecutionMode;
  roster_mode: RosterMode;
  effect_rules: Partial<Record<EffectLevel, EffectRule>>;
  allow_edges: PolicyAllowEdge[];
}

export type PolicyDefaults = ProjectPolicy;

const EXECUTION_MODES = new Set<ExecutionMode>([
  "autonomous",
  "approve-writes",
  "view-only",
]);
const ROSTER_MODES = new Set<RosterMode>(["open", "allowlist"]);
const EFFECT_LEVELS = new Set<EffectLevel>([
  "none",
  "read",
  "write",
  "dangerous",
]);
const EFFECT_RULES = new Set<EffectRule>([
  "requires_human_ack",
  "requires_human_approval",
]);
const MESSAGE_TYPES = new Set<MessageType>([
  "message",
  "task",
  "done",
  "error",
  "question",
  "escalate",
  "status",
  "cancel",
]);
const POLICY_KEYS = new Set([
  "default_execution_mode",
  "roster_mode",
  "effect_rules",
  "allow_edges",
]);

export function isEffectLevel(value: string): value is EffectLevel {
  return EFFECT_LEVELS.has(value as EffectLevel);
}

export function isMessageType(value: string): value is MessageType {
  return MESSAGE_TYPES.has(value as MessageType);
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentMailError(`${label} must be a mapping`, 3);
  }
  return value as Record<string, unknown>;
}

export function validateEffectRules(
  value: unknown,
): ProjectPolicy["effect_rules"] {
  const rules = mapping(value, "policy.effect_rules");
  const result: ProjectPolicy["effect_rules"] = {};
  for (const [effect, rule] of Object.entries(rules)) {
    if (!isEffectLevel(effect)) {
      throw new AgentMailError(
        `unsupported policy.effect_rules key: ${effect}`,
        3,
      );
    }
    if (
      typeof rule !== "string" ||
      !EFFECT_RULES.has(rule as EffectRule)
    ) {
      throw new AgentMailError(
        `unsupported policy.effect_rules.${effect}: ${JSON.stringify(rule)}`,
        3,
      );
    }
    result[effect as EffectLevel] = rule as EffectRule;
  }
  return result;
}

export function validateAllowEdges(
  value: unknown,
): PolicyAllowEdge[] {
  if (!Array.isArray(value)) {
    throw new AgentMailError("policy.allow_edges must be a list", 3);
  }
  return value.map((raw, index) => {
    const edge = mapping(raw, `policy.allow_edges[${index}]`);
    const unknown = Object.keys(edge).filter(
      (key) => !["from", "to", "types"].includes(key),
    );
    if (unknown.length > 0) {
      throw new AgentMailError(
        `unsupported policy.allow_edges[${index}] keys: ${unknown.sort().join(", ")}`,
        3,
      );
    }
    const from = edge.from;
    const to = edge.to;
    if (typeof from !== "string" || !AGENT_ID_RE.test(from)) {
      throw new AgentMailError(
        `policy.allow_edges[${index}].from must be a valid agent id`,
        3,
      );
    }
    if (typeof to !== "string" || !AGENT_ID_RE.test(to)) {
      throw new AgentMailError(
        `policy.allow_edges[${index}].to must be a valid agent id`,
        3,
      );
    }
    const types = edge.types;
    if (
      types !== undefined &&
      (!Array.isArray(types) ||
        !types.every(
          (type): type is MessageType =>
            typeof type === "string" && isMessageType(type),
        ))
    ) {
      throw new AgentMailError(
        `policy.allow_edges[${index}].types contains an unsupported message type`,
        3,
      );
    }
    return {
      from,
      to,
      ...(types === undefined ? {} : { types: [...types] }),
    };
  });
}

export function validatePolicyDocument(
  value: unknown,
  defaults: PolicyDefaults,
): ProjectPolicy {
  const document = mapping(value, "policy.yaml");
  const unknown = Object.keys(document).filter((key) => !POLICY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new AgentMailError(
      `unsupported policy.yaml keys: ${unknown.sort().join(", ")}`,
      3,
    );
  }

  const executionMode =
    document.default_execution_mode === undefined
      ? defaults.default_execution_mode
      : document.default_execution_mode;
  if (
    typeof executionMode !== "string" ||
    !EXECUTION_MODES.has(executionMode as ExecutionMode)
  ) {
    throw new AgentMailError(
      `policy.default_execution_mode must be one of: ${[...EXECUTION_MODES].join(", ")}`,
      3,
    );
  }

  const rosterMode =
    document.roster_mode === undefined
      ? defaults.roster_mode
      : document.roster_mode;
  if (
    typeof rosterMode !== "string" ||
    !ROSTER_MODES.has(rosterMode as RosterMode)
  ) {
    throw new AgentMailError(
      `policy.roster_mode must be one of: ${[...ROSTER_MODES].join(", ")}`,
      3,
    );
  }

  return {
    default_execution_mode: executionMode as ExecutionMode,
    roster_mode: rosterMode as RosterMode,
    effect_rules: validateEffectRules(
      document.effect_rules === undefined
        ? defaults.effect_rules
        : document.effect_rules,
    ),
    allow_edges: validateAllowEdges(
      document.allow_edges === undefined
        ? defaults.allow_edges
        : document.allow_edges,
    ),
  };
}
