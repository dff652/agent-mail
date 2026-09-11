/**
 * Remote Hub Mail Data API client.
 */
import fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

import {
  remoteModeEnabled,
  resolveClientConnection,
  validateHubUrl,
  type ResolvedConnection,
} from "./connection.js";
import { AgentMailError } from "./errors.js";

export class RemoteMailError extends AgentMailError {
  readonly status: number | null;

  constructor(message: string, status: number | null = null, exitCode = 1) {
    super(message, exitCode);
    this.name = "RemoteMailError";
    this.status = status;
  }
}

export class RemoteMailClient {
  readonly base: string;
  readonly token: string;
  private readonly ca: Buffer | null;
  private readonly insecure: boolean;
  private readonly maxAttempts: number;

  constructor(
    resolved: ResolvedConnection,
    options: { maxAttempts?: number; ca?: Buffer | null } = {},
  ) {
    if (!resolved.hub_url) {
      throw new RemoteMailError("hub_url is required for remote mail");
    }
    if (!resolved.hub_token) {
      throw new RemoteMailError(
        "hub token required: set AGENT_MAIL_HUB_TOKEN or connection token_file",
        null,
        2,
      );
    }
    this.base = validateHubUrl(resolved.hub_url);
    this.token = resolved.hub_token;
    this.insecure = resolved.hub_insecure_tls;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 3
    ) {
      throw new RemoteMailError("maxAttempts must be an integer from 1 to 3", null, 2);
    }
    this.ca =
      options.ca !== undefined
        ? options.ca
        : resolved.hub_ca_file
          ? fs.readFileSync(resolved.hub_ca_file)
          : null;
  }

  private request(
    method: string,
    apiPath: string,
    opts: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
  ): Promise<Record<string, unknown>> {
    let urlStr = `${this.base}${apiPath}`;
    if (opts.query) {
      const q = new URLSearchParams(opts.query);
      urlStr += `?${q.toString()}`;
    }
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;

    const attempt = (n: number): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const lib = isHttps ? https : http;
        const req = lib.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: "application/json",
              ...(payload
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                  }
                : {}),
            },
            ...(isHttps
              ? {
                  ca: this.ca ?? undefined,
                  rejectUnauthorized: !this.insecure,
                  ...(this.insecure
                    ? { checkServerIdentity: () => undefined }
                    : {}),
                }
              : {}),
            timeout: 30_000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf8");
              const status = res.statusCode || 0;
              let data: Record<string, unknown> = {};
              if (raw) {
                try {
                  const parsed = JSON.parse(raw) as unknown;
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    data = parsed as Record<string, unknown>;
                  }
                } catch {
                  if (status >= 200 && status < 300) {
                    reject(new RemoteMailError("hub returned non-JSON", status));
                    return;
                  }
                }
              }
              if (status >= 200 && status < 300) {
                resolve(data);
                return;
              }
              const message = String(data.error || res.statusMessage || `HTTP ${status}`);
              let exitCode = 1;
              if (status === 401 || status === 403) exitCode = 6;
              else if (status === 404) exitCode = 4;
              else if (status === 409) exitCode = 5;
              if (
                (status === 408 || status === 429) &&
                n + 1 < this.maxAttempts
              ) {
                setTimeout(() => {
                  attempt(n + 1).then(resolve, reject);
                }, 50 * 2 ** n);
                return;
              }
              reject(new RemoteMailError(message, status, exitCode));
            });
          },
        );
        req.on("error", (err) => {
          if (n + 1 < this.maxAttempts) {
            setTimeout(() => {
              attempt(n + 1).then(resolve, reject);
            }, 50 * 2 ** n);
            return;
          }
          reject(new RemoteMailError(`hub request failed: ${err.message}`, null, 1));
        });
        req.on("timeout", () => {
          req.destroy();
          if (n + 1 < this.maxAttempts) {
            setTimeout(() => {
              attempt(n + 1).then(resolve, reject);
            }, 50 * 2 ** n);
            return;
          }
          reject(new RemoteMailError("hub request timeout", null, 1));
        });
        if (payload) req.write(payload);
        req.end();
      });

    return attempt(0);
  }

  me(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/mail/me");
  }

  send(opts: {
    to: string;
    body: string;
    type?: string;
    thread_id?: string;
    task_id?: string;
    effect?: string;
    requires_human_approval?: boolean;
    in_reply_to?: string;
    id?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      to: opts.to,
      body: opts.body,
      type: opts.type || "message",
      effect: opts.effect || "none",
    };
    if (opts.thread_id) body.thread_id = opts.thread_id;
    if (opts.task_id) body.task_id = opts.task_id;
    if (opts.id) body.id = opts.id;
    if (opts.requires_human_approval !== undefined) {
      body.requires_human_approval = opts.requires_human_approval;
    }
    if (opts.in_reply_to) body.in_reply_to = opts.in_reply_to;
    return this.request("POST", "/v1/mail/messages", { body });
  }

  inbox(allItems = false): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/mail/inbox", {
      query: { all: allItems ? "1" : "0" },
    });
  }

  sent(opts: {
    limit?: number;
    before?: string;
  } = {}): Promise<Record<string, unknown>> {
    const query: Record<string, string> = {};
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    if (opts.before !== undefined) query.before = opts.before;
    return this.request("GET", "/v1/mail/sent", { query });
  }

  async agentDetails(agentId?: string): Promise<Record<string, unknown>> {
    const apiPath = agentId
      ? `/v1/mail/agents/${encodeURIComponent(agentId)}/details`
      : "/v1/mail/me/details";
    const result = await this.request("GET", apiPath);
    // The client-side validated origin is the configured Hub identity. Do not
    // let a proxy-supplied Host header change what the caller labels as Hub.
    return { ...result, hub_endpoint: this.base };
  }

  claim(messageId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/mail/messages/${messageId}/claim`, { body: {} });
  }

  ack(messageId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/mail/messages/${messageId}/ack`, { body: {} });
  }

  agents(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/mail/agents");
  }

  thread(threadId: string, limit = 50): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/mail/threads/${threadId}`, {
      query: { limit: String(limit) },
    });
  }
}

export function openRemoteClient(home?: string): RemoteMailClient {
  const h =
    home ||
    process.env.AGENT_MAIL_HOME ||
    `${process.cwd()}/.agent-mail`;
  return new RemoteMailClient(resolveClientConnection(h));
}

export { remoteModeEnabled };
