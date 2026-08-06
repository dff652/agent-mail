import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { AgentMailError } from "./errors.js";
import {
  type PolicyDefaults,
  type ProjectPolicy,
  validatePolicyDocument,
} from "./policy-shape.js";
import { settingDefault } from "./settings.js";

function policyDefaults(): PolicyDefaults {
  return {
    default_execution_mode: settingDefault(
      "policy.default_execution_mode",
    ) as PolicyDefaults["default_execution_mode"],
    roster_mode: settingDefault(
      "policy.roster_mode",
    ) as PolicyDefaults["roster_mode"],
    effect_rules: settingDefault(
      "policy.effect_rules",
    ) as PolicyDefaults["effect_rules"],
    allow_edges: settingDefault(
      "policy.allow_edges",
    ) as PolicyDefaults["allow_edges"],
  };
}

export function loadPolicy(home: string): ProjectPolicy {
  const target = path.join(path.resolve(home), "policy.yaml");
  if (!fs.existsSync(target)) {
    throw new AgentMailError(`missing policy.yaml: ${target}`, 3);
  }
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(target, "utf8")) ?? {};
  } catch (error) {
    throw new AgentMailError(
      `invalid policy.yaml: ${error instanceof Error ? error.message : String(error)}`,
      3,
    );
  }
  return validatePolicyDocument(raw, policyDefaults());
}
