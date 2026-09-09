import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initProject } from "../src/services.js";
import { createPairing } from "../src/pairing.js";
import { listenHub } from "../src/hub/server.js";
import { mintToken } from "../src/hub/auth.js";
import { ConnectionEnrollmentManager } from "../src/connection-enrollment.js";
import { loadConnection, loadConnectionSnapshot, setConnection, setConnectionIfRevision } from "../src/connection.js";
import { RemoteMailClient } from "../src/remote-client.js";

describe("enrollment through HTTPS into a real MCP process", () => {
  it("saves separately from activation, exchanges a handled task, restarts and preserves the previous connection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "enrollment-e2e-"));
    const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
      "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
    const hubHome = initProject(path.join(root, "hub", ".agent-mail"));
    const home = initProject(path.join(root, "joining", ".agent-mail"));
    const priorToken = path.join(home, "prior.token");
    fs.writeFileSync(priorToken, "previous-protected-credential\n", { mode: 0o600 });
    setConnection(home, { hub_url: "https://prior.example", token_file: priorToken });
    const previous = loadConnectionSnapshot(home);
    const hub = await listenHub({ home: hubHome, host: "127.0.0.1", port: 0,
      tlsCertFile: cert, tlsKeyFile: key, enableEnrollment: true, requireAuth: true });
    let mcp: Client | null = null;
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    async function launch() {
      const client = new Client({ name: "enrollment-acceptance", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: ["--import", "tsx", path.join(packageRoot, "src/mcp/stdio.ts")], cwd: packageRoot,
        env: { AGENT_MAIL_HOME: home, AGENT_MAIL_HUB_URL: hub.url, AGENT_MAIL_ID: "joined@local" }, stderr: "pipe" }));
      return client;
    }
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await mcp!.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text?: string }[];
      return JSON.parse(content.find(item => item.type === "text")!.text!) as Record<string, unknown>;
    }
    try {
      const managerOptions = { home, owner: "operator", allowedHubUrls: [hub.url], caFile: cert,
        activationVerifier: async () => {
          if (!mcp) return { effective_hub_url: hub.url, agent_id: "joined@local", route_verified: false };
          const diagnosis = await call("comm_diagnose");
          const directory = await call("comm_list_agents");
          expect(diagnosis).toMatchObject({
            connection_revision: loadConnectionSnapshot(home).revision,
            credential_source: "token_file", tls_verified: true,
          });
          return { effective_hub_url: String(diagnosis.hub_url), agent_id: String(diagnosis.agent_id),
            route_verified: diagnosis.remote === true && diagnosis.mode === "remote_mail_api" && directory.remote === true };
        } };
      const manager = new ConnectionEnrollmentManager(managerOptions);
      const pair = createPairing(hubHome, "joined@local");
      const context = await manager.begin({ endpoint: hub.url });
      const enrolled = await manager.redeem({ context_handle: context.context_handle, request_id: randomUUID(), code: pair.code });
      expect(loadConnectionSnapshot(home).revision).toBe(previous.revision);
      const saved = await manager.commit({ enrollment_handle: enrolled.enrollment_handle,
        expected_config_revision: context.observed_config_revision, confirmed_agent_id: enrolled.agent_id });
      expect(saved).toMatchObject({ save_state: "saved", activation_state: "restart_required" });
      expect(fs.readFileSync(priorToken, "utf8")).toBe("previous-protected-credential\n");
      const credential = fs.readFileSync(path.resolve(home, loadConnection(home).token_file), "utf8").trim();
      expect(JSON.stringify({ context, enrolled, saved })).not.toContain(credential);
      mcp = await launch();
      expect(await manager.activate({ enrollment_handle: enrolled.enrollment_handle })).toMatchObject({ activation_state: "active" });
      const recipient = new RemoteMailClient({ hub_url: hub.url, hub_token: mintToken(hubHome, "codex@local"),
        hub_ca_file: cert, hub_insecure_tls: false, sources: {}, warnings: [] }, { maxAttempts: 1 });
      const sent = await call("comm_send", { to: "codex@local", body: "enrollment acceptance", type: "task", effect: "read" });
      expect(sent.remote).toBe(true);
      expect(await recipient.claim(String(sent.id))).toMatchObject({ status: "claimed" });
      await recipient.send({ to: "joined@local", body: "acceptance done", type: "done",
        thread_id: String(sent.thread_id), task_id: String(sent.task_id), in_reply_to: String(sent.id) });
      expect(await recipient.ack(String(sent.id))).toMatchObject({ status: "acked" });
      expect((await call("comm_inbox")).remote).toBe(true);
      await mcp.close(); mcp = await launch();
      const restarted = new ConnectionEnrollmentManager(managerOptions);
      expect(await restarted.activate({ enrollment_handle: enrolled.enrollment_handle })).toMatchObject({ activation_state: "active" });
      await expect(restarted.cancel({ enrollment_handle: enrolled.enrollment_handle })).rejects.toMatchObject({ code: "cleanup_conflict" });
      await mcp.close(); mcp = null;
      const activeRevision = loadConnectionSnapshot(home).revision;
      setConnectionIfRevision(home, activeRevision, previous.settings, false);
      expect(loadConnection(home)).toMatchObject({ hub_url: previous.settings.hub_url, token_file: priorToken });
    } finally {
      await mcp?.close();
      await new Promise<void>(resolve => hub.server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
