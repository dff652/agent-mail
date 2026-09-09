/**
 * MCP stdio server — tools match contracts/mcp/tools.json.
 * Local store, or remote Hub when AGENT_MAIL_HUB_URL is set (P1).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import fs from "node:fs";

import { loadConnectionSnapshot, remoteModeEnabled, resolveClientConnection } from "../connection.js";
import { AgentMailError } from "../errors.js";
import { appendRuntimeLog } from "../observability.js";
import { loadPolicy } from "../policy.js";
import { openRemoteClient, RemoteMailClient } from "../remote-client.js";
import * as svc from "../services.js";
import { AGENT_MAIL_VERSION } from "../version.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errResult(e: unknown, operation = "mcp.unknown") {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof AgentMailError ? e.exitCode : 1;
  appendRuntimeLog(svc.resolveHomeFromEnv(), operation, "error", {
    actor: process.env.AGENT_MAIL_ID ?? null,
    context: { exit_code: code },
    error: e,
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg, exit_code: code }) }],
    isError: true,
  };
}

function home(): string {
  const h = svc.resolveHomeFromEnv();
  if (!fs.existsSync(h) && !remoteModeEnabled()) {
    throw new AgentMailError(
      `Agent Mail home not found: ${h}; run agent-mail init first`,
      3,
    );
  }
  return h;
}

function actor(): string {
  return svc.requireAgentIdEnv();
}

function remoteOrNull(h: string): RemoteMailClient | null {
  if (!remoteModeEnabled()) return null;
  return openRemoteClient(h);
}

/** Build server with contracted tools (for tests + runtime). */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-mail",
    version: AGENT_MAIL_VERSION,
  });

  server.tool(
    "comm_send",
    "Send a message/task to another agent via Agent Mail.",
    {
      // contracts/mcp/tools.json: required to, type, body; optional thread_id, task_id,
      // effect, requires_human_approval, in_reply_to
      to: z.string(),
      body: z.string(),
      type: z.string().default("message"),
      thread_id: z.string().optional(),
      task_id: z.string().optional(),
      effect: z.string().default("none"),
      requires_human_approval: z.boolean().optional(),
      in_reply_to: z.string().optional(),
    },
    async (args) => {
      try {
        const h = home();
        const remote = remoteOrNull(h);
        if (remote) {
          const result = await remote.send({
            to: args.to,
            body: args.body,
            type: args.type,
            thread_id: args.thread_id,
            task_id: args.task_id,
            effect: args.effect,
            requires_human_approval: args.requires_human_approval,
            in_reply_to: args.in_reply_to,
          });
          return jsonResult({ ...result, remote: true });
        }
        const msg = svc.send({
          from_id: actor(),
          to: args.to,
          type: args.type,
          body: args.body,
          home: h,
          thread_id: args.thread_id,
          task_id: args.task_id,
          effect: args.effect,
          requires_human_approval: args.requires_human_approval,
          in_reply_to: args.in_reply_to,
        });
        return jsonResult({
          id: msg.id,
          type: msg.type,
          thread_id: msg.thread_id,
          task_id: msg.task_id,
          to: msg.to,
          approval_id:
            typeof msg.meta?.approval_id === "string" ? msg.meta.approval_id : null,
          requires_human_approval: msg.requires_human_approval,
          in_reply_to: msg.in_reply_to,
        });
      } catch (e) {
        return errResult(e, "mcp.comm_send");
      }
    },
  );

  server.tool(
    "comm_inbox",
    "List inbox messages for the configured agent identity.",
    {
      unread_only: z.boolean().optional().default(true),
    },
    async (args) => {
      try {
        const h = home();
        const remote = remoteOrNull(h);
        if (remote) {
          const result = await remote.inbox(args.unread_only === false);
          return jsonResult({ ...result, remote: true });
        }
        const items = svc.inbox(actor(), {
          home: h,
          allItems: args.unread_only === false,
        });
        return jsonResult({
          count: items.length,
          items: items.map((i) => ({
            message_id: i.message.id,
            type: i.message.type,
            from: i.message.from_id,
            to: i.message.to,
            body_md: i.message.body_md,
            thread_id: i.message.thread_id,
            task_id: i.message.task_id,
            delivery_status: i.delivery.status,
            effect_level: i.message.effect_level,
          })),
        });
      } catch (e) {
        return errResult(e, "mcp.comm_inbox");
      }
    },
  );

  server.tool(
    "comm_claim",
    "Claim a delivery for exclusive processing (lease).",
    { message_id: z.string() },
    async (args) => {
      try {
        const h = home();
        const remote = remoteOrNull(h);
        if (remote) {
          const result = await remote.claim(args.message_id);
          return jsonResult({ ...result, remote: true });
        }
        const d = svc.claim(args.message_id, actor(), { home: h });
        return jsonResult({
          message_id: d.message_id,
          status: d.status,
          claim_by: d.claim_by,
          claim_until: d.claim_until?.toISOString() ?? null,
        });
      } catch (e) {
        return errResult(e, "mcp.comm_claim");
      }
    },
  );

  server.tool(
    "comm_ack",
    "Ack a delivery after processing (not human approval).",
    { message_id: z.string() },
    async (args) => {
      try {
        const h = home();
        const remote = remoteOrNull(h);
        if (remote) {
          const result = await remote.ack(args.message_id);
          return jsonResult({ ...result, remote: true });
        }
        const d = svc.ack(args.message_id, actor(), { home: h });
        return jsonResult({ message_id: d.message_id, status: d.status });
      } catch (e) {
        return errResult(e, "mcp.comm_ack");
      }
    },
  );

  server.tool(
    "comm_list_agents",
    "List registered agent ids in the project roster.",
    {},
    async () => {
      try {
        const h = home();
        const remote = remoteOrNull(h);
        if (remote) {
          const result = await remote.agents();
          return jsonResult({ ...result, remote: true });
        }
        return jsonResult({ agents: svc.listAgents({ home: h }) });
      } catch (e) {
        return errResult(e, "mcp.comm_list_agents");
      }
    },
  );

  server.tool(
    "comm_approve",
    "Human approval for a side-effect (approve-writes). Requires AGENT_MAIL_ID=human@local.",
    {
      approval_id: z.string(),
      note: z.string().optional().default(""),
    },
    async (args) => {
      try {
        const a = svc.approve(args.approval_id, actor(), {
          home: home(),
          note: args.note,
        });
        return jsonResult({
          id: a.id,
          status: a.status,
          decided_by: a.decided_by,
        });
      } catch (e) {
        return errResult(e, "mcp.comm_approve");
      }
    },
  );

  server.tool(
    "comm_reject",
    "Human rejection for a pending side-effect approval. Requires AGENT_MAIL_ID=human@local.",
    {
      approval_id: z.string(),
      note: z.string().optional().default(""),
    },
    async (args) => {
      try {
        const a = svc.reject(args.approval_id, actor(), {
          home: home(),
          note: args.note,
        });
        return jsonResult({
          id: a.id,
          status: a.status,
          decided_by: a.decided_by,
        });
      } catch (e) {
        return errResult(e, "mcp.comm_reject");
      }
    },
  );

  server.tool(
    "comm_approvals",
    "List approvals visible in the project store.",
    {
      status: z.string().optional().default("pending"),
    },
    async (args) => {
      try {
        const list = svc.listApprovals({ home: home(), status: args.status });
        return jsonResult({
          approvals: list.map((a) => ({
            id: a.id,
            task_id: a.task_id,
            requested_for: a.requested_for,
            status: a.status,
            decided_by: a.decided_by,
          })),
        });
      } catch (e) {
        return errResult(e, "mcp.comm_approvals");
      }
    },
  );

  server.tool(
    "comm_tail",
    "Return recent messages (human observability).",
    {
      limit: z.number().int().optional().default(20),
      thread_id: z.string().optional(),
    },
    async (args) => {
      try {
        const msgs = svc.tail({
          home: home(),
          limit: args.limit,
          threadId: args.thread_id,
        });
        return jsonResult({
          messages: msgs.map((m) => ({
            id: m.id,
            type: m.type,
            from: m.from_id,
            to: m.to,
            body_md: m.body_md.slice(0, 500),
            ts: m.ts.toISOString(),
          })),
        });
      } catch (e) {
        return errResult(e, "mcp.comm_tail");
      }
    },
  );

  server.tool(
    "comm_events",
    "Return body-free lifecycle audit events for debugging.",
    {
      limit: z.number().int().optional().default(20),
      kind: z.string().optional(),
      actor: z.string().optional(),
      task_id: z.string().optional(),
      thread_id: z.string().optional(),
    },
    async (args) => {
      try {
        const events = svc.listEvents({
          home: home(),
          limit: args.limit,
          kind: args.kind,
          taskId: args.task_id,
          threadId: args.thread_id,
        });
        // optional actor filter client-side
        const filtered = args.actor
          ? events.filter((e) => e.actor === args.actor)
          : events;
        return jsonResult({ events: filtered });
      } catch (e) {
        return errResult(e, "mcp.comm_events");
      }
    },
  );

  server.tool(
    "comm_diagnose",
    "Return a secret-free Agent Mail diagnostic snapshot.",
    {},
    async () => {
      try {
        const h = home();
        if (remoteModeEnabled()) {
          try {
            const snapshot = loadConnectionSnapshot(h);
            const resolved = resolveClientConnection(h);
            const remote = new RemoteMailClient(resolved);
            const me = await remote.me();
            appendRuntimeLog(h, "mcp.comm_diagnose", "success", {
              actor: process.env.AGENT_MAIL_ID ?? null,
              context: { remote: true },
            });
            return jsonResult({
              remote: true,
              hub_url: new URL(remote.base).origin,
              agent_id: me.agent_id,
              mode: "remote_mail_api",
              implementation: "typescript",
              // Opaque configuration-generation evidence binds activation to
              // the actual MCP process without exposing its home or paths.
              connection_revision: loadConnectionSnapshot(h).revision === snapshot.revision ? snapshot.revision : null,
              credential_source: resolved.sources.hub_token,
              tls_verified: remote.base.startsWith("https://") && !resolved.hub_insecure_tls,
            });
          } catch (e) {
            appendRuntimeLog(h, "mcp.comm_diagnose", "error", {
              actor: process.env.AGENT_MAIL_ID ?? null,
              context: { remote: true },
              error: e,
            });
            return jsonResult({
              remote: true,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        appendRuntimeLog(h, "mcp.comm_diagnose", "success", {
          actor: process.env.AGENT_MAIL_ID ?? null,
          context: { remote: false },
        });
        return jsonResult(svc.diagnose({ home: h }));
      } catch (e) {
        return errResult(e, "mcp.comm_diagnose");
      }
    },
  );

  return server;
}

/** Contracted tool names (must match contracts/mcp/tools.json). */
export const MCP_TOOL_NAMES = [
  "comm_send",
  "comm_inbox",
  "comm_claim",
  "comm_ack",
  "comm_list_agents",
  "comm_approve",
  "comm_reject",
  "comm_approvals",
  "comm_tail",
  "comm_events",
  "comm_diagnose",
] as const;

export async function runMcpStdio(): Promise<void> {
  if (!remoteModeEnabled()) loadPolicy(home());
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
