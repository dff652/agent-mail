/**
 * Small, single-attempt client for the guarded Hub enrollment protocol.
 *
 * This client deliberately has no bearer-token support and no mutation retry.
 * A lost response is an unknown outcome; the enrollment manager must reconcile
 * it with the same request/recovery proof or commit ID.
 */
import fs from "node:fs";
import { URL } from "node:url";

import {
  OutboundHttpError,
  outboundRequest,
  parseJsonObject,
} from "./outbound-http.js";

export const ENROLLMENT_TIMEOUT_MS = 10_000;
export const ENROLLMENT_MAX_RESPONSE_BYTES = 256 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/;

export type EnrollmentErrorCode =
  | "management_denied"
  | "target_not_allowed"
  | "tls_untrusted"
  | "hub_unreachable"
  | "code_invalid_or_expired"
  | "rate_limited"
  | "identity_conflict"
  | "identity_mismatch"
  | "context_expired"
  | "idempotency_conflict"
  | "config_conflict"
  | "save_failed"
  | "activation_failed"
  | "cleanup_pending"
  | "cleanup_conflict"
  | "directory_failed"
  | "test_timeout"
  | "protocol_error"
  | "hub_request_failed";

const SAFE_MESSAGES: Record<EnrollmentErrorCode, string> = {
  management_denied: "enrollment management is not authorized",
  target_not_allowed: "the selected Hub target is not allowed",
  tls_untrusted: "the Hub TLS certificate is not trusted",
  hub_unreachable: "the Hub could not be reached",
  code_invalid_or_expired: "the enrollment code is invalid or expired",
  rate_limited: "the Hub temporarily rate-limited enrollment",
  identity_conflict: "the selected identity is already enrolled",
  identity_mismatch: "the Hub identity did not match the enrollment",
  context_expired: "the enrollment context expired",
  idempotency_conflict: "the enrollment retry did not match its original request",
  config_conflict: "the connection configuration changed during enrollment",
  save_failed: "the new connection could not be saved",
  activation_failed: "the new connection could not be activated",
  cleanup_pending: "enrollment cleanup is still pending",
  cleanup_conflict: "enrollment cleanup could not safely remove its state",
  directory_failed: "the Hub directory could not be read",
  test_timeout: "the enrollment test timed out",
  protocol_error: "the Hub returned an invalid enrollment response",
  hub_request_failed: "the Hub rejected the enrollment request",
};

export class EnrollmentClientError extends Error {
  readonly code: EnrollmentErrorCode;
  readonly retryable: boolean;
  readonly unknown_outcome: boolean;
  readonly status: number | null;

  constructor(
    code: EnrollmentErrorCode,
    options: {
      retryable?: boolean;
      unknownOutcome?: boolean;
      status?: number | null;
    } = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "EnrollmentClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.unknown_outcome = options.unknownOutcome ?? false;
    this.status = options.status ?? null;
  }
}

export interface EnrollmentVerifyResult {
  tls_verified: boolean;
  status: number;
}

export interface EnrollmentIdentityResult {
  agent_id: string;
}

export interface EnrollmentRedeemRequest {
  request_id: string;
  code: string;
  recovery_proof: string;
}

export interface EnrollmentRecoverRequest {
  request_id: string;
  recovery_proof: string;
}

export interface EnrollmentStatusRequest {
  enrollment_id: string;
  recovery_proof: string;
}

export interface EnrollmentCommitRequest {
  enrollment_id: string;
  recovery_proof: string;
  commit_id: string;
}

export interface EnrollmentCancelRequest {
  enrollment_id: string;
  recovery_proof: string;
}

export interface EnrollmentHubValue {
  [key: string]: unknown;
}

export interface EnrollmentTransport {
  verify?(): Promise<EnrollmentVerifyResult>;
  /** Verify the bearer returned by redeem against the Hub's authenticated /me. */
  verifyIdentity?(input: {
    token: string;
    expected_agent_id: string;
  }): Promise<EnrollmentIdentityResult>;
  redeem(input: EnrollmentRedeemRequest): Promise<EnrollmentHubValue>;
  recover(input: EnrollmentRecoverRequest): Promise<EnrollmentHubValue>;
  status(input: EnrollmentStatusRequest): Promise<EnrollmentHubValue>;
  commit(input: EnrollmentCommitRequest): Promise<EnrollmentHubValue>;
  cancel(input: EnrollmentCancelRequest): Promise<EnrollmentHubValue>;
}

export interface EnrollmentClientOptions {
  baseUrl: string;
  /** Protected server-side CA path; never accept this from browser input. */
  caFile?: string | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface NormalizedEnrollmentEndpoint {
  url: string;
  protocol: "https:" | "http:";
  hostname: string;
  port: string;
}

function safeCa(caFile: string | null | undefined): Buffer | null {
  if (!caFile) return null;
  const resolved = caFile;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new EnrollmentClientError("tls_untrusted");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new EnrollmentClientError("tls_untrusted");
  }
  try {
    return fs.readFileSync(resolved);
  } catch {
    throw new EnrollmentClientError("tls_untrusted");
  }
}

/** Validate the endpoint shape before any request or credential is sent. */
export function normalizeEnrollmentEndpoint(raw: string): NormalizedEnrollmentEndpoint {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new EnrollmentClientError("target_not_allowed");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new EnrollmentClientError("target_not_allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !hostname ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new EnrollmentClientError("target_not_allowed");
  }
  if (parsed.protocol !== "https:") {
    throw new EnrollmentClientError("target_not_allowed");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return {
    url: parsed.toString().replace(/\/$/, ""),
    protocol: parsed.protocol,
    hostname,
    port: parsed.port,
  };
}

function requireUuid(value: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new EnrollmentClientError("protocol_error");
  }
  return value;
}

function requireProof(value: string): string {
  if (typeof value !== "string" || !PROOF_RE.test(value)) {
    throw new EnrollmentClientError("protocol_error");
  }
  return value;
}

function requireCode(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 4 ||
    value.trim().length > 128 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new EnrollmentClientError("code_invalid_or_expired");
  }
  return value.trim();
}

function remoteCode(value: unknown, status: number): EnrollmentErrorCode {
  const code = typeof value === "string" ? value : "";
  const allowed = new Set<EnrollmentErrorCode>([
    "management_denied",
    "target_not_allowed",
    "tls_untrusted",
    "hub_unreachable",
    "code_invalid_or_expired",
    "rate_limited",
    "identity_conflict",
    "identity_mismatch",
    "context_expired",
    "idempotency_conflict",
    "config_conflict",
    "save_failed",
    "activation_failed",
    "cleanup_pending",
    "cleanup_conflict",
    "directory_failed",
    "test_timeout",
  ]);
  if (allowed.has(code as EnrollmentErrorCode)) {
    return code as EnrollmentErrorCode;
  }
  if (status === 401 || status === 403) return "management_denied";
  if (status === 409) return "config_conflict";
  if (status === 429) return "rate_limited";
  return "hub_request_failed";
}

function hasRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function requireObject(value: unknown): EnrollmentHubValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EnrollmentClientError("protocol_error");
  }
  return value as EnrollmentHubValue;
}

export class EnrollmentHubClient implements EnrollmentTransport {
  readonly baseUrl: string;
  private readonly ca: Buffer | null;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: EnrollmentClientOptions) {
    const normalized = normalizeEnrollmentEndpoint(options.baseUrl);
    this.baseUrl = normalized.url;
    this.ca = safeCa(options.caFile);
    this.timeoutMs = options.timeoutMs ?? ENROLLMENT_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? ENROLLMENT_MAX_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > ENROLLMENT_TIMEOUT_MS ||
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > ENROLLMENT_MAX_RESPONSE_BYTES
    ) {
      throw new EnrollmentClientError("protocol_error");
    }
  }

  private async request(
    method: "GET" | "POST",
    route: string,
    body: Record<string, unknown> | undefined,
    mutation: boolean,
  ): Promise<Record<string, unknown>> {
    let target: URL;
    try {
      target = new URL(`${this.baseUrl}${route}`);
    } catch {
      throw new EnrollmentClientError("target_not_allowed");
    }
    let response;
    try {
      response = await outboundRequest(target, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        ca: this.ca,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof EnrollmentClientError) throw error;
      if (error instanceof OutboundHttpError) {
        throw new EnrollmentClientError("hub_unreachable", {
          retryable: true,
          unknownOutcome: mutation,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/certificate|tls|self.signed|unable to verify|hostname/i.test(message)) {
        throw new EnrollmentClientError("tls_untrusted");
      }
      throw new EnrollmentClientError("hub_unreachable", {
        retryable: true,
        unknownOutcome: mutation,
      });
    }
    if (hasRedirect(response.status)) {
      throw new EnrollmentClientError("target_not_allowed", {
        unknownOutcome: mutation,
        status: response.status,
      });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonObject(response.body);
    } catch {
      throw new EnrollmentClientError("protocol_error", {
        unknownOutcome: mutation,
        status: response.status,
      });
    }
    if (!response.ok) {
      const candidate = parsed.error;
      const errorObject =
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>)
          : {};
      const code = remoteCode(errorObject.code, response.status);
      throw new EnrollmentClientError(code, {
        retryable: code === "rate_limited" || code === "hub_unreachable",
        unknownOutcome: mutation && response.status >= 500,
        status: response.status,
      });
    }
    if (parsed.ok !== true) {
      throw new EnrollmentClientError("protocol_error", {
        unknownOutcome: mutation,
        status: response.status,
      });
    }
    try {
      return requireObject(parsed.value);
    } catch (error) {
      if (error instanceof EnrollmentClientError) {
        throw new EnrollmentClientError(error.code, {
          unknownOutcome: mutation,
          status: response.status,
        });
      }
      throw error;
    }
  }

  async verify(): Promise<EnrollmentVerifyResult> {
    // A 401/404 still proves the TLS endpoint answered. Authentication and
    // route authorization belong to the guarded enrollment operation.
    let target: URL;
    try {
      target = new URL(`${this.baseUrl}/healthz`);
    } catch {
      throw new EnrollmentClientError("target_not_allowed");
    }
    let response;
    try {
      response = await outboundRequest(target, {
        method: "GET",
        headers: { Accept: "application/json" },
        ca: this.ca,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxResponseBytes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/certificate|tls|self.signed|unable to verify|hostname/i.test(message)) {
        throw new EnrollmentClientError("tls_untrusted");
      }
      throw new EnrollmentClientError("hub_unreachable", { retryable: true });
    }
    if (hasRedirect(response.status)) {
      throw new EnrollmentClientError("target_not_allowed", {
        status: response.status,
      });
    }
    return { tls_verified: true, status: response.status };
  }

  async verifyIdentity(input: {
    token: string;
    expected_agent_id: string;
  }): Promise<EnrollmentIdentityResult> {
    if (
      typeof input.token !== "string" ||
      !input.token ||
      input.token.length > 4096 ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(input.token)
    ) {
      throw new EnrollmentClientError("identity_mismatch");
    }
    let target: URL;
    try {
      target = new URL(`${this.baseUrl}/v1/mail/me`);
    } catch {
      throw new EnrollmentClientError("target_not_allowed");
    }
    let response;
    try {
      response = await outboundRequest(target, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.token}`,
        },
        ca: this.ca,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxResponseBytes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/certificate|tls|self.signed|unable to verify|hostname/i.test(message)) {
        throw new EnrollmentClientError("tls_untrusted");
      }
      throw new EnrollmentClientError("hub_unreachable", { retryable: true });
    }
    if (hasRedirect(response.status)) {
      throw new EnrollmentClientError("target_not_allowed", { status: response.status });
    }
    if (!response.ok) {
      throw new EnrollmentClientError(
        response.status === 401 || response.status === 403
          ? "identity_mismatch"
          : "hub_request_failed",
        { status: response.status },
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonObject(response.body);
    } catch {
      throw new EnrollmentClientError("protocol_error");
    }
    const agentId = typeof parsed.agent_id === "string" ? parsed.agent_id : "";
    if (!agentId || agentId !== input.expected_agent_id) {
      throw new EnrollmentClientError("identity_mismatch");
    }
    return { agent_id: agentId };
  }

  redeem(input: EnrollmentRedeemRequest): Promise<EnrollmentHubValue> {
    return this.request(
      "POST",
      "/v1/enrollments/redeem",
      {
        request_id: requireUuid(input.request_id),
        code: requireCode(input.code),
        recovery_proof: requireProof(input.recovery_proof),
      },
      true,
    );
  }

  recover(input: EnrollmentRecoverRequest): Promise<EnrollmentHubValue> {
    return this.request(
      "POST",
      "/v1/enrollments/recover",
      {
        request_id: requireUuid(input.request_id),
        recovery_proof: requireProof(input.recovery_proof),
      },
      true,
    );
  }

  status(input: EnrollmentStatusRequest): Promise<EnrollmentHubValue> {
    return this.request(
      "POST",
      "/v1/enrollments/status",
      {
        enrollment_id: input.enrollment_id,
        recovery_proof: requireProof(input.recovery_proof),
      },
      false,
    );
  }

  commit(input: EnrollmentCommitRequest): Promise<EnrollmentHubValue> {
    return this.request(
      "POST",
      "/v1/enrollments/commit",
      {
        enrollment_id: input.enrollment_id,
        recovery_proof: requireProof(input.recovery_proof),
        commit_id: requireUuid(input.commit_id),
      },
      true,
    );
  }

  cancel(input: EnrollmentCancelRequest): Promise<EnrollmentHubValue> {
    return this.request(
      "POST",
      "/v1/enrollments/cancel",
      {
        enrollment_id: input.enrollment_id,
        recovery_proof: requireProof(input.recovery_proof),
      },
      true,
    );
  }
}

export function isEnrollmentClientError(
  value: unknown,
): value is EnrollmentClientError {
  return value instanceof EnrollmentClientError;
}
