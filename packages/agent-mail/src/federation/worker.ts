/**
 * Federation push/pull sync worker with health snapshot and dead-letter support.
 */
import fs from "node:fs";
import path from "node:path";

import { atomicWriteText } from "../atomic-file.js";
import { outboundRequest, parseJsonObject } from "../outbound-http.js";
import { importEnvelope } from "./envelope.js";
import {
  DEFAULT_LAG_ALERT_SEC,
  DEFAULT_MAX_ATTEMPTS,
  STATUS_DEAD,
  ackOutbound,
  listPendingForPeer,
  outboxCounts,
  recordPushFailure,
} from "./outbox.js";
import {
  loadLocalDomain,
  loadPeerCa,
  loadPeers,
  type PeerRecord,
} from "./peers.js";
import {
  clearPullFailure,
  countPullDeadLetters,
  recordPullFailure,
} from "./pull-dlq.js";

export const MAX_FEDERATION_PULL_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_FEDERATION_HTTP_TIMEOUT_MS = 10_000;

export interface SyncStats {
  pushed: number;
  push_failed: number;
  pull_failed: number;
  dead_lettered: number;
  pulled: number;
  imported: number;
  duplicates: number;
  acked: number;
  errors: string[];
}

export function emptyStats(): SyncStats {
  return {
    pushed: 0,
    push_failed: 0,
    pull_failed: 0,
    dead_lettered: 0,
    pulled: 0,
    imported: 0,
    duplicates: 0,
    acked: 0,
    errors: [],
  };
}

export function mergeStats(a: SyncStats, b: SyncStats): SyncStats {
  return {
    pushed: a.pushed + b.pushed,
    push_failed: a.push_failed + b.push_failed,
    pull_failed: a.pull_failed + b.pull_failed,
    dead_lettered: a.dead_lettered + b.dead_lettered,
    pulled: a.pulled + b.pulled,
    imported: a.imported + b.imported,
    duplicates: a.duplicates + b.duplicates,
    acked: a.acked + b.acked,
    errors: [...a.errors, ...b.errors],
  };
}

function maxAttemptsFromEnv(): number {
  const raw = (process.env.AGENT_MAIL_FED_MAX_ATTEMPTS || "").trim();
  if (/^\d+$/.test(raw)) return Math.min(10_000, Math.max(1, Number(raw)));
  return DEFAULT_MAX_ATTEMPTS;
}

function lagAlertFromEnv(): number {
  const raw = (process.env.AGENT_MAIL_FED_LAG_ALERT_SEC || "").trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isNaN(n)) return Math.max(0, n);
  }
  return DEFAULT_LAG_ALERT_SEC;
}

function validatedHttpTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_FEDERATION_HTTP_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 120_000
  ) {
    throw new Error("federation HTTP timeout must be 100..120000 milliseconds");
  }
  return timeoutMs;
}

export function healthPath(home: string): string {
  return path.join(path.resolve(home), "logs", "federation_health.json");
}

/** Peer CA is resolved per call so a rotated PEM does not need a peer re-add. */
function peerCa(peer: PeerRecord): Buffer | null {
  return loadPeerCa(peer);
}

export async function pushPending(
  home: string,
  opts: {
    domain?: string;
    limit?: number;
    maxAttempts?: number;
    timeoutMs?: number;
  } = {},
): Promise<SyncStats> {
  const stats = emptyStats();
  const maxAtt = opts.maxAttempts ?? maxAttemptsFromEnv();
  const limit = opts.limit ?? 50;
  const timeoutMs = validatedHttpTimeout(opts.timeoutMs);
  const peers = loadPeers(home).filter(
    (p) =>
      p.status === "active" &&
      p.push_enabled &&
      p.outbound_token &&
      p.base_url &&
      (!opts.domain || p.domain === opts.domain),
  );
  for (const peer of peers) {
    const items = listPendingForPeer(home, peer.domain, limit);
    for (const item of items) {
      const mid = item.message_id;
      try {
        const res = await outboundRequest(`${peer.base_url}/v1/federation/push`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${peer.outbound_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ envelope: item.envelope }),
          ca: peerCa(peer),
          timeoutMs,
        });
        if (!res.ok) {
          const status = recordPushFailure(
            home,
            mid,
            peer.domain,
            `HTTP ${res.status}`,
            maxAtt,
          );
          stats.push_failed += 1;
          if (status === STATUS_DEAD) {
            stats.dead_lettered += 1;
            stats.errors.push(
              `push ${peer.domain} ${mid}: dead-lettered after HTTP ${res.status}`,
            );
          } else {
            stats.errors.push(`push ${peer.domain} ${mid}: HTTP ${res.status}`);
          }
          continue;
        }
        const acked = ackOutbound(home, [mid], peer.domain);
        if (acked.length) {
          stats.pushed += 1;
          stats.acked += 1;
        } else {
          stats.push_failed += 1;
          stats.errors.push(
            `push ${peer.domain} ${mid}: remote ok but local ack missed`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = recordPushFailure(home, mid, peer.domain, msg, maxAtt);
        stats.push_failed += 1;
        if (status === STATUS_DEAD) {
          stats.dead_lettered += 1;
          stats.errors.push(
            `push ${peer.domain} ${mid}: dead-lettered: ${msg}`,
          );
        } else {
          stats.errors.push(`push ${peer.domain} ${mid}: ${msg}`);
        }
      }
    }
  }
  return stats;
}

export async function pullFromPeer(
  home: string,
  peer: PeerRecord,
  localDomain: string,
  limit = 100,
  opts: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<SyncStats> {
  const stats = emptyStats();
  if (!peer.outbound_token) {
    stats.errors.push(`pull ${peer.domain}: missing outbound_token`);
    return stats;
  }
  if (!peer.base_url) {
    stats.errors.push(`pull ${peer.domain}: missing base_url`);
    return stats;
  }
  try {
    const timeoutMs = validatedHttpTimeout(opts.timeoutMs);
    const url = new URL(`${peer.base_url}/v1/federation/pull`);
    url.searchParams.set("domain", localDomain);
    url.searchParams.set("limit", String(limit));
    const res = await outboundRequest(url, {
      headers: { Authorization: `Bearer ${peer.outbound_token}` },
      ca: peerCa(peer),
      timeoutMs,
      maxBytes: MAX_FEDERATION_PULL_RESPONSE_BYTES,
    });
    if (!res.ok) {
      stats.errors.push(`pull ${peer.domain}: HTTP ${res.status}`);
      return stats;
    }
    const data = parseJsonObject(res.body);
    if (
      (data.items !== undefined && !Array.isArray(data.items)) ||
      (data.envelopes !== undefined && !Array.isArray(data.envelopes))
    ) {
      stats.errors.push(`pull ${peer.domain}: invalid envelope list`);
      return stats;
    }
    // Support both wire shapes
    const items =
      (data.items as Array<{
        message_id?: string;
        envelope?: Record<string, unknown>;
      }> | undefined) ||
      ((data.envelopes as Array<Record<string, unknown>> | undefined) || []).map(
        (env) => ({
          message_id: String(env?.message_id || ""),
          envelope: env,
        }),
      );
    const acked: string[] = [];
    for (const item of items) {
      const env = item.envelope || (item as unknown as Record<string, unknown>);
      if (!env || typeof env !== "object" || Array.isArray(env)) {
        stats.pull_failed += 1;
        stats.errors.push(`import from ${peer.domain}: invalid envelope`);
        continue;
      }
      stats.pulled += 1;
      try {
        const r = importEnvelope(
          home,
          env as Record<string, unknown>,
          peer.domain,
        );
        if (r === "imported") stats.imported += 1;
        else stats.duplicates += 1;
        const mid = String(
          (env as { message_id?: string }).message_id || item.message_id || "",
        );
        if (mid) {
          clearPullFailure(home, peer.domain, mid);
          acked.push(mid);
        }
      } catch (e) {
        stats.pull_failed += 1;
        const mid = String(
          (env as { message_id?: string }).message_id || item.message_id || "",
        );
        const message = (e instanceof Error ? e.message : String(e))
          .replace(/[\r\n]+/g, " ")
          .slice(0, 240);
        if (!mid) {
          stats.errors.push(`import from ${peer.domain}: missing message_id`);
          continue;
        }
        try {
          const status = recordPullFailure(home, {
            sourceDomain: peer.domain,
            messageId: mid,
            envelope: env as Record<string, unknown>,
            error: message,
            maxAttempts: opts.maxAttempts ?? maxAttemptsFromEnv(),
          });
          if (status === STATUS_DEAD) {
            stats.dead_lettered += 1;
            acked.push(mid);
            stats.errors.push(
              `import from ${peer.domain} ${mid}: dead-lettered: ${message}`,
            );
          } else {
            stats.errors.push(
              `import from ${peer.domain} ${mid}: ${message}`,
            );
          }
        } catch (dlqError) {
          stats.errors.push(
            `import from ${peer.domain} ${mid}: pull DLQ unavailable: ${
              dlqError instanceof Error ? dlqError.message : String(dlqError)
            }`,
          );
        }
      }
    }
    if (acked.length) {
      const ackRes = await outboundRequest(`${peer.base_url}/v1/federation/ack`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${peer.outbound_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message_ids: acked,
          receiver_domain: localDomain,
        }),
        ca: peerCa(peer),
        timeoutMs,
      });
      if (ackRes.ok) stats.acked += acked.length;
      else stats.errors.push(`ack ${peer.domain}: HTTP ${ackRes.status}`);
    }
  } catch (e) {
    stats.errors.push(
      `pull ${peer.domain}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return stats;
}

export async function pullPending(
  home: string,
  opts: { limit?: number; maxAttempts?: number; timeoutMs?: number } = {},
): Promise<SyncStats> {
  let stats = emptyStats();
  const local = loadLocalDomain(home);
  if (!local) {
    stats.errors.push("local_domain not configured");
    return stats;
  }
  for (const peer of loadPeers(home)) {
    if (peer.status !== "active" || !peer.outbound_token || !peer.base_url) {
      continue;
    }
    const part = await pullFromPeer(home, peer, local, opts.limit ?? 100, {
      maxAttempts: opts.maxAttempts,
      timeoutMs: opts.timeoutMs,
    });
    stats = mergeStats(stats, part);
  }
  return stats;
}

export function buildHealthSnapshot(
  home: string,
  opts: { lastSync?: SyncStats | null; lagAlertSec?: number } = {},
): Record<string, unknown> {
  const lagLimit = opts.lagAlertSec ?? lagAlertFromEnv();
  const counts = outboxCounts(home);
  const pullDead = countPullDeadLetters(home);
  const peers = loadPeers(home).map((p) => ({
    domain: p.domain,
    status: p.status,
    push_enabled: p.push_enabled,
    pull_enabled: p.pull_enabled,
    has_outbound: Boolean(p.outbound_token),
    base_url: p.base_url,
  }));
  const syncDict = opts.lastSync
    ? { ...opts.lastSync, errors: [...opts.lastSync.errors] }
    : null;
  const alerts: string[] = [];
  const age = counts.oldest_pending_age_sec;
  if (
    age != null &&
    lagLimit > 0 &&
    typeof age === "number" &&
    age >= lagLimit
  ) {
    alerts.push(
      `pending_lag_high age_sec=${Math.floor(age)} threshold=${Math.floor(lagLimit)}`,
    );
  }
  if (Number(counts.dead || 0) > 0) {
    alerts.push(`dead_letters count=${counts.dead}`);
  }
  if (pullDead > 0) {
    alerts.push(`pull_dead_letters count=${pullDead}`);
  }
  if (syncDict?.errors?.length) {
    alerts.push(`last_sync_errors count=${syncDict.errors.length}`);
  }
  if (syncDict && Number(syncDict.dead_lettered || 0) > 0) {
    alerts.push(`last_sync_dead_lettered count=${syncDict.dead_lettered}`);
  }
  return {
    ts: new Date().toISOString(),
    ok: alerts.length === 0,
    local_domain: loadLocalDomain(home),
    outbox: counts,
    pull_dlq: { dead: pullDead },
    peers,
    last_sync: syncDict,
    thresholds: {
      lag_alert_sec: lagLimit,
      max_attempts: maxAttemptsFromEnv(),
    },
    alerts,
  };
}

export function writeHealthSnapshot(
  home: string,
  snapshot: Record<string, unknown>,
): string {
  const p = healthPath(home);
  const directory = path.dirname(p);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`federation health directory must be real: ${directory}`);
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  if (fs.existsSync(p)) {
    const stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`federation health path must be a real file: ${p}`);
    }
  }
  atomicWriteText(p, JSON.stringify(snapshot, null, 2) + "\n", 0o600);
  return p;
}

export function readHealthSnapshot(
  home: string,
): Record<string, unknown> | null {
  const p = healthPath(home);
  try {
    const pathStat = fs.lstatSync(p);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error(`federation health path must be a private real file: ${p}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const directory = path.dirname(p);
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)
  ) {
    throw new Error(
      `federation health directory must be a private real directory: ${directory}`,
    );
  }
  let fd: number;
  try {
    fd = fs.openSync(
      p,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`federation health path must be a private real file: ${p}`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error(`federation health path must be a private real file: ${p}`);
    }
    try {
      return JSON.parse(fs.readFileSync(fd, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  } catch {
    throw new Error(`federation health path must be a private real file: ${p}`);
  } finally {
    fs.closeSync(fd);
  }
}

export async function syncOnce(
  home: string,
  opts: {
    limit?: number;
    maxAttempts?: number;
    timeoutMs?: number;
    writeHealth?: boolean;
  } = {},
): Promise<SyncStats> {
  let stats = emptyStats();
  stats = mergeStats(
    stats,
    await pushPending(home, {
      limit: opts.limit,
      maxAttempts: opts.maxAttempts,
      timeoutMs: opts.timeoutMs,
    }),
  );
  stats = mergeStats(
    stats,
    await pullPending(home, {
      limit: opts.limit,
      maxAttempts: opts.maxAttempts,
      timeoutMs: opts.timeoutMs,
    }),
  );
  if (opts.writeHealth !== false) {
    const snapshot = buildHealthSnapshot(home, { lastSync: stats });
    writeHealthSnapshot(home, snapshot);
  }
  return stats;
}

function waitForNextTick(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, intervalMs);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Run bounded ticks for tests/operators, or until aborted when maxTicks=null. */
export async function runWorker(
  home: string,
  opts: {
    intervalMs?: number;
    maxTicks?: number | null;
    limit?: number;
    maxAttempts?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SyncStats> {
  const maxTicks = opts.maxTicks === undefined ? 1 : opts.maxTicks;
  const intervalMs = opts.intervalMs ?? 2000;
  if (
    (maxTicks !== null &&
      (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 1_000_000)) ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 100 ||
    intervalMs > 86_400_000
  ) {
    throw new Error(
      "worker ticks must be 1..1000000 and interval must be 100..86400000 milliseconds",
    );
  }
  let total = emptyStats();
  let tick = 0;
  while (
    !opts.signal?.aborted &&
    (maxTicks === null || tick < maxTicks)
  ) {
    total = mergeStats(
      total,
      await syncOnce(home, {
        limit: opts.limit,
        maxAttempts: opts.maxAttempts,
        timeoutMs: opts.timeoutMs,
      }),
    );
    tick += 1;
    if (
      !opts.signal?.aborted &&
      (maxTicks === null || tick < maxTicks)
    ) {
      await waitForNextTick(intervalMs, opts.signal);
    }
  }
  return total;
}
