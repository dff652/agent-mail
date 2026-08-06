/**
 * Shared outbound HTTP(S) helper for peer and Hub calls.
 *
 * Why not global fetch: Node 20's fetch (undici) has no per-request CA option,
 * so every TLS federation / remote bridge call could only trust the system
 * store. `federation/peers.ts` requires https:// for non-loopback peers and the
 * supported topology uses a private CA, which made those paths unusable
 * (project-evaluation-2026-08-01 P0-2). node:https accepts a pinned `ca`.
 *
 * Never set `checkServerIdentity` on the secure path: passing it explicitly —
 * even as undefined — triggers ERR_INTERNAL_ASSERTION on Node 20 and took the
 * whole remote client down for 8 days (same evaluation, §2).
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;
export const DEFAULT_OUTBOUND_MAX_BYTES = 4 * 1024 * 1024;

export class OutboundHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundHttpError";
  }
}

export interface OutboundRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Cancels an in-flight request; an already-aborted signal fails immediately. */
  signal?: AbortSignal;
  /** PEM bundle pinned for this request; https only, null/undefined = system store. */
  ca?: Buffer | null;
  /**
   * Enforced twice: as socket inactivity and as an overall deadline. The
   * deadline matters because a peer that trickles bytes never goes idle, and
   * the callers previously had `AbortSignal.timeout`, which was absolute.
   */
  timeoutMs?: number;
  /** Hard cap on the response body; exceeding it aborts the stream. */
  maxBytes?: number;
}

export interface OutboundResponse {
  status: number;
  ok: boolean;
  contentType: string;
  body: Buffer;
}

/**
 * Single-attempt request with a pinned CA, an inactivity timeout and a hard
 * response cap. Retry/DLQ policy stays with the caller.
 */
export function outboundRequest(
  target: string | URL,
  options: OutboundRequestOptions = {},
): Promise<OutboundResponse> {
  const url = target instanceof URL ? target : new URL(target);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Promise.reject(
      new OutboundHttpError(`unsupported protocol: ${url.protocol}`),
    );
  }
  const isHttps = url.protocol === "https:";
  const timeoutMs = options.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_OUTBOUND_MAX_BYTES;
  const method = options.method ?? "GET";
  const payload = options.body;

  if (options.signal?.aborted) {
    return Promise.reject(new OutboundHttpError("request aborted"));
  }

  return new Promise<OutboundResponse>((resolve, reject) => {
    const lib = isHttps ? https : http;
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    const cleanup = (): void => {
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
      if (abortListener !== null) {
        options.signal?.removeEventListener("abort", abortListener);
        abortListener = null;
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: OutboundResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...(options.headers ?? {}),
          ...(payload !== undefined
            ? { "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
        ...(isHttps && options.ca ? { ca: options.ca } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const declared = Number(res.headers["content-length"] ?? "");
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          req.destroy();
          fail(new OutboundHttpError("response too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            req.destroy();
            fail(new OutboundHttpError("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (error) => fail(new OutboundHttpError(error.message)));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          succeed({
            status,
            ok: status >= 200 && status < 300,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      fail(new OutboundHttpError(`request timeout after ${timeoutMs}ms`));
    });
    req.on("error", (error) => fail(new OutboundHttpError(error.message)));
    deadline = setTimeout(() => {
      req.destroy();
      fail(new OutboundHttpError(`request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    deadline.unref?.();
    abortListener = () => {
      fail(new OutboundHttpError("request aborted"));
      req.destroy();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    // Close the race between the early check and listener registration.
    if (options.signal?.aborted) abortListener();
    if (!settled) {
      if (payload !== undefined) req.write(payload);
      req.end();
    }
  });
}

/** Convenience wrapper: parse a JSON object body, or throw a stable error. */
export function parseJsonObject(body: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new OutboundHttpError("invalid JSON response");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OutboundHttpError("invalid response object");
  }
  return parsed as Record<string, unknown>;
}
