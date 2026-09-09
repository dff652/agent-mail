import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { initProject } from "../src/services.js";
import { setConnection, loadConnectionSnapshot } from "../src/connection.js";
import { apply, createManagementPasswordFile, loadManagementHostConfig, managementProfilesForDsh,
  type DshManagementContext } from "../src/dsh-management.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-management-test-")); roots.push(root);
  const home = initProject(path.join(root, ".agent-mail"));
  const passwordFile = path.join(root, "password"); createManagementPasswordFile(passwordFile);
  const filename = path.join(root, "management.json");
  const document = { schema_version: 1, origin: "http://localhost:7422", active_profile_handle: "current",
    operator: { principal: "operator", password_file: passwordFile, allowed_profiles: ["current"] },
    profiles: { current: { label: "Current DSH", home, allowed_hub_urls: ["https://hub.example"] } } };
  fs.writeFileSync(filename, JSON.stringify(document), { mode: 0o600 });
  return { root, home, passwordFile, filename, document };
}

it("creates private login material without replacing it and rejects unsafe registry files", () => {
  const { root, passwordFile, filename, document } = setup();
  const secret = fs.readFileSync(passwordFile, "utf8");
  expect(secret.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(() => createManagementPasswordFile(passwordFile)).toThrow();
  expect(fs.readFileSync(passwordFile, "utf8")).toBe(secret);
  const link = path.join(root, "link.json"); fs.symlinkSync(filename, link);
  expect(() => loadManagementHostConfig(link)).toThrow("management configuration is invalid or inaccessible");
  fs.chmodSync(filename, 0o644);
  expect(() => loadManagementHostConfig(filename)).toThrow();
  fs.chmodSync(filename, 0o600);
  fs.writeFileSync(filename, JSON.stringify({ ...document, command: "unexpected" }));
  expect(() => loadManagementHostConfig(filename)).toThrow();
  fs.writeFileSync(filename, JSON.stringify(document));
  expect(loadManagementHostConfig(filename).operator.allowedProfiles).toEqual(["current"]);
});

it("binds activation to this DSH process and the saved credential generation", async () => {
  const { home, filename } = setup();
  const token = path.join(home, "new.token"); fs.writeFileSync(token, "synthetic", { mode: 0o600 });
  setConnection(home, { hub_url: "https://hub.example", token_file: token });
  const diagnosis = { remote: true, mode: "remote_mail_api", hub_url: "https://hub.example", agent_id: "new@local",
    connection_revision: loadConnectionSnapshot(home).revision, credential_source: "token_file", tls_verified: true };
  const config = loadManagementHostConfig(filename);
  const context = { get: () => ({ get: (name: string) => ({ execute: async () => ({
    content: [{ type: "text", text: JSON.stringify(name.endsWith("comm_diagnose") ? diagnosis : { remote: true, agents: [] }) }],
  }) }) }) } as unknown as DshManagementContext;
  const verifier = managementProfilesForDsh(config, context).get("current")!.activationVerifier!;
  const input = { home, endpoint: diagnosis.hub_url, agent_id: diagnosis.agent_id, token_file: token };
  expect((await verifier(input)).route_verified).toBe(true);
  // The enrollment journal returns paths relative to the provider home.
  expect((await verifier({ ...input, token_file: "new.token" })).route_verified).toBe(true);
  expect((await verifier({ ...input, token_file: "different.token" })).route_verified).toBe(false);
  diagnosis.connection_revision = "rev_wrong_generation";
  expect((await verifier(input)).route_verified).toBe(false);
  diagnosis.connection_revision = loadConnectionSnapshot(home).revision;
  diagnosis.credential_source = "env";
  expect((await verifier(input)).route_verified).toBe(false);
  diagnosis.credential_source = "token_file"; diagnosis.tls_verified = false;
  expect((await verifier(input)).route_verified).toBe(false);
});

it("mounts two private management routes, refuses duplicates and disposes both", () => {
  const { filename } = setup();
  const routes: string[] = [], effects: (() => void)[] = [];
  const context: DshManagementContext = {
    inject: (_services, callback) => callback(context),
    effect: callback => { effects.push(callback()); },
    webServer: { register: route => { routes.push(route.path); return () => { routes.splice(routes.indexOf(route.path), 1); }; } },
  };
  apply(context, { configFile: filename });
  expect(routes).toEqual(["/v1/management-session", "/v1/connection-management"]);
  expect(() => apply(context, { configFile: filename })).toThrow("duplicate management namespace");
  for (const dispose of effects.splice(0)) dispose();
  expect(routes).toEqual([]);
  apply(context, { configFile: filename });
  for (const dispose of effects.splice(0)) dispose();
});
