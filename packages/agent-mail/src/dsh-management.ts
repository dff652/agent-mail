/** Optional DSH host adapter. Provider code and protected configuration stay
 * outside the UI bundle; this module registers no model-callable tools. */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConnectionSnapshot } from "./connection.js";
import { createAuthenticatedManagementListener } from "./management-session.js";
import type { ConnectionManagementOptions } from "./connection-management.js";

type ProfileOptions = ConnectionManagementOptions["profiles"] extends ReadonlyMap<string, infer T> ? T : never;
export interface ManagementHostConfig {
  origin: string;
  activeProfileHandle: string;
  operator: { principal: string; passwordFile: string; allowedProfiles: string[] };
  profiles: Map<string, ProfileOptions & { label: string }>;
}
interface ToolResult { isError?: boolean; content?: { type: string; text?: string }[] }
interface ToolDefinition {
  execute(args: Record<string, unknown>, options: {
    signal: AbortSignal; deferContext(): void; concludeTurn(): void;
  }): Promise<ToolResult>;
}
export interface DshManagementContext {
  get?(name: string): unknown;
  inject(services: string[], callback: (host: DshManagementContext) => void): unknown;
  effect(callback: () => (() => void)): unknown;
  webServer?: { register(route: {
    kind: "prefix"; path: string;
    handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  }): () => void };
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw new Error("invalid management configuration");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new Error("invalid management configuration");
  return value;
}
function absolute(value: unknown): string {
  const result = text(value);
  if (!path.isAbsolute(result)) throw new Error("management paths must be absolute");
  return result;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error("invalid management configuration");
  const result = value.map(text);
  if (new Set(result).size !== result.length) throw new Error("duplicate management configuration");
  return result;
}

/** A private, operator-owned file is the entire registry; browser data never
 * resolves homes, password files, CA files or executable commands. */
export function loadManagementHostConfig(filename: string): ManagementHostConfig {
  try {
    const file = absolute(filename);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768 ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("unsafe config");
    const doc = object(JSON.parse(fs.readFileSync(file, "utf8")), ["schema_version", "origin", "active_profile_handle", "operator", "profiles"]);
    if (doc.schema_version !== 1) throw new Error("invalid schema");
    const operator = object(doc.operator, ["principal", "password_file", "allowed_profiles"]);
    const profileDocs = object(doc.profiles, Object.keys((doc.profiles || {}) as object));
    const entries = Object.entries(profileDocs);
    if (!entries.length || entries.length > 32) throw new Error("invalid profiles");
    const profiles: ManagementHostConfig["profiles"] = new Map();
    for (const [handle, value] of entries) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(handle)) throw new Error("invalid profile handle");
      const profile = object(value, ["label", "home", "allowed_hub_urls", "ca_file"]);
      const home = absolute(profile.home);
      if (!fs.lstatSync(home).isDirectory() || fs.lstatSync(home).isSymbolicLink()) throw new Error("invalid home");
      profiles.set(handle, { label: text(profile.label), home,
        allowedHubUrls: strings(profile.allowed_hub_urls),
        ...(profile.ca_file === undefined ? {} : { caFile: absolute(profile.ca_file) }),
      });
    }
    const activeProfileHandle = text(doc.active_profile_handle);
    if (!profiles.has(activeProfileHandle)) throw new Error("unknown active profile");
    return { origin: text(doc.origin), activeProfileHandle, profiles,
      operator: { principal: text(operator.principal), passwordFile: absolute(operator.password_file),
        allowedProfiles: strings(operator.allowed_profiles) } };
  } catch { throw new Error("management configuration is invalid or inaccessible"); }
}

/** Create a high-entropy management login secret without printing it or
 * replacing an existing file. This is independent of Hub bearer credentials. */
export function createManagementPasswordFile(filename: string): void {
  const target = absolute(filename);
  const secret = randomBytes(32).toString("base64url") + "\n";
  const fd = fs.openSync(target, "wx", 0o600);
  try { fs.writeFileSync(fd, secret); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function tool(ctx: Pick<DshManagementContext, "get">, name: string): Promise<Record<string, unknown>> {
  const tools = ctx.get?.("tools") as { get(name: string): ToolDefinition | undefined } | undefined;
  const definition = tools?.get(`mcp__agent-mail__${name}`);
  if (!definition?.execute) throw new Error("provider process is not available");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      definition.execute({}, { signal: controller.signal, deferContext() {}, concludeTurn() {} }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error("provider verification timed out"));
      }, 8000); }),
    ]);
    if (result.isError || !Array.isArray(result.content)) throw new Error("provider verification failed");
    const item = result.content.find(value => value.type === "text");
    const parsed = JSON.parse(item?.text || "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid provider evidence");
    return parsed as Record<string, unknown>;
  } finally { clearTimeout(timer); }
}

/** The named current profile is the only one whose activation can be proved
 * through this DSH context. Other registry targets stay restart_required. */
export function managementProfilesForDsh(config: ManagementHostConfig, ctx: Pick<DshManagementContext, "get">): ManagementHostConfig["profiles"] {
  const profiles = new Map(config.profiles);
  const active = profiles.get(config.activeProfileHandle)!;
  profiles.set(config.activeProfileHandle, { ...active, activationVerifier: async input => {
    const before = loadConnectionSnapshot(active.home);
    const [diagnosis, directory] = await Promise.all([tool(ctx, "comm_diagnose"), tool(ctx, "comm_list_agents")]);
    const after = loadConnectionSnapshot(active.home);
    const matches = input.home === active.home && before.revision === after.revision &&
      path.resolve(active.home, before.settings.token_file) === path.resolve(active.home, input.token_file) &&
      diagnosis.connection_revision === before.revision && diagnosis.credential_source === "token_file" &&
      diagnosis.remote === true && diagnosis.mode === "remote_mail_api" && diagnosis.tls_verified === true &&
      diagnosis.hub_url === input.endpoint && diagnosis.agent_id === input.agent_id &&
      directory.remote === true && Array.isArray(directory.agents);
    return { effective_hub_url: typeof diagnosis.hub_url === "string" ? diagnosis.hub_url : "",
      agent_id: typeof diagnosis.agent_id === "string" ? diagnosis.agent_id : "", route_verified: matches,
      observed_at: new Date().toISOString() };
  } });
  return profiles;
}

export const name = "agent-mail/dsh-management";
const mountedServers = new WeakSet<object>();
export function apply(ctx: DshManagementContext, options: { configFile: string }): void {
  const config = loadManagementHostConfig(options?.configFile);
  // Tool access is resolved at activation time, as in the ordinary DSH UI.
  // The login route must also exist before the MCP child becomes available.
  ctx.inject(["webServer"], host => {
    const server = host.webServer ?? host.get?.("webServer") as DshManagementContext["webServer"];
    if (!server?.register) throw new Error("management web host unavailable");
    const listener = createAuthenticatedManagementListener({ ...config, profiles: managementProfilesForDsh(config, {
      get: key => host.get?.(key) ?? ctx.get?.(key),
    }) });
    host.effect(() => {
      if (mountedServers.has(server)) { listener.dispose(); throw new Error("duplicate management namespace"); }
      mountedServers.add(server);
      const disposers: (() => void)[] = [];
      try {
        // DSH's segment-prefix matcher appends its own slash.
        for (const prefix of ["/v1/management-session", "/v1/connection-management"]) {
          disposers.push(server.register({ kind: "prefix", path: prefix, handler: async (req, res) => {
            if (!await listener.handle(req, res)) { res.writeHead(404); res.end(); }
          } }));
        }
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose();
        mountedServers.delete(server);
        listener.dispose(); throw error;
      }
      return () => { for (const dispose of disposers.reverse()) dispose(); mountedServers.delete(server); listener.dispose(); };
    });
  });
}
