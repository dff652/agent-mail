/**
 * Small provider-owned session boundary for the connection-management mount.
 *
 * The session is deliberately kept in memory. The embedding host supplies a
 * protected password file, while the existing management listener remains the
 * only code that constructs a provider enrollment manager.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createConnectionManagementListener,
  type ConnectionManagementOptions,
  type ManagementAuthorization,
} from "./connection-management.js";
import { normalizeEnrollmentEndpoint } from "./enrollment-client.js";

type ManagedProfileOptions =
  ConnectionManagementOptions["profiles"] extends ReadonlyMap<string, infer Profile>
    ? Profile
    : never;

export interface AuthenticatedManagementProfile
  extends ManagedProfileOptions {
  label: string;
}

export interface AuthenticatedManagementOptions {
  origin: string;
  profiles: ReadonlyMap<string, AuthenticatedManagementProfile>;
  operator: {
    principal: string;
    passwordFile: string;
    allowedProfiles: readonly string[];
  };
  sessionTtlMs?: number;
  now?: () => number;
}

export interface AuthenticatedManagementListener {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  dispose(): void;
}

const SESSION_PREFIX = "/v1/management-session/";
const MANAGEMENT_PREFIX = "/v1/connection-management/";
const COOKIE_NAME = "agent_mail_session";
const CSRF_HEADER = "x-agent-mail-csrf";
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSION_TTL_MS = 30 * 60_000;
const MAX_BODY_BYTES = 4096;
const MAX_PASSWORD_FILE_BYTES = 4096;
const MAX_SESSIONS = 1024;
const MAX_RATE_ENTRIES = 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_FAILURE_LIMIT = 5;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD_RE = /^[A-Za-z0-9_-]{43,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type SessionRoute = "login" | "status" | "logout";

interface SessionRecord {
  csrfToken: string;
  expiresAt: number;
}

interface RateRecord {
  firstFailureAt: number;
  failures: number;
}

class ManagementSessionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ManagementSessionError";
  }
}

function configurationError(): Error {
  return new Error("invalid management session configuration");
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function parseOrigin(raw: string): URL {
  if (typeof raw !== "string" || !raw.trim()) throw configurationError();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw configurationError();
  }
  if (
    parsed.origin !== raw ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    throw configurationError();
  }
  if (
    parsed.protocol === "http:" &&
    !isLoopbackAddress(parsed.hostname.replace(/^\[|\]$/g, ""))
  ) {
    throw configurationError();
  }
  return parsed;
}

function requirePrincipal(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    CONTROL_RE.test(value)
  ) {
    throw configurationError();
  }
  return value.trim();
}

function requireProfileHandle(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value) ||
    value.includes("..")
  ) {
    throw configurationError();
  }
  return value;
}

function requireProfileLabel(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    CONTROL_RE.test(value)
  ) {
    throw configurationError();
  }
  return value.trim();
}

function requirePasswordFile(filename: string): string {
  if (typeof filename !== "string" || !filename.startsWith("/")) {
    throw configurationError();
  }
  return filename;
}

function readPasswordDigest(filename: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw new ManagementSessionError("management_unavailable", 503);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_PASSWORD_FILE_BYTES ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new ManagementSessionError("management_unavailable", 503);
  }
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filename);
  } catch {
    throw new ManagementSessionError("management_unavailable", 503);
  }
  const password = raw.toString("utf8").trim();
  if (
    !PASSWORD_RE.test(password) ||
    Buffer.from(password, "base64url").length < 32 ||
    Buffer.from(password, "base64url").toString("base64url") !== password
  ) {
    throw new ManagementSessionError("management_unavailable", 503);
  }
  return createHash("sha256").update(password, "utf8").digest();
}

function digestPassword(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function setResponseHeaders(res: ServerResponse): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function reply(
  res: ServerResponse,
  status: number,
  value: unknown,
  cookie?: string,
): void {
  if (res.headersSent) return;
  setResponseHeaders(res);
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.writeHead(status);
  res.end(JSON.stringify(value));
}

function errorResponse(error: ManagementSessionError): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: error.code,
      stage: "management_session",
      retryable: error.status >= 500,
    },
  };
}

async function readJsonBody(
  req: IncomingMessage,
  expectedFields: readonly string[],
): Promise<Record<string, unknown>> {
  const contentType = headerValue(req, "content-type");
  if (contentType?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new ManagementSessionError("json_required", 415);
  }
  const declaredLength = headerValue(req, "content-length");
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
      throw new ManagementSessionError("body_too_large", 413);
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY_BYTES) {
      throw new ManagementSessionError("body_too_large", 413);
    }
    chunks.push(data);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ManagementSessionError("invalid_request", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManagementSessionError("invalid_request", 400);
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).length !== expectedFields.length ||
    expectedFields.some(
      (field) =>
        !Object.hasOwn(value, field) ||
        typeof value[field] !== "string" ||
        (value[field] as string).length > 256,
    )
  ) {
    throw new ManagementSessionError("invalid_request", 400);
  }
  return value;
}

function cookieToken(req: IncomingMessage): string | null {
  const raw = headerValue(req, "cookie");
  if (raw === undefined || raw.trim() === "") return null;
  let found: string | null = null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      throw new ManagementSessionError("session_invalid", 401);
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== COOKIE_NAME) continue;
    if (found !== null || !SESSION_TOKEN_RE.test(value)) {
      throw new ManagementSessionError("session_invalid", 401);
    }
    found = value;
  }
  return found;
}

function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/v1/; HttpOnly; SameSite=Strict${
    secure ? "; Secure" : ""
  }`;
}

function expiredCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/v1/; HttpOnly; SameSite=Strict${
    secure ? "; Secure" : ""
  }`;
}

function isEncrypted(req: IncomingMessage): boolean {
  return (req.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted === true;
}

export function createAuthenticatedManagementListener(
  options: AuthenticatedManagementOptions,
): AuthenticatedManagementListener {
  const origin = parseOrigin(options.origin);
  const principal = requirePrincipal(options.operator.principal);
  const passwordFile = requirePasswordFile(options.operator.passwordFile);
  // Fail closed during setup instead of discovering an unusable credential
  // only after the management endpoint has been mounted.
  readPasswordDigest(passwordFile);
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  if (
    !Number.isInteger(sessionTtlMs) ||
    sessionTtlMs < 1 ||
    sessionTtlMs > MAX_SESSION_TTL_MS
  ) {
    throw configurationError();
  }
  if (
    !Array.isArray(options.operator.allowedProfiles) ||
    options.operator.allowedProfiles.length === 0
  ) {
    throw configurationError();
  }
  const profiles = new Map<string, AuthenticatedManagementProfile>();
  for (const [handle, profile] of options.profiles) {
    if (
      !Array.isArray(profile.allowedHubUrls) ||
      profile.allowedHubUrls.length === 0 ||
      profile.allowedHubUrls.some((endpoint) => typeof endpoint !== "string")
    ) {
      throw configurationError();
    }
    let endpoints: string[];
    try {
      endpoints = profile.allowedHubUrls.map(
        (endpoint) => normalizeEnrollmentEndpoint(endpoint).url,
      );
    } catch {
      throw configurationError();
    }
    profiles.set(handle, { ...profile, allowedHubUrls: endpoints });
  }
  const allowedProfiles = new Set<string>();
  for (const handle of options.operator.allowedProfiles) {
    if (!profiles.has(handle)) throw configurationError();
    allowedProfiles.add(requireProfileHandle(handle));
  }
  const publicProfiles = [...allowedProfiles].map((handle) => {
    const profile = profiles.get(handle);
    if (!profile) throw configurationError();
    const label = requireProfileLabel(profile.label);
    return {
      handle,
      label,
      endpoints: [...profile.allowedHubUrls],
    };
  });

  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionRecord>();
  const failures = new Map<string, RateRecord>();
  let disposed = false;

  function currentTime(): number {
    const value = now();
    if (!Number.isFinite(value)) throw configurationError();
    return value;
  }

  function prune(): void {
    const current = currentTime();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(token);
    }
    for (const [address, record] of failures) {
      if (record.firstFailureAt + RATE_WINDOW_MS <= current) failures.delete(address);
    }
  }

  function requestAddress(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  function enforceRequestSecurity(req: IncomingMessage): void {
    if (
      headerValue(req, "origin") !== origin.origin ||
      headerValue(req, "host") !== origin.host
    ) {
      throw new ManagementSessionError("management_denied", 403);
    }
    if (!isEncrypted(req) && !isLoopbackAddress(req.socket.remoteAddress)) {
      throw new ManagementSessionError("management_denied", 403);
    }
  }

  function sessionFor(req: IncomingMessage): { token: string; record: SessionRecord } {
    prune();
    const token = cookieToken(req);
    if (!token) throw new ManagementSessionError("session_invalid", 401);
    const record = sessions.get(token);
    if (!record || record.expiresAt <= currentTime()) {
      if (record) sessions.delete(token);
      throw new ManagementSessionError("session_invalid", 401);
    }
    return { token, record };
  }

  function csrfMatches(req: IncomingMessage, record: SessionRecord): boolean {
    const supplied = headerValue(req, CSRF_HEADER);
    if (!supplied || supplied.length > 256) return false;
    const suppliedBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(record.csrfToken, "utf8");
    return equalDigest(
      createHash("sha256").update(suppliedBytes).digest(),
      createHash("sha256").update(expectedBytes).digest(),
    ) && supplied === record.csrfToken;
  }

  function checkRateLimit(address: string): void {
    prune();
    const record = failures.get(address);
    if (record && record.failures >= RATE_FAILURE_LIMIT) {
      throw new ManagementSessionError("rate_limited", 429);
    }
  }

  function recordFailure(address: string): void {
    const current = currentTime();
    const previous = failures.get(address);
    if (!previous || previous.firstFailureAt + RATE_WINDOW_MS <= current) {
      failures.delete(address);
      if (failures.size >= MAX_RATE_ENTRIES) {
        const oldest = failures.keys().next().value;
        if (typeof oldest === "string") failures.delete(oldest);
      }
      failures.set(address, { firstFailureAt: current, failures: 1 });
      return;
    }
    previous.failures += 1;
  }

  function clearFailures(address: string): void {
    failures.delete(address);
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const existingToken = cookieToken(req);
    if (existingToken !== null) {
      const existing = sessions.get(existingToken);
      if (!existing || existing.expiresAt <= currentTime()) {
        if (existing) sessions.delete(existingToken);
      }
    }
    const body = await readJsonBody(req, ["password"]);
    const password = body.password;
    if (typeof password !== "string" || !password) {
      throw new ManagementSessionError("management_denied", 401);
    }
    const address = requestAddress(req);
    checkRateLimit(address);
    let expected: Buffer;
    try {
      expected = readPasswordDigest(passwordFile);
    } catch (error) {
      if (error instanceof ManagementSessionError) throw error;
      throw new ManagementSessionError("management_unavailable", 503);
    }
    if (!equalDigest(expected, digestPassword(password))) {
      recordFailure(address);
      throw new ManagementSessionError("management_denied", 401);
    }
    clearFailures(address);
    prune();
    if (sessions.size >= MAX_SESSIONS) {
      throw new ManagementSessionError("management_unavailable", 503);
    }
    // One configured management principal has one active login generation.
    // This also invalidates a cookie presented by a previously logged-in UI.
    sessions.clear();
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = currentTime() + sessionTtlMs;
    sessions.set(token, { csrfToken, expiresAt });
    reply(
      res,
      200,
      {
        ok: true,
        value: {
          authenticated: true,
          csrf_token: csrfToken,
          expires_at: new Date(expiresAt).toISOString(),
          profiles: publicProfiles,
        },
      },
      sessionCookie(token, origin.protocol === "https:"),
    );
  }

  async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = cookieToken(req);
    if (token === null) {
      reply(res, 200, { ok: true, value: { authenticated: false } });
      return;
    }
    const session = sessionFor(req);
    reply(res, 200, {
      ok: true,
      value: {
        authenticated: true,
        csrf_token: session.record.csrfToken,
        expires_at: new Date(session.record.expiresAt).toISOString(),
        profiles: publicProfiles,
      },
    });
  }

  async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = sessionFor(req);
    if (!csrfMatches(req, session.record)) {
      throw new ManagementSessionError("management_denied", 403);
    }
    sessions.delete(session.token);
    reply(
      res,
      200,
      { ok: true, value: { authenticated: false } },
      expiredCookie(origin.protocol === "https:"),
    );
  }

  async function handleSessionRoute(
    route: SessionRoute,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      throw new ManagementSessionError("method_not_allowed", 405);
    }
    if (route === "login") {
      await handleLogin(req, res);
      return;
    }
    const body = await readJsonBody(req, []);
    if (Object.keys(body).length !== 0) {
      throw new ManagementSessionError("invalid_request", 400);
    }
    if (route === "status") {
      await handleStatus(req, res);
      return;
    }
    await handleLogout(req, res);
  }

  const managementListener = createConnectionManagementListener({
    origin: options.origin,
    profiles,
    authorize: (req, target): ManagementAuthorization | null => {
      try {
        const session = sessionFor(req);
        return {
          principal,
          csrfValidated: csrfMatches(req, session.record),
          canManageTarget: allowedProfiles.has(target.profile_handle),
        };
      } catch {
        return null;
      }
    },
  });

  function sessionRoute(pathname: string): SessionRoute | null {
    if (!pathname.startsWith(SESSION_PREFIX)) return null;
    const route = pathname.slice(SESSION_PREFIX.length);
    if (route === "login" || route === "status" || route === "logout") return route;
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const requestPath = req.url ?? "";
    const sessionPath = requestPath.split("?", 1)[0]!;
    const route = sessionRoute(sessionPath);
    const isManagement = requestPath.startsWith(MANAGEMENT_PREFIX);
    if (!route && !isManagement) return false;
    try {
      if (disposed) throw new ManagementSessionError("management_unavailable", 503);
      enforceRequestSecurity(req);
      if (requestPath.includes("?")) {
        throw new ManagementSessionError("invalid_request", 400);
      }
      if (route) {
        await handleSessionRoute(route, req, res);
        return true;
      }
      // Authenticate before delegating so an invalid/duplicate cookie and a
      // missing CSRF header never reach the manager adapter.
      const session = sessionFor(req);
      if (!csrfMatches(req, session.record)) {
        throw new ManagementSessionError("management_denied", 403);
      }
      return await managementListener(req, res);
    } catch (error) {
      const safe =
        error instanceof ManagementSessionError
          ? error
          : new ManagementSessionError("management_unavailable", 503);
      reply(
        res,
        safe.status,
        errorResponse(safe),
        safe.code === "session_invalid"
          ? expiredCookie(origin.protocol === "https:")
          : undefined,
      );
      return true;
    }
  }

  return {
    handle,
    dispose(): void {
      disposed = true;
      sessions.clear();
      failures.clear();
    },
  };
}
