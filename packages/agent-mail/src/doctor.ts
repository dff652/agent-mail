import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";

import {
  loadConnection,
  resolveClientConnection,
  type ResolvedConnection,
} from "./connection.js";
import { loadTokenRecords } from "./hub/auth.js";
import { validateAgentId } from "./ids.js";
import { loadPolicy } from "./policy.js";
import { loadRoster } from "./roster.js";
import { getStore, REFERENCE_FILES } from "./services.js";
import { listSettings, mirrorErrors } from "./settings.js";
import { runnerExecutableName } from "./wake/runner.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  home: string;
  deep: boolean;
  wake: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  deep?: boolean;
  wake?: boolean;
  runners?: readonly string[];
  hubUrl?: string;
  pathEnv?: string;
  timeoutMs?: number;
}

const RUNNERS = ["claude", "codex", "grok", "antigravity"] as const;

function check(
  id: string,
  status: CheckStatus,
  message: string,
  hint?: string,
): DoctorCheck {
  return { id, status, message, ...(hint ? { hint } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkLocalFiles(home: string): DoctorCheck[] {
  if (!fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
    return [
      check(
        "home",
        "fail",
        `missing Agent Mail home: ${home}`,
        "Run: agent-mail init --path <project>",
      ),
    ];
  }

  const results: DoctorCheck[] = [
    check("home", "pass", `Agent Mail home: ${home}`),
  ];

  try {
    const settings = listSettings(home);
    loadPolicy(home);
    const drift = mirrorErrors(home);
    if (drift.length > 0) {
      results.push(
        check(
          "config",
          "fail",
          `settings mirror drift: ${drift.join("; ")}`,
          "Use agent-mail config set to rewrite authority and mirrors together",
        ),
      );
    } else {
      results.push(
        check(
          "config",
          "pass",
          `config.json and policy.yaml valid (${settings.length} settings)`,
        ),
      );
    }
  } catch (error) {
    results.push(
      check(
        "config",
        "fail",
        errorMessage(error),
        "Fix config.json/policy.yaml or re-run agent-mail init in a disposable project",
      ),
    );
  }

  // Agents are pointed at .agent-mail/PROTOCOL.md as their behaviour contract,
  // so a home without it is not usable even though the store is fine (P1-2).
  const missingReferences: string[] = [];
  for (const name of REFERENCE_FILES) {
    const target = path.join(home, name);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 50) {
        missingReferences.push(name);
      }
    } catch {
      missingReferences.push(name);
    }
  }
  results.push(
    missingReferences.length === 0
      ? check(
          "references",
          "pass",
          `behaviour contract files present (${REFERENCE_FILES.length})`,
        )
      : check(
          "references",
          "fail",
          `missing, unsafe, or truncated: ${missingReferences.join(", ")}`,
          "Re-run agent-mail init in this project to restore PROTOCOL.md and the schemas",
        ),
  );

  try {
    const roster = loadRoster(home);
    if (
      !roster ||
      !Array.isArray(roster.agents) ||
      roster.agents.length === 0
    ) {
      throw new Error("agents.json must contain a non-empty agents array");
    }
    const ids = roster.agents.map((agent) => validateAgentId(agent.id));
    if (new Set(ids).size !== ids.length) {
      throw new Error("agents.json contains duplicate agent ids");
    }
    results.push(
      check("roster", "pass", `agents.json valid (${ids.length} agents)`),
    );
  } catch (error) {
    results.push(
      check(
        "roster",
        "fail",
        `invalid agents.json: ${errorMessage(error)}`,
        "Fix agents.json or restore it from a known-good project",
      ),
    );
  }

  try {
    const store = getStore(home);
    const diagnostics = store.diagnostics();
    if (
      diagnostics.integrity.length !== 1 ||
      diagnostics.integrity[0] !== "ok"
    ) {
      results.push(
        check(
          "store",
          "fail",
          `SQLite quick_check failed: ${diagnostics.integrity.join("; ")}`,
          "Stop writers, back up store.sqlite, then restore or repair the database",
        ),
      );
    } else {
      results.push(
        check(
          "store",
          "pass",
          `SQLite quick_check ok (journal=${diagnostics.journal_mode}, user_version=${diagnostics.user_version})`,
        ),
      );
    }
  } catch (error) {
    results.push(
      check(
        "store",
        "fail",
        `store diagnostics failed: ${errorMessage(error)}`,
        "Stop writers, back up store.sqlite, then restore or reinitialize the project",
      ),
    );
  }

  return results;
}

function checkTokenStore(home: string): DoctorCheck {
  try {
    const records = loadTokenRecords(home);
    if (records.length === 0) {
      return check(
        "tokens.store",
        "warn",
        "no Hub bearer tokens minted",
        "Required only for authenticated Hub use: agent-mail hub-token mint --as <agent-id>",
      );
    }
    for (const record of records) {
      if (!/^[0-9a-f]{64}$/i.test(record.token_hash)) {
        throw new Error(`invalid token hash for ${record.agent_id}`);
      }
    }
    const agents = [...new Set(records.map((record) => record.agent_id))].sort();
    return check(
      "tokens.store",
      "pass",
      `hashed Hub tokens configured for: ${agents.join(", ")}`,
    );
  } catch (error) {
    return check(
      "tokens.store",
      "fail",
      `invalid Hub token store: ${errorMessage(error)}`,
      "Repair auth/hub_tokens.json or re-mint affected tokens",
    );
  }
}

function configuredConnection(home: string): boolean {
  const stored = loadConnection(home);
  return Boolean(
    stored.hub_url ||
      stored.token_file ||
      stored.ca_file ||
      stored.insecure_tls,
  );
}

function checkCertificate(caFile: string | null): DoctorCheck {
  if (!caFile) {
    return check(
      "connection.certificate",
      "skip",
      "no custom CA configured",
    );
  }
  try {
    const certificate = new X509Certificate(fs.readFileSync(caFile));
    const expires = Date.parse(certificate.validTo);
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      return check(
        "connection.certificate",
        "fail",
        `CA certificate is expired or has an invalid expiry: ${caFile}`,
        "Replace the CA file and update connection.json",
      );
    }
    return check(
      "connection.certificate",
      "pass",
      `CA certificate parsed (valid_to=${certificate.validTo})`,
    );
  } catch (error) {
    return check(
      "connection.certificate",
      "fail",
      `cannot parse CA certificate ${caFile}: ${errorMessage(error)}`,
      "Use a readable PEM certificate file; never place a private key here",
    );
  }
}

function checkConnection(home: string): {
  checks: DoctorCheck[];
  resolved: ResolvedConnection | null;
} {
  let fileConfigured = false;
  try {
    fileConfigured = configuredConnection(home);
    const resolved = resolveClientConnection(home);
    const active =
      fileConfigured ||
      Boolean(
        resolved.hub_url ||
          resolved.hub_token ||
          resolved.hub_ca_file ||
          resolved.hub_insecure_tls,
      );
    if (!active) {
      return {
        checks: [
          check(
            "connection.config",
            "skip",
            "connection.json not configured (local-only mode)",
          ),
          checkCertificate(null),
        ],
        resolved,
      };
    }

    const checks = [
      check(
        "connection.config",
        "pass",
        `connection resolved (hub_url=${resolved.hub_url || "unset"}, token=${resolved.hub_token ? "set" : "unset"})`,
      ),
      checkCertificate(resolved.hub_ca_file),
      resolved.hub_token
        ? check("connection.token", "pass", "Hub bearer token resolved")
        : check(
            "connection.token",
            "warn",
            "Hub bearer token is unset",
            "Use a mode-0600 token_file or AGENT_MAIL_HUB_TOKEN",
          ),
      ...resolved.warnings.map((warning) =>
        check("connection.warning", "warn", warning),
      ),
    ];
    return { checks, resolved };
  } catch (error) {
    return {
      checks: [
        check(
          "connection.config",
          "fail",
          errorMessage(error),
          fileConfigured
            ? "Check hub_url, token_file and ca_file in connection.json"
            : "Check AGENT_MAIL_HUB_URL, token and CA environment settings",
        ),
      ],
      resolved: null,
    };
  }
}

function findExecutable(name: string, pathEnv: string): string | null {
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export function checkRunnerBinary(
  runner: string,
  pathEnv = process.env.PATH ?? "",
): DoctorCheck {
  const bin = runnerExecutableName(runner);
  const executable = findExecutable(bin, pathEnv);
  if (!executable) {
    return check(
      `runner.${runner}`,
      "warn",
      `${bin} CLI not found on PATH`,
      `Add ${bin} to PATH if this project uses the ${runner} live wake runner`,
    );
  }
  return check(
    `runner.${runner}`,
    "pass",
    `${runner} executable: ${executable}`,
  );
}

interface JsonResponse {
  status: number;
  json: Record<string, unknown>;
}

function requestJson(
  baseUrl: string,
  pathname: string,
  resolved: ResolvedConnection,
  timeoutMs: number,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, `${baseUrl.replace(/\/$/, "")}/`);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(resolved.hub_token
            ? { Authorization: `Bearer ${resolved.hub_token}` }
            : {}),
        },
        ...(isHttps
          ? {
              ca: resolved.hub_ca_file
                ? fs.readFileSync(resolved.hub_ca_file)
                : undefined,
              rejectUnauthorized: !resolved.hub_insecure_tls,
            }
          : {}),
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 64 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          if (bytes > 64 * 1024) {
            reject(new Error("Hub response exceeds 64 KiB"));
            return;
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            const parsed = raw ? (JSON.parse(raw) as unknown) : {};
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("response is not a JSON object");
            }
            json = parsed as Record<string, unknown>;
          } catch (error) {
            reject(new Error(`Hub returned invalid JSON: ${errorMessage(error)}`));
            return;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error(`Hub request timed out after ${timeoutMs}ms`));
    });
    request.end();
  });
}

async function checkHub(
  resolved: ResolvedConnection,
  timeoutMs: number,
): Promise<DoctorCheck[]> {
  if (!resolved.hub_url) {
    return [
      check(
        "hub.health",
        "fail",
        "Hub URL is unset",
        "Set --hub-url or configure connection.json",
      ),
    ];
  }

  const results: DoctorCheck[] = [];
  try {
    const health = await requestJson(
      resolved.hub_url,
      "/healthz",
      resolved,
      timeoutMs,
    );
    if (health.status !== 200 || health.json.status !== "ok") {
      if (health.status === 401 || health.status === 403) {
        results.push(
          check(
            "hub.health",
            "fail",
            `Hub health authorization failed (HTTP ${health.status})`,
            "Verify the token before interpreting remote Hub health",
          ),
        );
        results.push(
          check(
            "hub.auth",
            "fail",
            `Hub bearer authentication failed (HTTP ${health.status})`,
            "Verify token identity and re-mint/redeploy the token if needed",
          ),
        );
        return results;
      }
      results.push(
        check(
          "hub.health",
          "fail",
          `Hub health failed (HTTP ${health.status})`,
          "Check Hub process, URL, TLS and network reachability",
        ),
      );
      return results;
    }
    results.push(
      check(
        "hub.health",
        "pass",
        `Hub health ok (tls=${String(health.json.tls ?? "unknown")}, auth_required=${String(health.json.auth_required ?? "unknown")})`,
      ),
    );
  } catch (error) {
    return [
      check(
        "hub.health",
        "fail",
        `Hub health probe failed: ${errorMessage(error)}`,
        "Check Hub process, URL, CA certificate and network reachability",
      ),
    ];
  }

  if (!resolved.hub_token) {
    results.push(
      check(
        "hub.auth",
        "warn",
        "Hub authentication not probed because no token is resolved",
        "Configure a token_file to verify the authenticated data plane",
      ),
    );
    return results;
  }

  try {
    const auth = await requestJson(
      resolved.hub_url,
      "/v1/mail/me",
      resolved,
      timeoutMs,
    );
    if (auth.status !== 200 || typeof auth.json.agent_id !== "string") {
      results.push(
        check(
          "hub.auth",
          "fail",
          `Hub bearer authentication failed (HTTP ${auth.status})`,
          "Verify token identity and re-mint/redeploy the token if needed",
        ),
      );
    } else {
      results.push(
        check(
          "hub.auth",
          "pass",
          `Hub bearer authentication ok (agent_id=${auth.json.agent_id})`,
        ),
      );
    }
  } catch (error) {
    results.push(
      check(
        "hub.auth",
        "fail",
        `Hub authentication probe failed: ${errorMessage(error)}`,
        "Check token, CA certificate and Hub Mail API",
      ),
    );
  }
  return results;
}

export async function runDoctor(
  home: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const resolvedHome = path.resolve(home);
  const wake = options.wake ?? false;
  const deep = (options.deep ?? false) || wake || options.runners !== undefined;
  const checks = checkLocalFiles(resolvedHome);

  if (deep && checks.some((item) => item.id === "home" && item.status === "fail")) {
    return { ok: false, home: resolvedHome, deep, wake, checks };
  }

  if (deep) {
    checks.push(checkTokenStore(resolvedHome));
    const connection = checkConnection(resolvedHome);
    checks.push(...connection.checks);
    for (const runner of options.runners ?? RUNNERS) {
      checks.push(checkRunnerBinary(runner, options.pathEnv));
    }

    if (wake) {
      let resolved = connection.resolved;
      try {
        if (options.hubUrl) {
          resolved = resolveClientConnection(resolvedHome, {
            hub_url: options.hubUrl,
          });
        }
      } catch (error) {
        checks.push(
          check(
            "hub.health",
            "fail",
            errorMessage(error),
            "Check --hub-url and connection settings",
          ),
        );
        resolved = null;
      }
      if (resolved) {
        checks.push(...(await checkHub(resolved, options.timeoutMs ?? 3_000)));
      }
    }
  }

  return {
    ok: !checks.some((item) => item.status === "fail"),
    home: resolvedHome,
    deep,
    wake,
    checks,
  };
}

export function formatDoctorChecks(checks: DoctorCheck[]): string[] {
  return checks.flatMap((item) => {
    const prefix = {
      pass: "ok",
      warn: "warning",
      fail: "FAIL",
      skip: "skip",
    }[item.status];
    const lines = [`${prefix} [${item.id}] ${item.message}`];
    if (item.hint && item.status !== "pass") {
      lines.push(`  hint: ${item.hint}`);
    }
    return lines;
  });
}
