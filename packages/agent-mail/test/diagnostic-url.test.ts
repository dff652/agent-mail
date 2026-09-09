import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initProject } from "../src/services.js";
import { validateHubUrl } from "../src/connection.js";
import { RemoteMailClient } from "../src/remote-client.js";

it("rejects secret-bearing and non-origin URLs before remote client construction", () => {
  for (const url of ["https://user:secret-marker@hub.example", "https://hub.example/?secret=marker",
    "https://hub.example/#marker", "https://hub.example/prefix", "not-a-url-secret-marker"]) {
    expect(() => validateHubUrl(url)).toThrow();
    try { validateHubUrl(url); } catch (error) { expect(String(error)).not.toContain("secret-marker"); }
    expect(() => new RemoteMailClient({ hub_url: url, hub_token: "synthetic", hub_ca_file: null,
      hub_insecure_tls: false, sources: {}, warnings: [] })).toThrow();
  }
  expect(validateHubUrl("https://HUB.example:443/")).toBe("https://hub.example");
});

it("a real MCP process neither discloses URL credentials nor sends them to the network", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-url-"));
  const home = initProject(path.join(root, ".agent-mail"));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"agent_id":"probe@local"}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const marker = "URL_CREDENTIAL_MUST_NOT_APPEAR";
  const client = new Client({ name: "diagnostic-url", version: "1" });
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", path.join(packageRoot, "src/mcp/stdio.ts")], cwd: packageRoot,
      env: { AGENT_MAIL_HOME: home, AGENT_MAIL_ID: "probe@local", AGENT_MAIL_HUB_TOKEN: "synthetic",
        AGENT_MAIL_HUB_URL: `http://user:${marker}@127.0.0.1:${port}` }, stderr: "pipe" }));
    const result = await client.callTool({ name: "comm_diagnose", arguments: {} });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(requests).toBe(0);
    const logs = path.join(home, "logs");
    if (fs.existsSync(logs)) {
      for (const file of fs.readdirSync(logs)) {
        const target = path.join(logs, file);
        if (fs.statSync(target).isFile()) expect(fs.readFileSync(target, "utf8")).not.toContain(marker);
      }
    }
  } finally {
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
