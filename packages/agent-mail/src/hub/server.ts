/**
 * Local Hub HTTP(S) server — Mail Data API + health (R3 / P1 TLS terminate).
 * Loopback default; non-loopback requires minted tokens + TLS cert/key
 * (Python M6.3 parity). Lab-only cleartext: AGENT_MAIL_HUB_ALLOW_CLEARTEXT=1.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { URL } from "node:url";
import tls from "node:tls";

import {
  authenticatePeer,
  FederationError,
  getPeer,
  validateDomain,
} from "../federation/peers.js";
import {
  ackOutbound,
  listPendingForPeer,
} from "../federation/outbox.js";
import { importEnvelope } from "../federation/envelope.js";
import * as svc from "../services.js";
import { AgentMailError } from "../errors.js";
import { appendRuntimeLog } from "../observability.js";
import { createEnrollmentListener } from "./enrollment-api.js";
import { enrollmentJournalPath, sweepEnrollments } from "../enrollment.js";
import { PairingError, redeemPairing } from "../pairing.js";
import { loadPolicy } from "../policy.js";
import {
  authenticateBearer,
  ReplayGuard,
  verifyWebhook,
  WebhookAuthError,
  WebhookValidationError,
} from "./auth.js";
import {
  isLoopbackHost,
  validateHubBind,
  type BindValidationInput,
} from "./bind-policy.js";
import { RateLimiter } from "./rate-limit.js";
import {
  encodeSseEvent,
  MAX_SSE_RESPONSE_BYTES,
  writeSseChunk,
} from "./sse.js";

/** Per-process redeem limiters: 10/min/IP plus a global limiter. */
const pairRedeemIpLimiter = new RateLimiter(10, 60_000);
const pairRedeemGlobalLimiter = new RateLimiter(60, 60_000);
import {
  MailApiError,
  apiAck,
  apiAgents,
  apiClaim,
  apiDecideApproval,
  apiInbox,
  apiListApprovals,
  apiMe,
  apiSend,
  apiTaskOutcome,
  apiThread,
} from "./mail-api.js";

export type HubServer = http.Server | https.Server;

export interface HubOptions {
  /** Opt in to the guarded enrollment protocol; requires native HTTPS. */
  enableEnrollment?: boolean;
  home: string;
  host?: string;
  port?: number;
  /** When true, force bearer even on loopback. Non-loopback always requires auth. */
  requireAuth?: boolean;
  /** PEM certificate path for TLS terminate. */
  tlsCertFile?: string | null;
  /** PEM private key path for TLS terminate. */
  tlsKeyFile?: string | null;
  /**
   * Lab: allow non-loopback without TLS (prefer reverse-proxy on loopback instead).
   * Also: AGENT_MAIL_HUB_ALLOW_CLEARTEXT=1.
   */
  allowCleartext?: boolean;
  /** Application-level concurrent SSE long-poll cap. */
  maxSseConnections?: number;
  /** Disconnect a client that does not drain response backpressure. */
  sseDrainTimeoutMs?: number;
  /** Store poll cadence while one SSE request is waiting. */
  ssePollIntervalMs?: number;
  /** Server-wide accepted TCP socket budget (all HTTP/TLS/SSE traffic). */
  maxConnections?: number;
  /** Maximum time for a TLS client to complete its handshake. */
  tlsHandshakeTimeoutMs?: number;
  /** Maximum time to receive complete HTTP headers. */
  headersTimeoutMs?: number;
  /** Maximum time to receive the complete HTTP request. */
  requestTimeoutMs?: number;
  /** Destroy an otherwise idle socket after this interval. */
  socketIdleTimeoutMs?: number;
}

export { isLoopbackHost, validateHubBind, HubBindError, authConfigured } from "./bind-policy.js";

export const DEFAULT_HUB_MAX_CONNECTIONS = 128;
export const DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 35_000;

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(
  req: http.IncomingMessage,
  maxBytes = 256 * 1024,
): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req, maxBytes, true);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MailApiError("JSON object body required", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof MailApiError) throw e;
    throw new MailApiError("invalid JSON body", 400);
  }
}

async function readRawBody(
  req: http.IncomingMessage,
  maxBytes: number,
  allowEmpty: boolean,
): Promise<Buffer> {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (
      !Number.isInteger(declared) ||
      declared < 0 ||
      declared > maxBytes
    ) {
      throw new MailApiError("body too large", 413);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new MailApiError("body too large", 413);
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);
  if (!allowEmpty && body.length === 0) {
    throw new MailApiError("request body is required", 400);
  }
  return body;
}

interface HubRuntime {
  enableEnrollment: boolean;
  replay: ReplayGuard;
  activeSseConnections: number;
  maxSseConnections: number;
  sseDrainTimeoutMs: number;
  ssePollIntervalMs: number;
}

function numericQuery(url: URL, name: string, fallback: number): number {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new MailApiError(`query parameter ${name} must appear once`, 400);
  }
  const value =
    values.length === 0 || values[0] === "" ? fallback : Number(values[0]);
  if (!Number.isFinite(value)) {
    throw new MailApiError(`${name} must be a number`, 400);
  }
  return value;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildRequestListener(
  home: string,
  bind: { tls: boolean; requireAuth: boolean },
  runtime: HubRuntime,
): http.RequestListener {
  const enrollment = createEnrollmentListener(home, runtime.enableEnrollment);
  return async (req, res) => {
    try {
      const scheme = bind.tls ? "https" : "http";
      const url = new URL(
        req.url || "/",
        `${scheme}://${req.headers.host || "localhost"}`,
      );
      const method = (req.method || "GET").toUpperCase();
      const p = url.pathname;
      if (await enrollment(req, res, p)) return;

      if (method === "GET" && (p === "/healthz" || p === "/health")) {
        if (bind.requireAuth) {
          try {
            authenticateBearer(home, req.headers.authorization);
          } catch (e) {
            throw new MailApiError(
              e instanceof Error ? e.message : "unauthorized",
              401,
            );
          }
        }
        const encrypted =
          Boolean((req.socket as tls.TLSSocket).encrypted) || bind.tls;
        const database = svc.getStore(home).diagnostics();
        const status =
          database.integrity.length === 1 && database.integrity[0] === "ok"
            ? "ok"
            : "degraded";
        sendJson(res, status === "ok" ? 200 : 503, {
          status,
          database,
          auth_required: bind.requireAuth,
          tls: encrypted,
        });
        return;
      }

      if (method === "POST" && p === "/v1/webhook") {
        const started = performance.now();
        let recipient = "";
        try {
          const raw = await readRawBody(req, 16 * 1024, false);
          verifyWebhook(home, {
            body: raw,
            timestamp: req.headers["x-agent-mail-timestamp"] as
              | string
              | undefined,
            nonce: req.headers["x-agent-mail-nonce"] as string | undefined,
            signature: req.headers["x-agent-mail-signature"] as
              | string
              | undefined,
            replay: runtime.replay,
          });
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString("utf8")) as unknown;
          } catch {
            throw new MailApiError("invalid JSON body", 400);
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new MailApiError("webhook body must be a JSON object", 400);
          }
          const value = (parsed as Record<string, unknown>).recipient;
          if (typeof value !== "string" || !value) {
            throw new MailApiError("recipient is required", 400);
          }
          recipient = value;
          if (!svc.listAgents({ home }).includes(recipient)) {
            throw new MailApiError(`agent not in roster: ${recipient}`, 400);
          }
          const backfilled = svc.backfillOutbox(recipient, { home });
          const events = svc.listOutboxEvents(recipient, { home, limit: 1000 });
          const maxSequence = events.at(-1)?.sequence ?? 0;
          const openInbox = svc.inbox(recipient, { home }).length;
          appendRuntimeLog(home, "hub.webhook", "success", {
            actor: recipient,
            context: {
              backfilled,
              open_inbox: openInbox,
              hint_only: true,
              duration_ms:
                Math.round((performance.now() - started) * 1000) / 1000,
            },
          });
          sendJson(res, 200, {
            status: "accepted",
            recipient,
            backfilled_events: backfilled,
            open_inbox: openInbox,
            max_outbox_hint: maxSequence,
            note: "webhook is a doorbell; agents must re-read inbox via MCP/CLI",
          });
          return;
        } catch (error) {
          appendRuntimeLog(home, "hub.webhook", "error", {
            actor: recipient || null,
            context: {
              duration_ms:
                Math.round((performance.now() - started) * 1000) / 1000,
            },
            error,
          });
          if (error instanceof WebhookAuthError) {
            throw new MailApiError(error.message, 401);
          }
          if (error instanceof WebhookValidationError) {
            throw new MailApiError(error.message, 400);
          }
          throw error;
        }
      }

      // Mail API always requires bearer
      const requireMailAgent = (): string => {
        try {
          return authenticateBearer(home, req.headers.authorization);
        } catch (e) {
          throw new MailApiError(
            e instanceof Error ? e.message : "unauthorized",
            401,
          );
        }
      };

      if (method === "GET" && p === "/v1/mail/me") {
        const agent = requireMailAgent();
        sendJson(res, 200, apiMe(agent));
        return;
      }
      if (method === "GET" && p === "/v1/mail/agents") {
        const agent = requireMailAgent();
        void agent;
        sendJson(res, 200, apiAgents(home));
        return;
      }
      if (method === "GET" && p === "/v1/mail/inbox") {
        const agent = requireMailAgent();
        // security: reject query identity override
        for (const key of ["as", "agent_id", "from", "recipient"]) {
          if (url.searchParams.has(key)) {
            throw new MailApiError(
              "identity comes from the bearer token",
              403,
            );
          }
        }
        const all = url.searchParams.get("all") === "1";
        sendJson(res, 200, apiInbox(home, agent, all));
        return;
      }
      if (method === "GET" && p === "/v1/mail/approvals") {
        const agent = requireMailAgent();
        const status = url.searchParams.get("status") ?? "pending";
        sendJson(res, 200, apiListApprovals(home, agent, status));
        return;
      }
      const threadMatch = p.match(/^\/v1\/mail\/threads\/([^/]+)$/);
      if (method === "GET" && threadMatch) {
        requireMailAgent();
        const limit = Number(url.searchParams.get("limit") || 50);
        sendJson(res, 200, apiThread(home, decodeURIComponent(threadMatch[1]), limit));
        return;
      }

      if (method === "POST" && p === "/v1/mail/messages") {
        const agent = requireMailAgent();
        const body = await readJson(req);
        const result = apiSend(home, agent, body);
        sendJson(res, result.duplicate === true ? 200 : 201, result);
        return;
      }
      const claimMatch = p.match(/^\/v1\/mail\/messages\/([^/]+)\/claim$/);
      if (method === "POST" && claimMatch) {
        const agent = requireMailAgent();
        sendJson(res, 200, apiClaim(home, agent, decodeURIComponent(claimMatch[1])));
        return;
      }
      const ackMatch = p.match(/^\/v1\/mail\/messages\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const agent = requireMailAgent();
        sendJson(res, 200, apiAck(home, agent, decodeURIComponent(ackMatch[1])));
        return;
      }
      const taskMatch = p.match(/^\/v1\/mail\/tasks\/([^/]+)\/(done|error|cancel)$/);
      if (method === "POST" && taskMatch) {
        const agent = requireMailAgent();
        const body = await readJson(req);
        sendJson(
          res,
          201,
          apiTaskOutcome(
            home,
            agent,
            decodeURIComponent(taskMatch[1]),
            taskMatch[2],
            body,
          ),
        );
        return;
      }
      const apprMatch = p.match(/^\/v1\/mail\/approvals\/([^/]+)\/(approve|reject)$/);
      if (method === "POST" && apprMatch) {
        const agent = requireMailAgent();
        const body = await readJson(req);
        const note = typeof body.note === "string" ? body.note : "";
        sendJson(
          res,
          200,
          apiDecideApproval(
            home,
            agent,
            decodeURIComponent(apprMatch[1]),
            apprMatch[2] === "approve",
            note,
          ),
        );
        return;
      }

      // --- L2 pairing redeem (public, rate-limited; no bearer) ---
      if (method === "POST" && p === "/v1/pair/redeem") {
        const clientIp =
          (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
        try {
          pairRedeemIpLimiter.check(clientIp);
          pairRedeemGlobalLimiter.check("global");
        } catch {
          throw new MailApiError("rate limit exceeded", 429);
        }
        const body = await readJson(req);
        const code = body.code;
        if (typeof code !== "string" || !code.trim()) {
          throw new MailApiError("code is required", 400);
        }
        try {
          const result = redeemPairing(home, code);
          sendJson(res, 200, {
            agent_id: result.agent_id,
            token: result.token,
            pair_id: result.pair_id,
          });
        } catch (e) {
          if (e instanceof PairingError) {
            throw new MailApiError(e.message, 400);
          }
          throw e;
        }
        return;
      }

      // --- Wake outbox (body-free doorbell for bridges) ---
      if (method === "GET" && p === "/v1/events") {
        const recipient = url.searchParams.get("recipient") || "";
        if (!recipient) throw new MailApiError("recipient is required", 400);
        const agent = requireMailAgent();
        if (agent !== recipient) {
          throw new MailApiError("token agent must match recipient", 403);
        }
        const consumer = url.searchParams.get("consumer") || undefined;
        const after = numericQuery(
          url,
          "after",
          Number(req.headers["last-event-id"] || "0"),
        );
        const limit = numericQuery(url, "limit", 100);
        const accept = String(req.headers.accept || "");
        const wantsSse = accept.includes("text/event-stream");
        const wait = numericQuery(url, "wait", wantsSse ? 15 : 0);
        if (!Number.isInteger(after) || after < 0) {
          throw new MailApiError("after must be a non-negative integer", 400);
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new MailApiError("limit must be between 1 and 1000", 400);
        }
        if (wait < 0 || wait > 30) {
          throw new MailApiError("wait must be between 0 and 30 seconds", 400);
        }
        if (!wantsSse && wait > 0) {
          throw new MailApiError(
            "wait requires Accept: text/event-stream",
            400,
          );
        }
        try {
          const events = svc.listOutboxEvents(recipient, {
            home,
            afterSequence: after,
            limit,
            consumerId: consumer,
          });
          if (!wantsSse) {
            sendJson(res, 200, { recipient, count: events.length, events });
            return;
          }
          if (
            runtime.activeSseConnections >= runtime.maxSseConnections
          ) {
            throw new MailApiError("SSE connection limit reached", 503);
          }
          runtime.activeSseConnections += 1;
          let closed = false;
          let delivered = 0;
          let responseBytes = 0;
          let currentSequence = after;
          let pending = events;
          let idleDeadline = Date.now() + wait * 1000;
          let nextKeepalive = Date.now() + 1000;
          const onRequestAborted = (): void => {
            closed = true;
          };
          const onResponseClose = (): void => {
            if (!res.writableEnded) closed = true;
          };
          req.once("aborted", onRequestAborted);
          res.once("close", onResponseClose);
          try {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "close",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            });
            res.flushHeaders();
            while (!closed) {
              if (pending.length > 0) {
                for (const event of pending) {
                  const frame = encodeSseEvent(event);
                  responseBytes += Buffer.byteLength(frame);
                  if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
                    throw new Error("SSE response exceeded size limit");
                  }
                  if (
                    !(await writeSseChunk(
                      res,
                      frame,
                      runtime.sseDrainTimeoutMs,
                    ))
                  ) {
                    closed = true;
                    break;
                  }
                  currentSequence = event.sequence;
                  delivered += 1;
                }
                if (wait === 0 || closed) break;
                idleDeadline = Date.now() + wait * 1000;
              } else if (wait === 0 || Date.now() >= idleDeadline) {
                break;
              } else {
                if (Date.now() >= nextKeepalive) {
                  const keepalive = ": keepalive\n\n";
                  responseBytes += Buffer.byteLength(keepalive);
                  if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
                    throw new Error("SSE response exceeded size limit");
                  }
                  if (
                    !(await writeSseChunk(
                      res,
                      keepalive,
                      runtime.sseDrainTimeoutMs,
                    ))
                  ) {
                    closed = true;
                    break;
                  }
                  nextKeepalive = Date.now() + 1000;
                }
                await pause(
                  Math.min(
                    runtime.ssePollIntervalMs,
                    Math.max(1, idleDeadline - Date.now()),
                  ),
                );
              }
              if (closed) break;
              pending = svc.listOutboxEvents(recipient, {
                home,
                afterSequence: currentSequence,
                limit,
                consumerId: consumer,
              });
            }
            if (!res.destroyed && !res.writableEnded) res.end();
            appendRuntimeLog(home, "hub.events", "success", {
              actor: recipient,
              context: {
                consumer_id: consumer ?? null,
                after_sequence: after,
                last_sequence: currentSequence,
                delivered,
                disconnected: closed,
              },
            });
          } catch (error) {
            appendRuntimeLog(home, "hub.events", "error", {
              actor: recipient,
              context: {
                consumer_id: consumer ?? null,
                after_sequence: currentSequence,
                delivered,
              },
              error,
            });
            res.destroy();
          } finally {
            req.removeListener("aborted", onRequestAborted);
            res.removeListener("close", onResponseClose);
            runtime.activeSseConnections -= 1;
          }
        } catch (e) {
          if (e instanceof AgentMailError) {
            throw new MailApiError(e.message, e.exitCode === 4 ? 404 : 400);
          }
          throw e;
        }
        return;
      }
      if (method === "POST" && p === "/v1/outbox/ack") {
        const body = await readJson(req);
        const consumerId = String(body.consumer_id || "");
        const recipient = String(body.recipient || "");
        const sequence = Number(body.sequence);
        if (!consumerId || !recipient || !Number.isFinite(sequence)) {
          throw new MailApiError(
            "consumer_id, recipient, and sequence are required",
            400,
          );
        }
        const agent = requireMailAgent();
        if (agent !== recipient) {
          throw new MailApiError("token agent must match recipient", 403);
        }
        try {
          const cursor = svc.ackOutbox(consumerId, recipient, sequence, { home });
          sendJson(res, 200, {
            consumer_id: consumerId,
            recipient,
            last_sequence: cursor,
          });
        } catch (e) {
          if (e instanceof AgentMailError) {
            throw new MailApiError(e.message, 400);
          }
          throw e;
        }
        return;
      }

      // --- Federation Hub↔Hub (peer bearer, not user hub-token) ---
      const requirePeer = (): string => {
        try {
          return authenticatePeer(home, req.headers.authorization);
        } catch (e) {
          throw new MailApiError(
            e instanceof Error ? e.message : "peer unauthorized",
            401,
          );
        }
      };

      if (method === "GET" && p === "/v1/federation/pull") {
        const peerDomain = requirePeer();
        const peer = getPeer(home, peerDomain);
        if (!peer?.pull_enabled) {
          throw new MailApiError("peer pull disabled", 403);
        }
        // The domain query is caller-controlled and MUST match the authenticated peer.
        const requested = validateDomain(
          url.searchParams.get("domain") || peerDomain,
        );
        if (requested !== peerDomain) {
          throw new MailApiError("domain does not match peer token", 403);
        }
        const afterRaw = url.searchParams.get("after") ?? "";
        const after = afterRaw === "" ? 0 : Number(afterRaw);
        const limit = Number(url.searchParams.get("limit") ?? "100");
        if (!Number.isInteger(after) || after < 0) {
          throw new MailApiError("after must be a non-negative integer", 400);
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new MailApiError("limit must be 1..1000", 400);
        }
        // Peer pulls envelopes destined to their domain from our outbox.
        const items = listPendingForPeer(home, peerDomain, limit, after);
        const nextSeq = items.length ? items[items.length - 1].seq : after;
        sendJson(res, 200, {
          envelopes: items.map((item) => item.envelope),
          next_cursor: nextSeq ? String(nextSeq) : afterRaw,
          peer: peerDomain,
        });
        return;
      }
      if (method === "POST" && p === "/v1/federation/ack") {
        const peerDomain = requirePeer();
        const body = await readJson(req);
        const receiver = body.receiver_domain;
        if (
          receiver != null &&
          validateDomain(String(receiver)) !== peerDomain
        ) {
          throw new MailApiError("receiver_domain does not match peer token", 403);
        }
        if (!Array.isArray(body.message_ids)) {
          throw new MailApiError("message_ids must be a list", 400);
        }
        const ids = body.message_ids.filter(
          (x): x is string => typeof x === "string",
        );
        const acked = ackOutbound(home, ids, peerDomain);
        sendJson(res, 200, { acked, peer: peerDomain });
        return;
      }
      if (method === "POST" && p === "/v1/federation/push") {
        const peerDomain = requirePeer();
        const body = await readJson(req);
        if (
          !body.envelope ||
          typeof body.envelope !== "object" ||
          Array.isArray(body.envelope)
        ) {
          throw new MailApiError("envelope must be a JSON object", 400);
        }
        const envelope = body.envelope as Record<string, unknown>;
        const result = importEnvelope(home, envelope, peerDomain);
        sendJson(res, result === "imported" ? 201 : 200, {
          status: result,
          peer: peerDomain,
        });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof MailApiError) {
        sendJson(res, e.status, { error: e.message });
        return;
      }
      if (e instanceof FederationError) {
        const code = e.exitCode;
        const status =
          e.message.includes("domain_mismatch")
            ? 409
            : code === 2
              ? 400
              : code === 3
                ? 503
                : code === 4
                  ? 404
                  : code === 5
                    ? 409
                    : 400;
        sendJson(res, status, { error: e.message });
        return;
      }
      sendJson(res, 500, {
        error: e instanceof Error ? e.message : "internal error",
      });
    }
  };
}

interface HubGovernance {
  maxConnections: number;
  tlsHandshakeTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  socketIdleTimeoutMs: number;
}

function validateHubGovernance(opts: HubOptions): HubGovernance {
  const governance = {
    maxConnections:
      opts.maxConnections ?? DEFAULT_HUB_MAX_CONNECTIONS,
    tlsHandshakeTimeoutMs:
      opts.tlsHandshakeTimeoutMs ?? DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS,
    headersTimeoutMs:
      opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    requestTimeoutMs:
      opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    socketIdleTimeoutMs:
      opts.socketIdleTimeoutMs ?? DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
  };
  if (
    !Number.isInteger(governance.maxConnections) ||
    governance.maxConnections < 1 ||
    governance.maxConnections > 10_000 ||
    !Number.isInteger(governance.tlsHandshakeTimeoutMs) ||
    governance.tlsHandshakeTimeoutMs < 100 ||
    governance.tlsHandshakeTimeoutMs > 120_000 ||
    !Number.isInteger(governance.headersTimeoutMs) ||
    governance.headersTimeoutMs < 100 ||
    governance.headersTimeoutMs > 120_000 ||
    !Number.isInteger(governance.requestTimeoutMs) ||
    governance.requestTimeoutMs < 100 ||
    governance.requestTimeoutMs > 600_000 ||
    governance.headersTimeoutMs > governance.requestTimeoutMs ||
    !Number.isInteger(governance.socketIdleTimeoutMs) ||
    governance.socketIdleTimeoutMs < 1_000 ||
    governance.socketIdleTimeoutMs > 600_000
  ) {
    throw new Error("invalid Hub connection governance options");
  }
  return governance;
}

function applyHubGovernance(
  server: HubServer,
  governance: HubGovernance,
): HubServer {
  server.maxConnections = governance.maxConnections;
  server.headersTimeout = governance.headersTimeoutMs;
  server.requestTimeout = governance.requestTimeoutMs;
  server.keepAliveTimeout = Math.min(5_000, governance.socketIdleTimeoutMs);
  server.maxRequestsPerSocket = 100;
  server.setTimeout(governance.socketIdleTimeoutMs, (socket) => {
    socket.destroy();
  });
  return server;
}

export function createHubServer(opts: HubOptions): HubServer {
  const home = opts.home;
  // A Hub must never start while silently ignoring an invalid/unsupported
  // security policy. CLI/MCP sends validate again at the operation boundary.
  loadPolicy(home);
  const host = opts.host ?? "127.0.0.1";
  const bindInput: BindValidationInput = {
    host,
    home,
    requireAuth: opts.requireAuth ?? !isLoopbackHost(host),
    tlsCertFile: opts.tlsCertFile,
    tlsKeyFile: opts.tlsKeyFile,
    allowCleartext: opts.allowCleartext,
  };
  const bind = validateHubBind(bindInput);
  const governance = validateHubGovernance(opts);
  if (opts.enableEnrollment && !bind.tls) {
    throw new Error("guarded enrollment requires native HTTPS");
  }
  const cleanupRequired = opts.enableEnrollment === true || fs.existsSync(enrollmentJournalPath(home));
  if (cleanupRequired) sweepEnrollments(home);
  const maxSseConnections = opts.maxSseConnections ?? 64;
  const sseDrainTimeoutMs = opts.sseDrainTimeoutMs ?? 5_000;
  const ssePollIntervalMs = opts.ssePollIntervalMs ?? 100;
  if (
    !Number.isInteger(maxSseConnections) ||
    maxSseConnections < 1 ||
    maxSseConnections > 10_000 ||
    !Number.isInteger(sseDrainTimeoutMs) ||
    sseDrainTimeoutMs < 1 ||
    sseDrainTimeoutMs > 60_000 ||
    !Number.isInteger(ssePollIntervalMs) ||
    ssePollIntervalMs < 10 ||
    ssePollIntervalMs > 1_000
  ) {
    throw new Error("invalid Hub SSE governance options");
  }
  const handler = buildRequestListener(home, bind, {
    enableEnrollment: opts.enableEnrollment === true,
    replay: new ReplayGuard(),
    activeSseConnections: 0,
    maxSseConnections,
    sseDrainTimeoutMs,
    ssePollIntervalMs,
  });

  function maintainEnrollmentCleanup(server: HubServer): HubServer {
    // Disabling new enrollment must not abandon previously issued pending tokens.
    if (cleanupRequired) {
      const cleanup = setInterval(() => {
        try { sweepEnrollments(home); }
        catch { appendRuntimeLog(home, "enrollment.cleanup", "error", { error: "cleanup_pending" }); }
      }, 60_000);
      cleanup.unref();
      server.once("close", () => clearInterval(cleanup));
    }
    return server;
  }

  if (bind.tls) {
    const cert = fs.readFileSync(path.resolve(opts.tlsCertFile!));
    const key = fs.readFileSync(path.resolve(opts.tlsKeyFile!));
    // TLS 1.2+ (Node default modern suites; no SSLv3)
    const server = applyHubGovernance(
      https.createServer(
        {
          cert,
          key,
          minVersion: "TLSv1.2",
          handshakeTimeout: governance.tlsHandshakeTimeoutMs,
        },
        handler,
      ),
      governance,
    );
    return maintainEnrollmentCleanup(server);
  }
  return maintainEnrollmentCleanup(applyHubGovernance(http.createServer(handler), governance));
}

export async function listenHub(
  opts: HubOptions,
): Promise<{ server: HubServer; url: string; tls: boolean }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7421;
  const server = createHubServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const isHttps = server instanceof https.Server;
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `${isHttps ? "https" : "http"}://${displayHost}:${addr.port}`;
  return { server, url, tls: isHttps };
}
