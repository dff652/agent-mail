/**
 * Hub bind policy: non-loopback requires auth tokens + TLS terminate
 * See the repository security model for the non-loopback boundary.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { loadTokenRecords } from "./auth.js";

export class HubBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubBindError";
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  // Node: net.isIP + simple loopback check
  if (net.isIPv4(h)) {
    return h === "127.0.0.1" || h.startsWith("127.");
  }
  if (net.isIPv6(h)) {
    return h === "::1" || h === "0:0:0:0:0:0:0:1";
  }
  return false;
}

export function authConfigured(home: string): boolean {
  try {
    return loadTokenRecords(home).length > 0;
  } catch {
    return false;
  }
}

export function envAllowCleartextHub(): boolean {
  const v = (process.env.AGENT_MAIL_HUB_ALLOW_CLEARTEXT ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export interface BindValidationInput {
  host: string;
  home: string;
  requireAuth: boolean;
  tlsCertFile?: string | null;
  tlsKeyFile?: string | null;
  /**
   * Lab only: allow non-loopback HTTP when TLS is terminated elsewhere.
   * Prefer binding Hub on loopback + reverse proxy instead.
   * Also enabled by AGENT_MAIL_HUB_ALLOW_CLEARTEXT=1.
   */
  allowCleartext?: boolean;
}

/**
 * Validate Hub listen policy before creating the server.
 * Loopback: always OK (auth optional).
 * Non-loopback: tokens required; TLS cert+key required unless allowCleartext.
 */
export function validateHubBind(input: BindValidationInput): {
  loopback: boolean;
  requireAuth: boolean;
  tls: boolean;
} {
  const host = input.host.trim() || "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const requireAuth = input.requireAuth || !loopback;
  const cert = input.tlsCertFile?.trim() || "";
  const key = input.tlsKeyFile?.trim() || "";
  const hasTls = Boolean(cert && key);
  const allowClear =
    Boolean(input.allowCleartext) || envAllowCleartextHub();

  if (loopback) {
    if ((cert && !key) || (!cert && key)) {
      throw new HubBindError("TLS requires both --tls-cert and --tls-key");
    }
    if (hasTls) {
      assertTlsFiles(cert, key);
    }
    return { loopback: true, requireAuth, tls: hasTls };
  }

  // --- non-loopback ---
  if (!requireAuth) {
    throw new HubBindError(
      "non-loopback Hub bind requires requireAuth / tokens (agent-mail hub-token mint)",
    );
  }
  if (!authConfigured(input.home)) {
    throw new HubBindError(
      "non-loopback Hub bind requires at least one minted hub token " +
        "(agent-mail hub-token mint --as <agent-id>)",
    );
  }
  if (!hasTls) {
    if (!allowClear) {
      throw new HubBindError(
        "non-loopback Hub bind requires TLS: pass --tls-cert and --tls-key " +
          "(or set AGENT_MAIL_HUB_ALLOW_CLEARTEXT=1 only for lab behind another TLS terminator)",
      );
    }
  } else {
    assertTlsFiles(cert, key);
  }
  if ((cert && !key) || (!cert && key)) {
    throw new HubBindError("TLS requires both --tls-cert and --tls-key");
  }

  return { loopback: false, requireAuth: true, tls: hasTls };
}

function assertTlsFiles(cert: string, key: string): void {
  const c = path.resolve(cert);
  const k = path.resolve(key);
  if (!fs.existsSync(c) || !fs.statSync(c).isFile()) {
    throw new HubBindError(`TLS cert file not found: ${c}`);
  }
  if (!fs.existsSync(k) || !fs.statSync(k).isFile()) {
    throw new HubBindError(`TLS key file not found: ${k}`);
  }
}
