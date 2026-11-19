/**
 * Local wake bridge: body-free outbox → constrained runner → business-state
 * verification → cursor acknowledgement.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { acquireFileLockSync } from "../atomic-file.js";
import { AgentMailError } from "../errors.js";
import { OutboundHttpError, outboundRequest } from "../outbound-http.js";
import {
  businessState,
  coalesceEvents,
  planWakeProcess,
  type WakeInboxSnapshot,
} from "../domain/wake-gate.js";
import { appendRuntimeLog } from "../observability.js";
import type { OutboxEventRow } from "../store/sqlite-store.js";
import * as svc from "../services.js";
import {
  MAX_SSE_RESPONSE_BYTES,
  parseSseEvents,
} from "../hub/sse.js";
import {
  buildRunnerInvocation,
  preflightWakeRunner,
  runWakeRunner,
  WAKE_COST_NOTICE,
  WAKE_RUNNERS,
  type RunnerResult,
  type WakeRunnerConfig,
  type WakeRunnerExecutor,
  type WakeRunnerName,
} from "./runner.js";

const RUNNER_REQUIRED = `live wake requires --runner ${WAKE_RUNNERS.join("|")}`;

export interface BridgeOptions {
  home: string;
  recipient: string;
  consumerId: string;
  runner: WakeRunnerName | "none";
  project?: string;
  executable?: string;
  timeoutMs?: number;
  terminateGraceMs?: number;
  lockTimeoutMs?: number;
  signal?: AbortSignal;
  allowWrite?: boolean;
  dryRun?: boolean;
  /** Deterministic local fixture hook; production defaults to runWakeRunner. */
  runnerExecutor?: WakeRunnerExecutor;
  /** When set, poll remote hub events; else local store. */
  hubUrl?: string | null;
  hubToken?: string | null;
  /** PEM bundle pinned for a private-CA Hub; null = system trust store. */
  hubCaFile?: string | null;
  waitSeconds?: number;
}

export interface BridgeProcessResult {
  sequence: number;
  message_id: string;
  action:
    | "run"
    | "ack_only"
    | "acked"
    | "reject"
    | "runner_failed"
    | "verification_failed";
  mode: string | null;
  business_state: string;
  reason?: string;
  command?: string[];
  cost_notice?: string;
  exit_code?: number;
  duration_ms?: number;
  timed_out?: boolean;
  cancelled?: boolean;
  failure_class?: RunnerResult["failure_class"];
}

function failedWake(result: BridgeProcessResult): boolean {
  return result.action === "reject" ||
    result.action === "runner_failed" ||
    result.action === "verification_failed";
}

function snapshotFor(
  home: string,
  recipient: string,
  messageId: string,
): WakeInboxSnapshot {
  const items = svc.inbox(recipient, { home, allItems: true });
  const hit = items.find((i) => i.message.id === messageId);
  if (
    !hit ||
    hit.message.to !== recipient ||
    hit.delivery.recipient !== recipient
  ) {
    throw new Error(`wake message is not in recipient inbox: ${messageId}`);
  }
  const approvals = svc.listApprovals({ home, status: null });
  const appr = approvals.find(
    (approval) =>
      approval.message_id === messageId ||
      (hit.message.task_id && approval.task_id === hit.message.task_id),
  );
  const taskStatus = hit.message.task_id
    ? svc.taskStatus(hit.message.task_id, { home })
    : null;
  return {
    message: hit.message,
    delivery: hit.delivery,
    task:
      hit.message.task_id && taskStatus
        ? {
            id: hit.message.task_id,
            thread_id: hit.message.thread_id || "",
            origin_message_id: hit.message.id,
            assignee: hit.message.to,
            status: taskStatus,
            created_at: hit.message.ts,
            updated_at: hit.message.ts,
          }
        : null,
    approval: appr
      ? { status: String(appr.status) }
      : hit.message.requires_human_approval
        ? { status: "pending" }
        : null,
  };
}

function runnerConfig(opts: BridgeOptions): WakeRunnerConfig {
  if (opts.runner === "none") {
    throw new Error(RUNNER_REQUIRED);
  }
  return {
    home: path.resolve(opts.home),
    project: path.resolve(opts.project ?? path.dirname(opts.home)),
    recipient: opts.recipient,
    runner: opts.runner,
    executable: opts.executable,
    timeoutMs: opts.timeoutMs,
    terminateGraceMs: opts.terminateGraceMs,
    signal: opts.signal,
  };
}

function stateContext(item: WakeInboxSnapshot): Record<string, unknown> {
  return {
    delivery_status: item.delivery.status,
    claim_by: item.delivery.claim_by,
    task_status: item.task?.status ?? null,
    approval_status: item.approval?.status ?? null,
  };
}

function initialResult(
  opts: BridgeOptions,
  event: OutboxEventRow,
  item: WakeInboxSnapshot,
): BridgeProcessResult {
  const plan = planWakeProcess(event, item, {
    allowWrite: Boolean(opts.allowWrite),
    recipient: opts.recipient,
  });
  return {
    sequence: event.sequence,
    message_id: event.message_id,
    action: plan.action,
    mode: plan.mode,
    business_state: plan.business_state,
    reason: plan.reason,
  };
}

/**
 * Synchronous dry-run / already-complete path retained for embedders.
 * Live execution is deliberately only exposed by processEventLocalLive().
 */
export function processEventLocal(
  opts: BridgeOptions,
  event: OutboxEventRow,
): BridgeProcessResult {
  const item = snapshotFor(opts.home, opts.recipient, event.message_id);
  const result = initialResult(opts, event, item);
  if (result.action === "run") {
    if (opts.runner === "none") {
      result.action = "reject";
      result.reason = RUNNER_REQUIRED;
      return result;
    }
    const invocation = buildRunnerInvocation(
      runnerConfig(opts),
      event,
      item,
      result.mode === "write" ? "write" : "read",
    );
    result.command = invocation.command;
    if (!opts.dryRun) {
      result.action = "reject";
      result.reason = "live wake requires the asynchronous bridge path";
    }
  }
  if (result.action === "ack_only" && !opts.dryRun) {
    svc.ackOutbox(opts.consumerId, opts.recipient, event.sequence, {
      home: opts.home,
    });
  }
  return result;
}

export function pollAndProcessLocal(
  opts: BridgeOptions,
  limit = 50,
): BridgeProcessResult[] {
  svc.backfillOutbox(opts.recipient, { home: opts.home });
  const raw = svc.listOutboxEvents(opts.recipient, {
    home: opts.home,
    consumerId: opts.consumerId,
    limit,
  });
  return coalesceEvents(raw).map((event) => processEventLocal(opts, event));
}

export async function processEventLocalLive(
  opts: BridgeOptions,
  event: OutboxEventRow,
): Promise<BridgeProcessResult> {
  if (opts.dryRun) return processEventLocal(opts, event);

  const item = snapshotFor(opts.home, opts.recipient, event.message_id);
  const result = initialResult(opts, event, item);
  const context = {
    consumer_id: opts.consumerId,
    event_id: event.id,
    sequence: event.sequence,
    kind: event.kind,
    message_id: event.message_id,
    runner: opts.runner,
  };
  appendRuntimeLog(opts.home, "wake.received", "success", {
    actor: opts.recipient,
    context,
  });

  if (result.action === "reject") {
    appendRuntimeLog(opts.home, "wake.rejected", "error", {
      actor: opts.recipient,
      context: { ...context, reason: result.reason },
    });
    return result;
  }
  if (result.action === "ack_only") {
    svc.ackOutbox(opts.consumerId, opts.recipient, event.sequence, {
      home: opts.home,
    });
    appendRuntimeLog(opts.home, "wake.deduplicated", "success", {
      actor: opts.recipient,
      context: {
        ...context,
        business_state: result.business_state,
      },
    });
    return result;
  }
  if (opts.runner === "none") {
    result.action = "reject";
    result.reason = RUNNER_REQUIRED;
    return result;
  }

  const config = runnerConfig(opts);
  const mode = result.mode === "write" ? "write" : "read";
  result.cost_notice = WAKE_COST_NOTICE;
  if (!opts.runnerExecutor) {
    try {
      preflightWakeRunner(config);
    } catch (error) {
      result.action = "runner_failed";
      result.reason =
        error instanceof Error ? error.message : "wake runner preflight failed";
      result.failure_class = "preflight_failed";
      appendRuntimeLog(opts.home, "runner.preflight", "error", {
        actor: opts.recipient,
        context: {
          ...context,
          mode,
          failure_class: result.failure_class,
        },
        error,
      });
      return result;
    }
  }
  let runnerResult: RunnerResult;
  try {
    // The mailbox requires a claim before ack. Prepare receipts here so the
    // model can just acknowledge and summarize them.
    if (opts.signal?.aborted) return result;
    if (item.message.type === "done" || item.message.type === "error") {
      item.delivery = svc.claim(event.message_id, opts.recipient, { home: opts.home });
    }
    appendRuntimeLog(opts.home, "runner.started", "success", {
      actor: opts.recipient,
      context: { ...context, mode, cost_notice_shown: true },
    });
    runnerResult = await (opts.runnerExecutor ?? runWakeRunner)(
      config,
      event,
      item,
      mode,
    );
  } catch (error) {
    result.action = "runner_failed";
    result.reason =
      error instanceof Error ? error.message : "cannot start wake runner";
    result.failure_class = "runner_exit";
    appendRuntimeLog(opts.home, "runner.failed", "error", {
      actor: opts.recipient,
      context: {
        ...context,
        mode,
        failure_class: result.failure_class,
      },
      error,
    });
    return result;
  }
  Object.assign(result, {
    exit_code: runnerResult.exit_code,
    duration_ms: runnerResult.duration_ms,
    timed_out: runnerResult.timed_out,
    cancelled: runnerResult.cancelled,
    failure_class: runnerResult.failure_class,
  });
  if (runnerResult.exit_code !== 0) {
    result.action = "runner_failed";
    result.reason = `${opts.runner} runner failed with exit code ${runnerResult.exit_code}`;
    appendRuntimeLog(
      opts.home,
      runnerResult.timed_out
        ? "runner.timed_out"
        : runnerResult.cancelled
          ? "runner.cancelled"
          : "runner.failed",
      "error",
      {
        actor: opts.recipient,
        context: {
          ...context,
          mode,
          duration_ms: runnerResult.duration_ms,
          failure_class: runnerResult.failure_class,
        },
        error: new Error(result.reason),
      },
    );
    return result;
  }
  appendRuntimeLog(opts.home, "runner.completed", "success", {
    actor: opts.recipient,
    context: {
      ...context,
      mode,
      duration_ms: runnerResult.duration_ms,
    },
  });

  const refreshed = snapshotFor(opts.home, opts.recipient, event.message_id);
  const finalState = businessState(event, refreshed);
  result.business_state = finalState;
  if (finalState === "incomplete") {
    result.action = "verification_failed";
    result.reason =
      "runner exited successfully but delivery/task state is incomplete; cursor not acked";
    appendRuntimeLog(opts.home, "wake.verify", "error", {
      actor: opts.recipient,
      context: {
        ...context,
        ...stateContext(refreshed),
        runner_failure_class: runnerResult.failure_class,
      },
      error: new Error(result.reason),
    });
    return result;
  }

  const cursor = svc.ackOutbox(
    opts.consumerId,
    opts.recipient,
    event.sequence,
    { home: opts.home },
  );
  result.action = "acked";
  appendRuntimeLog(opts.home, "wake.acked", "success", {
    actor: opts.recipient,
    context: {
      ...context,
      cursor,
      business_state: finalState,
    },
  });
  return result;
}

export async function pollAndProcessLocalLive(
  opts: BridgeOptions,
  limit = 50,
): Promise<BridgeProcessResult[]> {
  const digest = createHash("sha256").update(opts.recipient).digest("hex").slice(0, 24);
  const lockTarget = path.join(opts.home, "locks", `wake-${digest}`);
  const release = acquireFileLockSync(lockTarget, {
    timeoutMs: opts.lockTimeoutMs ?? 0,
    staleMs: Math.max(300_000, (opts.timeoutMs ?? 900_000) + 60_000),
  });
  try {
    svc.backfillOutbox(opts.recipient, { home: opts.home });
    const raw = svc.listOutboxEvents(opts.recipient, {
      home: opts.home,
      consumerId: opts.consumerId,
      limit,
    });
    const results: BridgeProcessResult[] = [];
    for (const event of coalesceEvents(raw)) {
      if (opts.signal?.aborted) break;
      const result = await processEventLocalLive(opts, event);
      results.push(result);
      if (failedWake(result)) break;
    }
    return results;
  } finally {
    release();
  }
}

/** Poll sequentially without retaining prior ticks or automatically retrying paid wakes. */
export async function runBridgeLoop(
  opts: BridgeOptions,
  loop: {
    maxTicks?: number | null;
    intervalMs?: number;
    onTick?: (results: BridgeProcessResult[], tick: number) => void;
  } = {},
): Promise<{ ticks: number; count: number; failed: boolean }> {
  const maxTicks = loop.maxTicks === undefined ? 1 : loop.maxTicks;
  const intervalMs = loop.intervalMs ?? 2000;
  if (
    (maxTicks !== null &&
      (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 1_000_000)) ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 100 ||
    intervalMs > 86_400_000
  ) {
    throw new AgentMailError(
      "bridge ticks must be 1..1000000 and interval must be 100..86400000 milliseconds",
      2,
    );
  }

  let ticks = 0;
  let count = 0;
  while (!opts.signal?.aborted && (maxTicks === null || ticks < maxTicks)) {
    const results = opts.dryRun
      ? pollAndProcessLocal(opts)
      : await pollAndProcessLocalLive(opts);
    ticks += 1;
    count += results.length;
    loop.onTick?.(results, ticks);
    if (results.some(failedWake)) return { ticks, count, failed: true };
    if (!opts.signal?.aborted && (maxTicks === null || ticks < maxTicks)) {
      try {
        await delay(intervalMs, undefined, { signal: opts.signal });
      } catch (error) {
        if (!opts.signal?.aborted) throw error;
      }
    }
  }
  return { ticks, count, failed: false };
}

export async function pollHubEvents(
  opts: BridgeOptions & { hubUrl: string; hubToken: string },
  limit = 50,
): Promise<OutboxEventRow[]> {
  const waitSeconds = opts.waitSeconds ?? 0;
  if (
    !Number.isFinite(waitSeconds) ||
    waitSeconds < 0 ||
    waitSeconds > 30 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new Error("Hub event wait/limit is outside the supported range");
  }
  const url = new URL("/v1/events", opts.hubUrl.replace(/\/$/, "") + "/");
  url.searchParams.set("recipient", opts.recipient);
  url.searchParams.set("consumer", opts.consumerId);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("wait", String(waitSeconds));
  // node:https (not fetch) so a private-CA Hub can be pinned — see outbound-http.ts.
  const ca = opts.hubCaFile ? fs.readFileSync(opts.hubCaFile) : null;
  let res;
  try {
    res = await outboundRequest(url, {
      headers: {
        Authorization: `Bearer ${opts.hubToken}`,
        Accept: "text/event-stream",
      },
      ca,
      signal: opts.signal,
      timeoutMs: Math.max(30_000, (waitSeconds + 15) * 1000),
      maxBytes: MAX_SSE_RESPONSE_BYTES,
    });
  } catch (error) {
    if (
      error instanceof OutboundHttpError &&
      error.message === "response too large"
    ) {
      throw new Error("Hub SSE response exceeded size limit");
    }
    throw error;
  }
  if (!res.ok) {
    throw new Error(`hub events HTTP ${res.status}`);
  }
  if (!res.contentType.startsWith("text/event-stream")) {
    throw new Error("Hub returned a non-SSE response");
  }
  return parseSseEvents(res.body, opts.recipient);
}
