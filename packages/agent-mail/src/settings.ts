/**
 * Registry-driven project settings shared by CLI and a future control surface.
 *
 * contracts/settings.json is canonical. settings.json at the npm package root
 * is a byte-identical release snapshot enforced by scripts/check_contracts.py.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteText, withFileLockSync } from "./atomic-file.js";
import { AgentMailError } from "./errors.js";
import {
  type PolicyDefaults,
  validateAllowEdges,
  validateEffectRules,
  validatePolicyDocument,
} from "./policy-shape.js";

export type SettingSpec = {
  key: string;
  group: string;
  type: "integer" | "enum" | "object" | "array" | "bool" | "string";
  default: unknown;
  minimum?: number;
  values?: string[];
  authority: string;
  mirrors: string[];
  scope: string;
  danger: "low" | "medium" | "high";
  writable: boolean;
  cli: string;
  summary: string;
  since: string;
};

export type SettingsRegistry = {
  version: "0.1";
  settings: SettingSpec[];
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const settingTypes = new Set(["integer", "enum", "object", "array", "bool", "string"]);
const settingFiles = new Set(["config.json", "policy.yaml"]);
const dangerLevels = new Set(["low", "medium", "high"]);

function registryPath(): string {
  const candidates = [
    path.resolve(moduleDir, "../../../contracts/settings.json"),
    path.resolve(moduleDir, "../settings.json"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new AgentMailError("settings registry is missing from this installation", 3);
  }
  return found;
}

export function loadSettingsRegistry(): SettingsRegistry {
  let registry: SettingsRegistry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as SettingsRegistry;
  } catch (error) {
    if (error instanceof AgentMailError) throw error;
    throw new AgentMailError(`invalid settings registry JSON: ${String(error)}`, 3);
  }
  if (registry.version !== "0.1" || !Array.isArray(registry.settings)) {
    throw new AgentMailError("unsupported settings registry shape or version", 3);
  }
  const keys = registry.settings.map((entry) => entry.key);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(key),
    ) ||
    new Set(keys).size !== keys.length
  ) {
    throw new AgentMailError("settings registry contains invalid or duplicate keys", 3);
  }
  for (const entry of registry.settings) {
    if (
      !settingTypes.has(entry.type) ||
      !settingFiles.has(entry.authority) ||
      !Array.isArray(entry.mirrors) ||
      entry.mirrors.some((mirror) => !settingFiles.has(mirror)) ||
      new Set(entry.mirrors).size !== entry.mirrors.length ||
      entry.mirrors.includes(entry.authority) ||
      entry.scope !== "project" ||
      !dangerLevels.has(entry.danger) ||
      typeof entry.writable !== "boolean" ||
      typeof entry.group !== "string" ||
      typeof entry.cli !== "string" ||
      typeof entry.summary !== "string" ||
      typeof entry.since !== "string"
    ) {
      throw new AgentMailError(`invalid settings registry entry: ${entry.key}`, 3);
    }
    if (
      entry.type === "enum" &&
      (!Array.isArray(entry.values) ||
        !entry.values.every((value) => typeof value === "string") ||
        !entry.values.includes(entry.default as string))
    ) {
      throw new AgentMailError(`invalid enum metadata for ${entry.key}`, 3);
    }
    validateSettingValue(entry, structuredClone(entry.default));
  }
  return registry;
}

export function settingSpec(key: string): SettingSpec {
  const spec = loadSettingsRegistry().settings.find((entry) => entry.key === key);
  if (!spec) throw new AgentMailError(`unknown setting: ${key}`, 2);
  return spec;
}

export function settingDefault(key: string): unknown {
  return structuredClone(settingSpec(key).default);
}

export function settingOperationalWarnings(key: string): string[] {
  settingSpec(key);
  return [];
}

function leafName(spec: SettingSpec): string {
  return spec.key.split(".").at(-1)!;
}

function loadDocument(home: string, filename: string): Record<string, unknown> {
  const target = path.join(home, filename);
  if (!fs.existsSync(target)) throw new AgentMailError(`missing ${filename}`, 2);
  let data: unknown;
  try {
    const raw = fs.readFileSync(target, "utf8");
    data = filename.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    throw new AgentMailError(`invalid ${filename}: ${String(error)}`, 2);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AgentMailError(`${filename} must contain a mapping`, 2);
  }
  return data as Record<string, unknown>;
}

function dumpDocument(filename: string, data: Record<string, unknown>): string {
  if (filename.endsWith(".json")) return `${JSON.stringify(data, null, 2)}\n`;
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) {
    return stringifyYaml(data);
  }
  throw new AgentMailError(`unsupported settings authority: ${filename}`, 2);
}

function valueFrom(home: string, spec: SettingSpec, filename?: string): unknown {
  const document = loadDocument(home, filename ?? spec.authority);
  const value = document[leafName(spec)];
  return value === undefined ? structuredClone(spec.default) : value;
}

export function validateSettingValue(spec: SettingSpec, value: unknown): unknown {
  if (spec.type === "integer") {
    if (!Number.isInteger(value)) {
      throw new AgentMailError(`${spec.key} must be an integer`, 2);
    }
    if (spec.minimum !== undefined && (value as number) < spec.minimum) {
      throw new AgentMailError(`${spec.key} must be >= ${spec.minimum}`, 2);
    }
  } else if (spec.type === "enum") {
    if (typeof value !== "string" || !spec.values?.includes(value)) {
      throw new AgentMailError(
        `${spec.key} must be one of: ${(spec.values ?? []).join(", ")}`,
        2,
      );
    }
  } else if (spec.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AgentMailError(`${spec.key} must be a JSON object`, 2);
    }
  } else if (spec.type === "array") {
    if (!Array.isArray(value)) {
      throw new AgentMailError(`${spec.key} must be a JSON array`, 2);
    }
  } else if (spec.type === "bool") {
    if (typeof value !== "boolean") {
      throw new AgentMailError(`${spec.key} must be a boolean`, 2);
    }
  } else if (spec.type === "string") {
    if (typeof value !== "string") {
      throw new AgentMailError(`${spec.key} must be a string`, 2);
    }
  } else {
    throw new AgentMailError(`unsupported setting type for ${spec.key}`, 2);
  }
  try {
    if (spec.key === "policy.effect_rules") validateEffectRules(value);
    if (spec.key === "policy.allow_edges") validateAllowEdges(value);
  } catch (error) {
    throw new AgentMailError(
      error instanceof Error ? error.message : String(error),
      2,
    );
  }
  return value;
}

function parseSettingValue(spec: SettingSpec, raw: string): unknown {
  let value: unknown = raw;
  if (spec.type === "integer") {
    if (!/^-?\d+$/.test(raw)) {
      throw new AgentMailError(`${spec.key} must be an integer`, 2);
    }
    value = Number(raw);
  } else if (spec.type === "object" || spec.type === "array") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new AgentMailError(`${spec.key} requires valid JSON`, 2);
    }
  } else if (spec.type === "bool") {
    if (!["true", "false"].includes(raw.toLowerCase())) {
      throw new AgentMailError(`${spec.key} must be true or false`, 2);
    }
    value = raw.toLowerCase() === "true";
  }
  return validateSettingValue(spec, value);
}

export function getSetting(home: string, key: string): SettingSpec & { value: unknown } {
  return withSettingsLock(home, () => getSettingUnlocked(home, key));
}

function getSettingUnlocked(
  home: string,
  key: string,
): SettingSpec & { value: unknown } {
  const spec = settingSpec(key);
  if (spec.authority === "policy.yaml") {
    validatePolicySettingsDocument(home);
  }
  const value = validateSettingValue(spec, valueFrom(home, spec));
  return { ...structuredClone(spec), value };
}

export function listSettings(home: string): Array<SettingSpec & { value: unknown }> {
  return withSettingsLock(home, () => {
    const registry = loadSettingsRegistry();
    validatePolicySettingsDocument(home, registry);
    return registry.settings.map((entry) =>
      getSettingUnlocked(home, entry.key),
    );
  });
}

export function setSetting(
  home: string,
  key: string,
  rawValue: string,
): SettingSpec & { value: unknown } {
  const spec = settingSpec(key);
  if (!spec.writable) throw new AgentMailError(`setting is read-only: ${key}`, 2);
  const value = parseSettingValue(spec, rawValue);
  return withSettingsLock(home, () =>
    setSettingUnlocked(home, spec, value),
  );
}

function settingsLockTarget(home: string): string {
  return path.join(path.resolve(home), ".locks", "settings");
}

function withSettingsLock<T>(home: string, fn: () => T): T {
  return withFileLockSync(settingsLockTarget(home), fn);
}

function policyDefaultsFromRegistry(
  registry: SettingsRegistry = loadSettingsRegistry(),
): PolicyDefaults {
  const value = (key: string) => {
    const spec = registry.settings.find((entry) => entry.key === key);
    if (!spec) {
      throw new AgentMailError(`settings registry is missing ${key}`, 3);
    }
    return structuredClone(spec.default);
  };
  return {
    default_execution_mode: value(
      "policy.default_execution_mode",
    ) as PolicyDefaults["default_execution_mode"],
    roster_mode: value("policy.roster_mode") as PolicyDefaults["roster_mode"],
    effect_rules: value(
      "policy.effect_rules",
    ) as PolicyDefaults["effect_rules"],
    allow_edges: value("policy.allow_edges") as PolicyDefaults["allow_edges"],
  };
}

function validatePolicySettingsDocument(
  home: string,
  registry: SettingsRegistry = loadSettingsRegistry(),
): void {
  validatePolicyDocument(
    loadDocument(home, "policy.yaml"),
    policyDefaultsFromRegistry(registry),
  );
}

function setSettingUnlocked(
  home: string,
  spec: SettingSpec,
  value: unknown,
): SettingSpec & { value: unknown } {
  const targets = [...new Set([spec.authority, ...spec.mirrors])].sort();
  const originals = Object.fromEntries(
    targets.map((filename) => [
      filename,
      fs.readFileSync(path.join(home, filename), "utf8"),
    ]),
  );
  const documents = Object.fromEntries(
    targets.map((filename) => [filename, loadDocument(home, filename)]),
  );
  for (const filename of targets) {
    documents[filename][leafName(spec)] = structuredClone(value);
  }
  const registry = loadSettingsRegistry();
  for (const filename of targets) {
    for (const documentSpec of registry.settings) {
      if (
        documentSpec.authority !== filename &&
        !documentSpec.mirrors.includes(filename)
      ) {
        continue;
      }
      const documentValue = documents[filename][leafName(documentSpec)];
      validateSettingValue(
        documentSpec,
        documentValue === undefined
          ? structuredClone(documentSpec.default)
          : documentValue,
      );
    }
  }
  if ("policy.yaml" in documents) {
    validatePolicyDocument(
      documents["policy.yaml"],
      policyDefaultsFromRegistry(registry),
    );
  }

  const written: string[] = [];
  try {
    for (const filename of targets) {
      atomicWriteText(path.join(home, filename), dumpDocument(filename, documents[filename]));
      written.push(filename);
    }
  } catch (error) {
    for (const filename of written.reverse()) {
      try {
        atomicWriteText(path.join(home, filename), originals[filename]);
      } catch {
        // mirrorErrors reports any rollback failure as hard configuration drift.
      }
    }
    throw error;
  }
  return getSettingUnlocked(home, spec.key);
}

export function mirrorErrors(home: string): string[] {
  return withSettingsLock(home, () => mirrorErrorsUnlocked(home));
}

function mirrorErrorsUnlocked(home: string): string[] {
  const errors: string[] = [];
  const registry = loadSettingsRegistry();
  try {
    validatePolicySettingsDocument(home, registry);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const spec of registry.settings) {
    try {
      const authoritative = validateSettingValue(spec, valueFrom(home, spec));
      for (const mirror of spec.mirrors) {
        const mirrorDocument = loadDocument(home, mirror);
        const leaf = leafName(spec);
        if (!(leaf in mirrorDocument)) {
          errors.push(`${spec.key} mirror missing from ${mirror}`);
          continue;
        }
        const mirrored = validateSettingValue(spec, mirrorDocument[leaf]);
        if (JSON.stringify(mirrored) !== JSON.stringify(authoritative)) {
          errors.push(
            `${spec.key} mirror mismatch: ${mirror}=${JSON.stringify(mirrored)}, ` +
              `${spec.authority}=${JSON.stringify(authoritative)}`,
          );
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${spec.key}: ${detail}`);
    }
  }
  return [...new Set(errors)];
}
