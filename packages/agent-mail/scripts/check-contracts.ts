import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

const ARTIFACT_KEYS = [
  "fixtures",
  "policy_fixtures",
  "mcp",
  "http",
  "settings",
  "cli",
] as const;

type JsonObject = Record<string, unknown>;

export type ContractValidationResult = {
  artifactCount: number;
  errors: string[];
  protocol: string | null;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string, label: string, errors: string[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    errors.push(`invalid JSON ${label}: ${String(error)}`);
    return null;
  }
}

function resolveContained(
  base: string,
  relative: string,
  label: string,
  errors: string[],
): string | null {
  if (path.isAbsolute(relative)) {
    errors.push(`${label} must be relative: ${relative}`);
    return null;
  }
  const resolved = path.resolve(base, relative);
  const prefix = `${path.resolve(base)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    errors.push(`${label} escapes its root: ${relative}`);
    return null;
  }
  return resolved;
}

function formatAjvErrors(ajv: Ajv2020, prefix: string): string {
  return `${prefix}: ${ajv.errorsText(ajv.errors, { separator: "; " })}`;
}

export function validateContracts(repoRoot: string): ContractValidationResult {
  const root = path.resolve(repoRoot);
  const contracts = path.join(root, "contracts");
  const manifestPath = path.join(contracts, "manifest.json");
  const errors: string[] = [];
  const documents = new Map<string, unknown>();
  let artifactCount = 0;

  if (!fs.existsSync(manifestPath)) {
    return {
      artifactCount,
      errors: ["missing contracts/manifest.json"],
      protocol: null,
    };
  }

  const manifestValue = readJson(manifestPath, "contracts/manifest.json", errors);
  if (!isObject(manifestValue)) {
    if (errors.length === 0) {
      errors.push("contracts/manifest.json must contain an object");
    }
    return { artifactCount, errors, protocol: null };
  }
  const manifest = manifestValue;

  for (const key of ARTIFACT_KEYS) {
    const entries = manifest[key];
    if (!Array.isArray(entries)) {
      errors.push(`manifest ${key} must be an array`);
      continue;
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== "string") {
        errors.push(`manifest ${key} entries must be strings`);
        continue;
      }
      artifactCount += 1;
      if (seen.has(entry)) {
        errors.push(`duplicate ${key} artifact: ${entry}`);
        continue;
      }
      seen.add(entry);
      const artifact = resolveContained(contracts, entry, `${key} artifact`, errors);
      if (artifact === null) continue;
      if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
        errors.push(`missing ${entry}`);
        continue;
      }
      documents.set(entry, readJson(artifact, entry, errors));
    }
  }

  const schemaEntries = manifest.schemas;
  if (!isObject(schemaEntries)) {
    errors.push("manifest schemas must be an object");
  } else {
    for (const [name, entry] of Object.entries(schemaEntries)) {
      if (typeof entry !== "string") {
        errors.push(`manifest schema ${name} must be a path`);
        continue;
      }
      const schemaPath = resolveContained(root, entry, `schema ${name}`, errors);
      if (
        schemaPath !== null &&
        (!fs.existsSync(schemaPath) || !fs.statSync(schemaPath).isFile())
      ) {
        errors.push(`missing schema ${entry}`);
      }
    }
  }

  const settingsSchemaEntry =
    isObject(schemaEntries) && typeof schemaEntries.settings === "string"
      ? schemaEntries.settings
      : null;
  if (settingsSchemaEntry === null) {
    errors.push("manifest schemas.settings must be a path");
  }
  const settingsSchemaPath =
    settingsSchemaEntry === null
      ? null
      : resolveContained(root, settingsSchemaEntry, "settings schema", errors);
  const settingsSchema =
    settingsSchemaPath !== null &&
    fs.existsSync(settingsSchemaPath) &&
    fs.statSync(settingsSchemaPath).isFile()
      ? readJson(settingsSchemaPath, settingsSchemaEntry!, errors)
      : null;

  const settings = documents.get("settings.json");
  // The checked-in Draft 2020-12 schemas use conditional `required` clauses
  // whose properties are declared in the parent object. This is valid JSON
  // Schema, but Ajv's optional strictRequired lint rejects that composition.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });

  for (const [name, schema] of [
    ["settings.schema.json", settingsSchema],
  ] as const) {
    if (!isObject(schema)) {
      errors.push(`${name} must contain a JSON object`);
      continue;
    }
    try {
      if (!ajv.validateSchema(schema)) {
        errors.push(formatAjvErrors(ajv, `invalid JSON Schema ${name}`));
      }
    } catch (error) {
      errors.push(`invalid JSON Schema ${name}: ${String(error)}`);
    }
  }

  if (isObject(settingsSchema) && isObject(settings)) {
    try {
      const validate = ajv.compile(settingsSchema);
      if (!validate(settings)) {
        errors.push(
          `settings.json: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
        );
      }
    } catch (error) {
      errors.push(`cannot validate settings.json: ${String(error)}`);
    }
  }

  const settingsSource = path.join(contracts, "settings.json");
  const packagedSettings = path.join(root, "packages", "agent-mail", "settings.json");
  if (!fs.existsSync(packagedSettings) || !fs.statSync(packagedSettings).isFile()) {
    errors.push("missing packaged settings snapshot packages/agent-mail/settings.json");
  } else if (
    fs.existsSync(settingsSource) &&
    !fs.readFileSync(settingsSource).equals(fs.readFileSync(packagedSettings))
  ) {
    errors.push(
      "packaged settings snapshot differs: packages/agent-mail/settings.json",
    );
  }

  // Behaviour-contract files shipped in the npm package must stay byte-identical
  // to refs/ — init copies the packaged snapshot into every project home.
  for (const name of ["PROTOCOL.md", "message.schema.json", "roster.schema.json"]) {
    const source = path.join(root, "refs", name);
    const mirror = path.join(root, "packages", "agent-mail", "refs", name);
    if (!fs.existsSync(mirror) || !fs.statSync(mirror).isFile()) {
      errors.push(`missing packaged reference packages/agent-mail/refs/${name}`);
    } else if (
      fs.existsSync(source) &&
      !fs.readFileSync(source).equals(fs.readFileSync(mirror))
    ) {
      errors.push(`packaged reference differs from refs/: ${name}`);
    }
  }

  return {
    artifactCount,
    errors,
    protocol: typeof manifest.protocol === "string" ? manifest.protocol : null,
  };
}

function main(): number {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../../..");
  const result = validateContracts(repoRoot);
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      process.stderr.write(`FAIL ${error}\n`);
    }
    return 1;
  }
  process.stdout.write(
    `OK contracts manifest (${result.artifactCount} artifacts, protocol=${result.protocol})\n`,
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
