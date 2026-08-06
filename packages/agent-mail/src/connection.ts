/**
 * Hub client connection: connection.json plus environment overrides.
 * Never stores live bearer in connection.json.
 */
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import { atomicWriteText } from "./atomic-file.js";
import { rejectPlaintextSecretsInConnection } from "./connection-policy.js";
import { AgentMailError } from "./errors.js";

export interface ConnectionSettings {
  hub_url: string;
  token_file: string;
  ca_file: string;
  insecure_tls: boolean;
  note: string;
  set_at: string;
}

export interface ResolvedConnection {
  hub_url: string;
  hub_token: string | null;
  hub_ca_file: string | null;
  hub_insecure_tls: boolean;
  sources: Record<string, string>;
  warnings: string[];
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env[name] || "").trim().toLowerCase(),
  );
}

export function connectionPath(home: string): string {
  return path.join(home, "connection.json");
}

export function validateHubUrl(url: string): string {
  const raw = url.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AgentMailError(`invalid hub_url: ${url}`, 2);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AgentMailError("hub_url must be http(s)://", 2);
  }
  const host = (parsed.hostname || "").toLowerCase();
  if (parsed.protocol === "http:" && !LOOPBACK.has(host)) {
    throw new AgentMailError(
      "non-loopback hub_url must use https:// (or set insecure only for lab with explicit insecure_tls)",
      2,
    );
  }
  return raw;
}

export function loadConnection(home: string): ConnectionSettings {
  const p = connectionPath(home);
  if (!fs.existsSync(p)) {
    return {
      hub_url: "",
      token_file: "",
      ca_file: "",
      insecure_tls: false,
      note: "",
      set_at: "",
    };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new AgentMailError(`cannot read connection.json: ${e}`, 2);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentMailError("connection.json must be a JSON object", 2);
  }
  rejectPlaintextSecretsInConnection(raw);
  let hub_url = String(raw.hub_url || "").trim();
  if (hub_url) hub_url = validateHubUrl(hub_url);
  return {
    hub_url,
    token_file: String(raw.token_file || "").trim(),
    ca_file: String(raw.ca_file || "").trim(),
    insecure_tls: Boolean(raw.insecure_tls),
    note: String(raw.note || "").trim(),
    set_at: String(raw.set_at || "").trim(),
  };
}

export function setConnection(
  home: string,
  patch: Partial<ConnectionSettings>,
  merge = true,
): ConnectionSettings {
  if (!fs.existsSync(home)) {
    throw new AgentMailError(`not initialized: ${home}`, 3);
  }
  const current = merge ? loadConnection(home) : {
    hub_url: "",
    token_file: "",
    ca_file: "",
    insecure_tls: false,
    note: "",
    set_at: "",
  };
  const next: ConnectionSettings = {
    hub_url:
      patch.hub_url !== undefined
        ? patch.hub_url.trim()
          ? validateHubUrl(patch.hub_url)
          : ""
        : current.hub_url,
    token_file:
      patch.token_file !== undefined ? patch.token_file.trim() : current.token_file,
    ca_file: patch.ca_file !== undefined ? patch.ca_file.trim() : current.ca_file,
    insecure_tls:
      patch.insecure_tls !== undefined ? Boolean(patch.insecure_tls) : current.insecure_tls,
    note: patch.note !== undefined ? patch.note.trim() : current.note,
    set_at: new Date().toISOString(),
  };
  if (next.insecure_tls && next.ca_file) {
    throw new AgentMailError("insecure_tls and ca_file are mutually exclusive", 2);
  }
  atomicWriteText(connectionPath(home), JSON.stringify(next, null, 2) + "\n", 0o600);
  return next;
}

function resolvePath(home: string, value: string, label: string, mustExist: boolean): string {
  const expanded = value.startsWith("~")
    ? path.join(process.env.HOME || "", value.slice(1))
    : value;
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(home, expanded);
  if (mustExist && !fs.existsSync(resolved)) {
    throw new AgentMailError(`${label} not found: ${value} (${resolved})`, 2);
  }
  return resolved;
}

export function resolveClientConnection(
  home: string,
  overrides: {
    hub_url?: string | null;
    hub_token?: string | null;
    hub_ca_file?: string | null;
    hub_insecure_tls?: boolean | null;
  } = {},
): ResolvedConnection {
  const stored = fs.existsSync(home)
    ? loadConnection(home)
    : {
        hub_url: "",
        token_file: "",
        ca_file: "",
        insecure_tls: false,
        note: "",
        set_at: "",
      };
  const sources: Record<string, string> = {};
  const warnings: string[] = [];

  // hub_url: override > env > file
  let hub_url = "";
  if (overrides.hub_url != null && String(overrides.hub_url).trim()) {
    hub_url = validateHubUrl(String(overrides.hub_url));
    sources.hub_url = "override";
  } else if ((process.env.AGENT_MAIL_HUB_URL || "").trim()) {
    hub_url = validateHubUrl(process.env.AGENT_MAIL_HUB_URL!);
    sources.hub_url = "env";
  } else if (stored.hub_url) {
    hub_url = stored.hub_url;
    sources.hub_url = "connection.json";
  }

  // token: override > env AGENT_MAIL_HUB_TOKEN > token_file
  let hub_token: string | null = null;
  if (overrides.hub_token != null && String(overrides.hub_token).trim()) {
    hub_token = String(overrides.hub_token).trim();
    sources.hub_token = "override";
  } else if ((process.env.AGENT_MAIL_HUB_TOKEN || "").trim()) {
    hub_token = process.env.AGENT_MAIL_HUB_TOKEN!.trim();
    sources.hub_token = "env";
  } else if (stored.token_file) {
    const tf = resolvePath(home, stored.token_file, "token_file", true);
    const text = fs.readFileSync(tf, "utf8").trim();
    if (!text) throw new AgentMailError(`token_file is empty: ${tf}`, 2);
    hub_token = text.split(/\r?\n/)[0]!.trim();
    sources.hub_token = "token_file";
    try {
      const mode = fs.statSync(tf).mode & 0o777;
      if (mode & 0o077) {
        warnings.push(`token_file ${tf} mode is ${mode.toString(8)}; recommend chmod 600`);
      }
    } catch {
      /* ignore */
    }
  }

  let hub_ca_file: string | null = null;
  if (overrides.hub_ca_file != null && String(overrides.hub_ca_file).trim()) {
    hub_ca_file = resolvePath(home, String(overrides.hub_ca_file), "ca_file", true);
    sources.hub_ca_file = "override";
  } else if ((process.env.AGENT_MAIL_HUB_CA_FILE || "").trim()) {
    hub_ca_file = resolvePath(
      home,
      process.env.AGENT_MAIL_HUB_CA_FILE!,
      "ca_file",
      true,
    );
    sources.hub_ca_file = "env";
  } else if (stored.ca_file) {
    hub_ca_file = resolvePath(home, stored.ca_file, "ca_file", true);
    sources.hub_ca_file = "connection.json";
  }

  let hub_insecure_tls = false;
  if (overrides.hub_insecure_tls != null) {
    hub_insecure_tls = Boolean(overrides.hub_insecure_tls);
    sources.hub_insecure_tls = "override";
  } else if (envFlag("AGENT_MAIL_HUB_INSECURE_TLS")) {
    hub_insecure_tls = true;
    sources.hub_insecure_tls = "env";
  } else if (stored.insecure_tls) {
    hub_insecure_tls = true;
    sources.hub_insecure_tls = "connection.json";
  }

  if (hub_insecure_tls && hub_ca_file) {
    throw new AgentMailError("insecure_tls and ca_file are mutually exclusive", 2);
  }
  if (hub_insecure_tls) {
    warnings.push("hub_insecure_tls enabled — TLS verification disabled (lab only)");
  }

  return {
    hub_url,
    hub_token,
    hub_ca_file,
    hub_insecure_tls,
    sources,
    warnings,
  };
}

export function remoteModeEnabled(): boolean {
  return Boolean((process.env.AGENT_MAIL_HUB_URL || "").trim());
}
