#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { AgentMailError } from "./errors.js";
import { appendRuntimeLog, readRuntimeLogs } from "./observability.js";
import * as svc from "./services.js";
import { AGENT_MAIL_VERSION } from "./version.js";

function usage(exitCode = 2): never {
  console.log(`agent-mail (TypeScript R1/R2)

Usage:
  agent-mail version
  agent-mail init [--path DIR]
  agent-mail quickstart [--path DIR] [--runners codex|claude,grok,…] [--force] [--json]
  agent-mail doctor [--deep] [--wake] [--hub-url URL] [--json] [--path DIR]
  agent-mail diagnose [--json] [--path DIR]
  agent-mail logs [--limit N] [--outcome success|error] [--operation NAME] [--json] [--path DIR]
  agent-mail tui [--path DIR]
  agent-mail config get KEY [--json] [--path DIR]
  agent-mail config set KEY VALUE [--json] [--path DIR]
  agent-mail config list [--json] [--path DIR]
  agent-mail backup create --output DIR [--json] [--path PROJECT]
  agent-mail backup verify --input DIR [--json]
  agent-mail backup restore --input DIR --path NEW_PROJECT [--json]
  agent-mail send --as ID --to ID --type TYPE --body TEXT [--path DIR]
  agent-mail inbox --as ID [--path DIR]
  agent-mail claim --as ID --message-id ID [--path DIR]
  agent-mail ack --as ID --message-id ID [--path DIR]
  agent-mail tail [--thread-id ID] [--path DIR]
  agent-mail approve APPROVAL_ID [--as human@local] [--note TEXT] [--path DIR]
  agent-mail reject APPROVAL_ID [--as human@local] [--note TEXT] [--path DIR]
  agent-mail approvals [--status pending|approved|rejected|all] [--json] [--path DIR]
  agent-mail agents [--json] [--path DIR]
  agent-mail outbox-backfill --as ID [--recipient ID] [--path DIR]
  agent-mail outbox-purge [--retain-after N] [--path DIR]
  agent-mail events [--limit N] [--kind K] [--actor ID] [--task-id ID]
                    [--thread ID] [--json] [--path DIR]
  agent-mail mcp
      # stdio MCP; set AGENT_MAIL_HOME and AGENT_MAIL_ID
  agent-mail management-key init --file /absolute/path/to/management-password
  agent-mail hub-token mint|rotate|revoke|revoke-previous --as ID [--label L] [--path DIR]
  agent-mail hub-token webhook-init [--path DIR]
  agent-mail hub-token list [--json] [--path DIR]
  agent-mail hub [--path DIR] [--host 127.0.0.1] [--port 7421]
                 [--tls-cert PEM] [--tls-key PEM] [--require-auth]
                 [--enable-enrollment] # guarded enrollment requires native HTTPS
                 [--max-connections N] [--tls-handshake-timeout-ms MS]
                 [--headers-timeout-ms MS] [--request-timeout-ms MS]
  agent-mail bridge --recipient ID --runner codex|grok|claude
                    [--path DIR] [--consumer-id ID] [--dry-run] [--allow-write]
                    [--executable PATH] [--timeout SEC]
  agent-mail pair create --as AGENT_ID [--ttl SEC] [--label L] [--path DIR]
  agent-mail pair redeem --code XXXX-XXXX [--path DIR]
  agent-mail pair list [--path DIR]
  agent-mail pair revoke --id pair_… [--path DIR]
  agent-mail federation set-domain DOMAIN [--path DIR]
  agent-mail federation peer-add --domain D --base-url URL [--outbound-token T] [--push]
                                 [--ca-file PEM] [--path DIR]
  agent-mail federation peer-set-outbound --domain D --outbound-token T [--path DIR]
  agent-mail federation peer-set-ca --domain D --ca-file PEM|"" [--path DIR]
  agent-mail federation status [--path DIR]
  agent-mail federation sync [--domain D] [--path DIR]
  agent-mail federation worker [--ticks N | --forever] [--interval-ms MS] [--path DIR]
  agent-mail federation dlq list|requeue [--id MSG] [--all] [--path DIR]
  agent-mail connect set --hub-url URL --token-file PATH [--ca-file PATH] [--path DIR]
  agent-mail connect show [--path DIR]
  agent-mail connect test [--path DIR]
`);
  process.exit(exitCode);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function homeFrom(args: string[]): string | undefined {
  const p = flag(args, "--path");
  return p ? `${p.replace(/\/$/, "")}/.agent-mail` : undefined;
}

function doctorHomeFrom(args: string[]): string {
  const p = flag(args, "--path");
  if (!p) return svc.defaultHome();
  const resolved = path.resolve(p);
  return path.basename(resolved) === ".agent-mail"
    ? resolved
    : path.join(resolved, ".agent-mail");
}

function initializedHomeFrom(args: string[]): string {
  const home = homeFrom(args) ?? svc.defaultHome();
  const required = ["config.json", "agents.json", "policy.yaml", "store.sqlite"];
  let initialized = false;
  try {
    initialized =
      fs.statSync(home).isDirectory() &&
      required.every((filename) =>
        fs.statSync(path.join(home, filename)).isFile(),
      );
  } catch {
    initialized = false;
  }
  if (!initialized) {
    throw new AgentMailError(
      `Agent Mail home not initialized: ${home}; run agent-mail init --path <project>`,
      3,
    );
  }
  return home;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (args.some((arg) => arg === "-h" || arg === "--help")) usage(0);
  if (!cmd) usage();

  try {
    if (cmd === "version") {
      console.log(`agent-mail ${AGENT_MAIL_VERSION} (typescript r4-fed + remote)`);
      return;
    }
    if (cmd === "quickstart") {
      const {
        formatQuickstartHuman,
        parseRunners,
        runQuickstart,
      } = await import("./quickstart.js");
      const project = flag(args, "--path") ?? process.cwd();
      const runners = parseRunners(flag(args, "--runners"));
      const result = runQuickstart(project, {
        runners,
        force: args.includes("--force"),
        skipDoctor: args.includes("--skip-doctor"),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatQuickstartHuman(result));
      }
      return;
    }
    if (cmd === "mcp") {
      const { runMcpStdio } = await import("./mcp/server.js");
      await runMcpStdio();
      return;
    }
    if (cmd === "doctor") {
      const wake = args.includes("--wake");
      const deep = args.includes("--deep") || wake;
      const { formatDoctorChecks, runDoctor } = await import("./doctor.js");
      const report = await runDoctor(doctorHomeFrom(args), {
        deep,
        wake,
        hubUrl: wake
          ? (flag(args, "--hub-url") ?? "http://127.0.0.1:7421")
          : undefined,
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const line of formatDoctorChecks(report.checks)) {
          console.log(line);
        }
        console.log(
          report.ok
            ? `doctor: OK${report.deep ? " deep" : ""} (${report.home})`
            : "doctor: FAILED",
        );
      }
      if (!report.ok) process.exitCode = 3;
      return;
    }
    if (cmd === "tui") {
      const { runTui } = await import("./tui.js");
      await runTui(doctorHomeFrom(args));
      return;
    }
    if (cmd === "diagnose") {
      const home = doctorHomeFrom(args);
      const report = svc.diagnose({ home });
      if (!report.home_exists) {
        throw new AgentMailError(`Agent Mail home not found: ${home}`, 3);
      }
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (cmd === "logs") {
      const home = doctorHomeFrom(args);
      if (!svc.diagnose({ home }).home_exists) {
        throw new AgentMailError(`Agent Mail home not found: ${home}`, 3);
      }
      const limit = Number(flag(args, "--limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new AgentMailError("--limit must be between 1 and 1000", 2);
      }
      const outcome = flag(args, "--outcome");
      if (outcome && outcome !== "success" && outcome !== "error") {
        throw new AgentMailError("--outcome must be success or error", 2);
      }
      const entries = readRuntimeLogs(home, {
        limit,
        outcome: outcome as "success" | "error" | undefined,
        operation: flag(args, "--operation"),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        for (const entry of entries) console.log(JSON.stringify(entry));
      }
      return;
    }
    if (cmd === "config") {
      const sub = args[1];
      const home = homeFrom(args) ?? svc.defaultHome();
      if (sub === "get") {
        const key = args[2];
        if (!key || key.startsWith("-")) usage();
        const item = svc.configGet(key!, { home });
        console.log(
          args.includes("--json")
            ? JSON.stringify(item, null, 2)
            : typeof item.value === "object"
              ? JSON.stringify(item.value)
              : String(item.value),
        );
        return;
      }
      if (sub === "set") {
        const key = args[2];
        const value = args[3];
        if (!key || key.startsWith("-") || value === undefined) usage();
        const item = svc.configSet(key!, value, { home });
        for (const warning of svc.configWarnings(key!)) {
          console.error(`warning: ${warning}`);
        }
        console.log(
          args.includes("--json")
            ? JSON.stringify(item, null, 2)
            : `${key}=${
                typeof item.value === "object"
                  ? JSON.stringify(item.value)
                  : String(item.value)
              }`,
        );
        return;
      }
      if (sub === "list") {
        const items = svc.configList({ home });
        if (args.includes("--json")) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          for (const item of items) {
            const value =
              typeof item.value === "object"
                ? JSON.stringify(item.value)
                : String(item.value);
            console.log(
              `${item.key}\t${value}\t[${item.authority}; danger=${item.danger}]`,
            );
          }
        }
        return;
      }
      usage();
    }
    if (cmd === "backup") {
      const sub = args[1];
      const recovery = await import("./recovery.js");
      if (sub === "create") {
        const output = flag(args, "--output");
        if (!output) usage();
        const summary = await recovery.createBackup(
          initializedHomeFrom(args),
          output,
        );
        console.log(
          args.includes("--json")
            ? JSON.stringify(summary, null, 2)
            : `backup created: ${summary.archive} (${summary.files} files, ${summary.bytes} bytes)`,
        );
        console.error(
          "Backup contains sensitive Agent Mail state; keep it private and stop writers for a coordinated snapshot.",
        );
        return;
      }
      if (sub === "verify") {
        const input = flag(args, "--input");
        if (!input) usage();
        const summary = recovery.verifyBackup(input);
        console.log(
          args.includes("--json")
            ? JSON.stringify(summary, null, 2)
            : `backup verified: ${summary.archive} (${summary.files} files, ${summary.bytes} bytes)`,
        );
        return;
      }
      if (sub === "restore") {
        const input = flag(args, "--input");
        const project = flag(args, "--path");
        if (!input || !project) usage();
        const summary = recovery.restoreBackup(
          input,
          path.join(path.resolve(project), ".agent-mail"),
        );
        console.log(
          args.includes("--json")
            ? JSON.stringify(summary, null, 2)
            : `backup restored: ${summary.restored_home} (${summary.files} files)`,
        );
        console.error(
          "Restore used a new project home; run doctor before switching any Hub, worker, MCP, or bridge.",
        );
        return;
      }
      usage();
    }
    if (cmd === "management-key") {
      if (args[1] !== "init") usage();
      const filename = flag(args, "--file");
      if (!filename) throw new AgentMailError("--file is required", 2);
      const { createManagementPasswordFile } = await import("./dsh-management.js");
      createManagementPasswordFile(filename);
      console.log("Management login secret created; read it locally from the protected file.");
      return;
    }
    if (cmd === "hub-token") {
      const sub = args[1];
      if (
        ![
          "list",
          "mint",
          "rotate",
          "revoke",
          "revoke-previous",
          "webhook-init",
        ].includes(sub ?? "")
      ) {
        usage();
      }
      const home = initializedHomeFrom(args);
      const auth = await import("./hub/auth.js");
      if (sub === "list") {
        const records = auth.listTokenMetadata(home);
        if (args.includes("--json")) {
          console.log(JSON.stringify(records, null, 2));
        } else {
          for (const record of records) {
            console.log(
              `${record.agent_id}\tcreated=${record.created_at}\t` +
                `gen=${record.generation}\tlabel=${record.label || "-"}`,
            );
          }
          console.log(`count=${records.length}`);
        }
        return;
      }
      if (sub === "webhook-init") {
        console.log(auth.ensureWebhookSecret(home));
        console.error(
          "Store this HMAC secret once in the trusted webhook sender; never commit it.",
        );
        return;
      }
      const as = flag(args, "--as");
      if (!as) usage();
      const label = flag(args, "--label") ?? "";
      if (sub === "mint" || sub === "rotate") {
        const token =
          sub === "mint"
            ? auth.mintToken(home, as, label)
            : auth.rotateToken(home, as, label);
        console.log(token);
        console.error(
          sub === "mint"
            ? "Store this token once; mint replaces all prior tokens for this agent."
            : "Store this token once; the previous token remains valid until revoke-previous or another rotate.",
        );
        return;
      }
      if (sub === "revoke") {
        console.log(auth.revokeToken(home, as) ? "revoked" : "not found");
        return;
      }
      if (sub === "revoke-previous") {
        console.log(
          auth.revokePreviousToken(home, as)
            ? "previous-revoked"
            : "nothing-to-revoke",
        );
        return;
      }
      usage();
    }
    if (cmd === "hub") {
      const home = homeFrom(args) ?? svc.defaultHome();
      svc.initProject(home);
      const host = flag(args, "--host") ?? "127.0.0.1";
      const port = Number(flag(args, "--port") ?? 7421);
      const tlsCert = flag(args, "--tls-cert");
      const tlsKey = flag(args, "--tls-key");
      const requireAuth = args.includes("--require-auth");
      const numericFlag = (name: string): number | undefined => {
        const raw = flag(args, name);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isInteger(value)) {
          throw new AgentMailError(`${name} must be an integer`, 2);
        }
        return value;
      };
      const { listenHub } = await import("./hub/server.js");
      const { url, tls } = await listenHub({
        home,
        host,
        port,
        tlsCertFile: tlsCert,
        tlsKeyFile: tlsKey,
        requireAuth,
        enableEnrollment: args.includes("--enable-enrollment"),
        maxConnections: numericFlag("--max-connections"),
        tlsHandshakeTimeoutMs: numericFlag("--tls-handshake-timeout-ms"),
        headersTimeoutMs: numericFlag("--headers-timeout-ms"),
        requestTimeoutMs: numericFlag("--request-timeout-ms"),
      });
      console.error(
        `agent-mail hub listening ${url} home=${home} tls=${tls} require_auth=${requireAuth || host !== "127.0.0.1"}`,
      );
      return;
    }
    if (cmd === "bridge") {
      const home = homeFrom(args) ?? svc.defaultHome();
      svc.initProject(home);
      const recipient = flag(args, "--recipient");
      const runnerValue = flag(args, "--runner") || "none";
      if (!["codex", "grok", "claude", "none"].includes(runnerValue)) {
        throw new AgentMailError(`unsupported wake runner: ${runnerValue}`, 2);
      }
      const runner = runnerValue as
        | "codex"
        | "grok"
        | "claude"
        | "none";
      if (!recipient) usage();
      const consumerId =
        flag(args, "--consumer-id") || `wake:${runner}:${recipient}`;
      const dryRun = args.includes("--dry-run");
      const allowWrite = args.includes("--allow-write");
      const timeoutRaw = flag(args, "--timeout");
      const timeoutSeconds = timeoutRaw ? Number(timeoutRaw) : 900;
      if (
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > 86_400
      ) {
        throw new AgentMailError(
          "bridge timeout must be between 1 and 86400 seconds",
          2,
        );
      }
      if (!dryRun && runner === "none") {
        throw new AgentMailError(
          "live wake requires --runner codex, grok, or claude",
          2,
        );
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      const { pollAndProcessLocal, pollAndProcessLocalLive } = await import(
        "./wake/bridge.js"
      );
      const bridgeOptions = {
        home,
        project: path.dirname(home),
        recipient: recipient!,
        consumerId,
        runner,
        dryRun,
        allowWrite,
        executable: flag(args, "--executable"),
        timeoutMs: timeoutSeconds * 1000,
        signal: controller.signal,
      };
      let results;
      try {
        if (!dryRun) {
          const { WAKE_COST_NOTICE } = await import("./wake/runner.js");
          console.error(`NOTICE: ${WAKE_COST_NOTICE}`);
        }
        results = dryRun
          ? pollAndProcessLocal(bridgeOptions)
          : await pollAndProcessLocalLive(bridgeOptions);
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
      console.log(JSON.stringify({ count: results.length, results }, null, 2));
      if (
        results.some((result) =>
          [
            "reject",
            "runner_failed",
            "verification_failed",
          ].includes(result.action),
        )
      ) {
        process.exitCode = 5;
      }
      return;
    }
    if (cmd === "pair") {
      const home = homeFrom(args) ?? svc.defaultHome();
      svc.initProject(home);
      const pairing = await import("./pairing.js");
      const action = args[1];
      if (action === "create") {
        const as = flag(args, "--as");
        if (!as) usage();
        const ttl = flag(args, "--ttl");
        const result = pairing.createPairing(home, as!, {
          ttlSeconds: ttl ? Number(ttl) : undefined,
          label: flag(args, "--label") || "",
        });
        console.log(`pair_id=${result.pair_id}`);
        console.log(`agent_id=${result.agent_id}`);
        console.log(`code=${result.code}`);
        console.log(`expires_at=${result.expires_at}`);
        console.error("Show code once only; store only the hash on disk.");
        return;
      }
      if (action === "redeem") {
        const code = flag(args, "--code");
        if (!code) usage();
        const result = pairing.redeemPairing(home, code!);
        console.log(`pair_id=${result.pair_id}`);
        console.log(`agent_id=${result.agent_id}`);
        console.log(`token=${result.token}`);
        console.error("Token shown once; save to a secure token_file.");
        return;
      }
      if (action === "list") {
        for (const r of pairing.listPairings(home)) {
          console.log(
            `${r.id}\t${r.status}\t${r.agent_id}\texpires=${r.expires_at}`,
          );
        }
        return;
      }
      if (action === "revoke") {
        const id = flag(args, "--id");
        if (!id) usage();
        const ok = pairing.revokePairing(home, id!);
        console.log(ok ? "revoked" : "not found");
        return;
      }
      usage();
    }
    if (cmd === "federation") {
      const sub = args[1];
      const home = homeFrom(args) ?? svc.defaultHome();
      svc.initProject(home);
      const peers = await import("./federation/peers.js");
      const outbox = await import("./federation/outbox.js");
      if (sub === "set-domain") {
        const domain = args[2];
        if (!domain || domain.startsWith("-")) usage();
        console.log(peers.setLocalDomain(home, domain));
        return;
      }
      if (sub === "peer-add") {
        const domain = flag(args, "--domain");
        const base = flag(args, "--base-url");
        if (!domain || !base) usage();
        const { inbound_token, peer } = peers.addPeer(home, {
          domain: domain!,
          base_url: base!,
          outbound_token: flag(args, "--outbound-token"),
          push_enabled: args.includes("--push"),
          ca_file: flag(args, "--ca-file"),
        });
        console.log(
          JSON.stringify(
            {
              domain: peer.domain,
              base_url: peer.base_url,
              ca_file: peer.ca_file || null,
              inbound_token,
              note: "give inbound_token to peer as their --outbound-token to call you",
            },
            null,
            2,
          ),
        );
        return;
      }
      if (sub === "peer-set-ca") {
        const domain = flag(args, "--domain");
        const caFile = flag(args, "--ca-file");
        if (!domain || caFile === undefined) usage();
        const peer = peers.setPeerCaFile(home, domain!, caFile!);
        console.log(
          JSON.stringify({
            domain: peer.domain,
            ca_file: peer.ca_file || null,
          }),
        );
        return;
      }
      if (sub === "peer-set-outbound") {
        const domain = flag(args, "--domain");
        const token = flag(args, "--outbound-token");
        if (!domain || !token) usage();
        if (!peers.getPeer(home, domain)) {
          throw new AgentMailError(`no peer ${domain}`, 4);
        }
        peers.setPeerOutboundToken(home, domain, token);
        console.log(
          JSON.stringify({
            domain: peers.validateDomain(domain),
            outbound_token: "[set]",
          }),
        );
        return;
      }
      if (sub === "status") {
        const worker = await import("./federation/worker.js");
        const live = worker.buildHealthSnapshot(home);
        worker.writeHealthSnapshot(home, live);
        console.log(
          JSON.stringify(
            {
              live,
              health_file: worker.healthPath(home),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (sub === "sync") {
        const domain = flag(args, "--domain");
        const worker = await import("./federation/worker.js");
        if (domain) {
          const peer = peers.getPeer(home, domain!);
          if (!peer) throw new AgentMailError(`no peer ${domain}`, 4);
          const local = peers.loadLocalDomain(home);
          if (!local) throw new AgentMailError("set-domain first", 3);
          const push = await worker.pushPending(home, { domain });
          const pull = await worker.pullFromPeer(home, peer, local);
          const combined = worker.mergeStats(push, pull);
          const snapshot = worker.buildHealthSnapshot(home, {
            lastSync: combined,
          });
          worker.writeHealthSnapshot(home, snapshot);
          console.log(JSON.stringify({ push, pull }, null, 2));
          return;
        }
        const stats = await worker.syncOnce(home);
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      if (sub === "worker") {
        const forever = args.includes("--forever");
        if (forever && flag(args, "--ticks") !== undefined) {
          throw new AgentMailError(
            "federation worker --forever and --ticks are mutually exclusive",
            2,
          );
        }
        const ticks = Number(flag(args, "--ticks") || "1");
        const intervalMs = Number(flag(args, "--interval-ms") || "2000");
        const worker = await import("./federation/worker.js");
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        let stats;
        try {
          stats = await worker.runWorker(home, {
            maxTicks: forever ? null : ticks,
            intervalMs,
            signal: controller.signal,
          });
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      if (sub === "dlq") {
        const pullDlq = await import("./federation/pull-dlq.js");
        const action = args[2];
        if (action === "list") {
          const dead = outbox.listDeadLetters(home);
          const pullDead = pullDlq.listPullDeadLetters(home);
          console.log(
            JSON.stringify(
              {
                count: dead.length + pullDead.length,
                items: dead,
                pull_items: pullDead,
              },
              null,
              2,
            ),
          );
          return;
        }
        if (action === "requeue") {
          const id = flag(args, "--id");
          const all = args.includes("--all");
          const requeued = outbox.requeueDead(home, {
            messageIds: id ? [id] : undefined,
            allDead: all,
          });
          const pull = pullDlq.requeuePullDeadLetters(home, {
            messageIds: id ? [id] : undefined,
            allDead: all,
          });
          console.log(
            JSON.stringify(
              {
                requeued,
                pull_requeued: pull.requeued,
                pull_errors: pull.errors,
              },
              null,
              2,
            ),
          );
          return;
        }
        usage();
      }
      usage();
    }
    if (cmd === "connect") {
      const sub = args[1];
      const home = homeFrom(args) ?? svc.defaultHome();
      const conn = await import("./connection.js");
      if (sub === "set") {
        svc.initProject(home);
        const hubUrl = flag(args, "--hub-url");
        const tokenFile = flag(args, "--token-file");
        const caFile = flag(args, "--ca-file");
        const insecure = args.includes("--insecure-tls");
        const settings = conn.setConnection(home, {
          hub_url: hubUrl,
          token_file: tokenFile,
          ca_file: caFile,
          insecure_tls: insecure ? true : undefined,
        });
        console.log(JSON.stringify(settings, null, 2));
        return;
      }
      if (sub === "show") {
        const settings = conn.loadConnection(home);
        const resolved = conn.resolveClientConnection(home);
        console.log(
          JSON.stringify(
            {
              settings,
              resolved: {
                ...resolved,
                hub_token: resolved.hub_token ? "[set]" : null,
              },
            },
            null,
            2,
          ),
        );
        return;
      }
      if (sub === "test") {
        const { openRemoteClient } = await import("./remote-client.js");
        const resolved = conn.resolveClientConnection(home);
        if (resolved.hub_url) {
          process.env.AGENT_MAIL_HUB_URL =
            process.env.AGENT_MAIL_HUB_URL || resolved.hub_url;
        }
        const client = openRemoteClient(home);
        const me = await client.me();
        console.log(JSON.stringify({ ok: true, me }, null, 2));
        return;
      }
      usage();
    }
    if (cmd === "init") {
      const base = flag(args, "--path") ?? process.cwd();
      const home = await Promise.resolve(svc.initProject(`${base}/.agent-mail`));
      console.log(`initialized ${home}`);
      return;
    }
    if (cmd === "send") {
      const from = flag(args, "--as");
      const to = flag(args, "--to");
      const type = flag(args, "--type") ?? "message";
      const body = flag(args, "--body") ?? "";
      if (!from || !to) usage();
      const msg = svc.send({
        from_id: from!,
        to: to!,
        type,
        body,
        home: homeFrom(args),
        thread_id: flag(args, "--thread-id"),
        task_id: flag(args, "--task-id"),
        effect: flag(args, "--effect") ?? "none",
      });
      console.log(JSON.stringify({ id: msg.id, type: msg.type, task_id: msg.task_id, thread_id: msg.thread_id }));
      return;
    }
    if (cmd === "inbox") {
      const as = flag(args, "--as");
      if (!as) usage();
      const items = svc.inbox(as!, { home: homeFrom(args) });
      console.log(JSON.stringify({ count: items.length, items: items.map((i) => ({
        id: i.message.id,
        type: i.message.type,
        status: i.delivery.status,
        from: i.message.from_id,
      })) }, null, 2));
      return;
    }
    if (cmd === "claim") {
      const as = flag(args, "--as");
      const mid = flag(args, "--message-id");
      if (!as || !mid) usage();
      const d = svc.claim(mid!, as!, { home: homeFrom(args) });
      console.log(JSON.stringify({ status: d.status, claim_by: d.claim_by }));
      return;
    }
    if (cmd === "ack") {
      const as = flag(args, "--as");
      const mid = flag(args, "--message-id");
      if (!as || !mid) usage();
      const d = svc.ack(mid!, as!, { home: homeFrom(args) });
      console.log(JSON.stringify({ status: d.status }));
      return;
    }
    if (cmd === "tail") {
      const msgs = svc.tail({
        home: homeFrom(args),
        threadId: flag(args, "--thread-id"),
      });
      console.log(JSON.stringify(msgs.map((m) => ({ id: m.id, type: m.type })), null, 2));
      return;
    }
    if (cmd === "approve" || cmd === "reject") {
      const approvalId = args[1];
      if (!approvalId || approvalId.startsWith("-")) usage();
      const actor = flag(args, "--as") ?? "human@local";
      const note = flag(args, "--note") ?? "";
      const home = homeFrom(args);
      const decided =
        cmd === "approve"
          ? svc.approve(approvalId, actor, { home, note })
          : svc.reject(approvalId, actor, { home, note });
      console.log(`approval ${String(decided.id)} -> ${String(decided.status)}`);
      return;
    }
    if (cmd === "approvals") {
      const status = flag(args, "--status") ?? "pending";
      const records = svc.listApprovals({
        home: homeFrom(args),
        status: status === "all" ? null : status,
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }
      if (!records.length) {
        console.log("(empty)");
        return;
      }
      for (const record of records) {
        console.log(
          `${String(record.id)}\t${String(record.status)}\ttask=${String(
            record.task_id ?? "-",
          )}\tfor=${String(record.requested_for ?? "-")}`,
        );
      }
      return;
    }
    if (cmd === "outbox-backfill") {
      const asRecipient = flag(args, "--as");
      const explicitRecipient = flag(args, "--recipient");
      if (
        asRecipient &&
        explicitRecipient &&
        asRecipient !== explicitRecipient
      ) {
        throw new AgentMailError(
          "--as and --recipient must match when both are set",
          2,
        );
      }
      const recipient = asRecipient ?? explicitRecipient;
      if (!recipient) usage();
      const added = svc.backfillOutbox(recipient!, { home: homeFrom(args) });
      console.log(JSON.stringify({ recipient, backfilled: added }));
      return;
    }
    if (cmd === "outbox-purge") {
      const retainRaw = flag(args, "--retain-after");
      let retainAfterSequence: number | null = null;
      if (retainRaw !== undefined) {
        retainAfterSequence = Number(retainRaw);
        if (!Number.isInteger(retainAfterSequence) || retainAfterSequence < 0) {
          throw new AgentMailError("--retain-after must be an integer >= 0", 2);
        }
      }
      const deleted = svc.purgeOutbox({
        home: homeFrom(args),
        retainAfterSequence,
      });
      console.log(JSON.stringify({ deleted }));
      return;
    }
    if (cmd === "agents") {
      const ids = svc.listAgents({ home: homeFrom(args) });
      if (args.includes("--json")) {
        console.log(JSON.stringify(ids, null, 2));
        return;
      }
      for (const id of ids) console.log(id);
      return;
    }
    if (cmd === "events") {
      const limitRaw = flag(args, "--limit");
      const limit = limitRaw ? Number(limitRaw) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new AgentMailError("events limit must be between 1 and 1000", 2);
      }
      const records = svc.listEvents({
        home: homeFrom(args),
        limit,
        kind: flag(args, "--kind"),
        actor: flag(args, "--actor"),
        taskId: flag(args, "--task-id"),
        threadId: flag(args, "--thread"),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(records, null, 2));
        return;
      }
      for (const event of records) {
        const target = event.entity_id ?? event.message_id ?? "-";
        console.log(
          `${String(event.ts)}\t${String(event.kind)}\tactor=${String(
            event.actor ?? "-",
          )}\ttarget=${String(target)}\ttask=${String(
            event.task_id ?? "-",
          )}\tthread=${String(event.thread_id ?? "-")}`,
        );
      }
      return;
    }
    usage();
  } catch (e) {
    appendRuntimeLog(doctorHomeFrom(args), `cli.${cmd}`, "error", {
      error: e,
      context: {
        subcommand: args[1] && !args[1].startsWith("-") ? args[1] : null,
        exit_code: e instanceof AgentMailError ? e.exitCode : 1,
      },
    });
    if (e instanceof AgentMailError) {
      console.error(e.message);
      process.exit(e.exitCode);
    }
    throw e;
  }
}

main();
