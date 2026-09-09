/** Host-mounted management API. The embedding host supplies its authenticated
 * session, CSRF and per-profile permission checks; absence always denies. */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ConnectionEnrollmentManager,
  EnrollmentManagerError,
  type ConnectionEnrollmentManagerOptions,
} from "./connection-enrollment.js";

const PREFIX = "/v1/connection-management/";
const FIELDS = {
  begin: ["endpoint"],
  redeem: ["context_handle", "request_id", "code"],
  status: ["enrollment_handle"],
  commit: ["enrollment_handle", "expected_config_revision", "confirmed_agent_id"],
  cancel: ["enrollment_handle"],
  activate: ["enrollment_handle"],
} as const;
type Action = keyof typeof FIELDS;
type ProfileOptions = Omit<ConnectionEnrollmentManagerOptions, "owner" | "targetProfileHandle" | "allowedHubUrls"> & {
  allowedHubUrls: readonly string[];
};

export interface ManagementAuthorization {
  /** Stable authenticated subject, obtained from the host session. */
  principal: string;
  csrfValidated: boolean;
  canManageTarget: boolean;
}

export interface ConnectionManagementOptions {
  origin: string;
  profiles: ReadonlyMap<string, ProfileOptions>;
  authorize?: (
    request: IncomingMessage,
    target: { profile_handle: string; action: Action },
  ) => Promise<ManagementAuthorization | null> | ManagementAuthorization | null;
}

class ManagementWireError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage, action: Action): Promise<Record<string, string>> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new ManagementWireError("json_required", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 4096) throw new ManagementWireError("body_too_large", 413);
    chunks.push(data);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ManagementWireError("invalid_request", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManagementWireError("invalid_request", 400);
  }
  const value = parsed as Record<string, unknown>;
  const keys: string[] = ["profile_handle", ...FIELDS[action]];
  if (Object.keys(value).length !== keys.length || keys.some(key => (
    typeof value[key] !== "string" || !value[key] || (value[key] as string).length > 512
  ))) throw new ManagementWireError("invalid_request", 400);
  return value as Record<string, string>;
}

/** Mount only on the authenticated management host, never on its MCP proxy.
 * Activation evidence is supplied by the configured server-side verifier. */
export function createConnectionManagementListener(options: ConnectionManagementOptions) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.username || origin.password ||
      !["https:", "http:"].includes(origin.protocol)) throw new Error("invalid management origin");
  const profiles = new Map(options.profiles);
  for (const profile of profiles.values()) {
    if (!Array.isArray(profile.allowedHubUrls) || profile.allowedHubUrls.length === 0) {
      throw new Error("management profiles require explicit Hub targets");
    }
  }
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = (req.url || "").split("?", 1)[0]!;
    if (!pathname.startsWith(PREFIX)) return false;
    try {
      const action = pathname.slice(PREFIX.length) as Action;
      if (!Object.hasOwn(FIELDS, action)) throw new ManagementWireError("not_found", 404);
      if (!options.authorize || req.headers.origin !== origin.origin || req.headers.host !== origin.host) {
        throw new ManagementWireError("management_denied", 403);
      }
      if (req.method !== "POST") throw new ManagementWireError("method_not_allowed", 405);
      if ((req.url || "").includes("?")) throw new ManagementWireError("invalid_request", 400);
      const input = await readBody(req, action);
      const authorization = await options.authorize(req, { profile_handle: input.profile_handle!, action });
      if (!authorization || !authorization.csrfValidated || !authorization.canManageTarget ||
          typeof authorization.principal !== "string" || !authorization.principal.trim()) {
        throw new ManagementWireError("management_denied", 403);
      }
      const profile = profiles.get(input.profile_handle!);
      if (!profile) throw new ManagementWireError("target_not_allowed", 403);
      const manager = new ConnectionEnrollmentManager({ ...profile,
        owner: authorization.principal, targetProfileHandle: input.profile_handle! });
      let value: unknown;
      switch (action) {
        case "begin": value = await manager.begin({ endpoint: input.endpoint! }); break;
        case "redeem": value = await manager.redeem({ context_handle: input.context_handle!,
          request_id: input.request_id!, code: input.code! }); break;
        case "status": value = await manager.status({ enrollment_handle: input.enrollment_handle! }); break;
        case "commit": value = await manager.commit({ enrollment_handle: input.enrollment_handle!,
          expected_config_revision: input.expected_config_revision!, confirmed_agent_id: input.confirmed_agent_id! }); break;
        case "cancel": value = await manager.cancel({ enrollment_handle: input.enrollment_handle! }); break;
        case "activate": value = await manager.activate({ enrollment_handle: input.enrollment_handle! }); break;
      }
      reply(res, 200, { ok: true, value });
    } catch (error) {
      if (error instanceof EnrollmentManagerError) {
        reply(res, error.code === "management_denied" ? 403 : 409, { ok: false, error: error.toJSON() });
      } else {
        const known = error instanceof ManagementWireError;
        reply(res, known ? error.status : 503, { ok: false,
          error: { code: known ? error.code : "management_unavailable", stage: "management", retryable: !known } });
      }
    }
    return true;
  };
}
