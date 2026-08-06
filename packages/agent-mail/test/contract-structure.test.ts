import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateContracts } from "../scripts/check-contracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");

function contractFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-contracts-ts-"));
  fs.cpSync(path.join(REPO, "contracts"), path.join(root, "contracts"), {
    recursive: true,
  });
  fs.cpSync(path.join(REPO, "refs"), path.join(root, "refs"), { recursive: true });
  const packageRoot = path.join(root, "packages", "agent-mail");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.copyFileSync(
    path.join(REPO, "packages", "agent-mail", "settings.json"),
    path.join(packageRoot, "settings.json"),
  );
  return root;
}

describe("TypeScript-only contract structure validator", () => {
  it("validates the repository contracts without a Python runner", () => {
    const result = validateContracts(REPO);
    expect(result.errors).toEqual([]);
    expect(result.artifactCount).toBeGreaterThan(0);
    expect(result.protocol).toBe("0.2");
  });

  it("fails closed on missing, malformed, or drifted artifacts", () => {
    const root = contractFixture();
    fs.rmSync(
      path.join(root, "contracts", "fixtures", "lifecycle-ack-before-terminal.json"),
    );
    fs.writeFileSync(
      path.join(root, "contracts", "http", "mail-api-routes.json"),
      "{invalid",
    );
    fs.appendFileSync(
      path.join(root, "packages", "agent-mail", "settings.json"),
      "\n",
    );

    const result = validateContracts(root);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing fixtures/lifecycle-ack-before-terminal.json"),
        expect.stringContaining("invalid JSON http/mail-api-routes.json"),
        expect.stringContaining("packaged settings snapshot differs"),
      ]),
    );
  });

  it("rejects manifest traversal and schema-invalid settings", () => {
    const root = contractFixture();
    const manifestPath = path.join(root, "contracts", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      http: string[];
    };
    manifest.http.push("../../outside.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const settingsPath = path.join(root, "contracts", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    delete settings.version;
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const result = validateContracts(root);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("http artifact escapes its root"),
        expect.stringContaining("settings.json"),
      ]),
    );
  });

  it("keeps CI on the TypeScript toolchain", () => {
    const workflow = fs.readFileSync(
      path.join(REPO, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("actions/setup-node@");
    expect(workflow).toContain("bash scripts/run_contracts_ts.sh");
    expect(workflow).not.toMatch(/setup-python|pip install|python-ts-http-interop|contracts-dual/i);

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO, "packages", "agent-mail", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["test:contracts:ts-only"]).not.toContain(
      "python-ts-http-interop",
    );
  });
});
