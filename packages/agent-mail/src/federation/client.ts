import { listPendingForPeer, ackOutbound, recordPushFailure, DEFAULT_MAX_ATTEMPTS, STATUS_DEAD } from "./outbox.js";
import { outboundRequest, parseJsonObject } from "../outbound-http.js";
import { importEnvelope } from "./envelope.js";
import type { PeerRecord } from "./peers.js";
import { FederationError, loadPeerCa } from "./peers.js";

/** @deprecated prefer worker.pushPending for multi-peer + DLQ; kept for single-peer tests */
export async function pushPendingToPeer(
  home: string,
  peer: PeerRecord,
  opts: { maxAttempts?: number } = {},
): Promise<{ pushed: number; errors: string[]; dead_lettered: number }> {
  if (!peer.outbound_token) {
    throw new FederationError(`no outbound token for peer ${peer.domain}`);
  }
  const pending = listPendingForPeer(home, peer.domain, 20);
  let pushed = 0;
  let dead_lettered = 0;
  const errors: string[] = [];
  const maxAtt = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (const item of pending) {
    try {
      const res = await outboundRequest(`${peer.base_url}/v1/federation/push`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${peer.outbound_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ envelope: item.envelope }),
        ca: loadPeerCa(peer),
      });
      if (!res.ok) {
        const st = recordPushFailure(
          home,
          item.message_id,
          peer.domain,
          `HTTP ${res.status}`,
          maxAtt,
        );
        errors.push(`${item.message_id}: HTTP ${res.status}`);
        if (st === STATUS_DEAD) dead_lettered += 1;
        continue;
      }
      ackOutbound(home, [item.message_id], peer.domain);
      pushed += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const st = recordPushFailure(home, item.message_id, peer.domain, msg, maxAtt);
      errors.push(`${item.message_id}: ${msg}`);
      if (st === STATUS_DEAD) dead_lettered += 1;
    }
  }
  return { pushed, errors, dead_lettered };
}

export async function pullFromPeer(
  home: string,
  peer: PeerRecord,
  localDomain: string,
): Promise<{ imported: number; duplicates: number; errors: string[] }> {
  if (!peer.outbound_token) {
    throw new FederationError(`no outbound token for peer ${peer.domain}`);
  }
  const url = new URL(`${peer.base_url}/v1/federation/pull`);
  url.searchParams.set("domain", localDomain);
  const res = await outboundRequest(url, {
    headers: { Authorization: `Bearer ${peer.outbound_token}` },
    ca: loadPeerCa(peer),
  });
  if (!res.ok) {
    throw new FederationError(`pull failed HTTP ${res.status}`);
  }
  const data = parseJsonObject(res.body) as {
    items?: Array<{ message_id: string; envelope: Record<string, unknown> }>;
    envelopes?: Array<Record<string, unknown>>;
  };
  let imported = 0;
  let duplicates = 0;
  const errors: string[] = [];
  const acked: string[] = [];
  const items =
    data.items ??
    (data.envelopes ?? []).map((envelope) => ({
      message_id: String(envelope.message_id ?? ""),
      envelope,
    }));
  for (const item of items) {
    try {
      const r = importEnvelope(home, item.envelope, peer.domain);
      if (r === "imported") imported += 1;
      else duplicates += 1;
      acked.push(item.message_id);
    } catch (e) {
      errors.push(`${item.message_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (acked.length) {
    await outboundRequest(`${peer.base_url}/v1/federation/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${peer.outbound_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message_ids: acked,
        receiver_domain: localDomain,
      }),
      ca: loadPeerCa(peer),
    });
  }
  return { imported, duplicates, errors };
}
