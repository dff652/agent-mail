import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setConnection } from "../src/connection.js";
import { checkRunnerBinary, runDoctor } from "../src/doctor.js";
import { mintToken } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import * as svc from "../src/services.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(dirname, "..");
const temporary: string[] = [];

function tempDir(label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporary.push(target);
  return target;
}

function makePemPair(directory: string): { cert: string; key: string } {
  const key = path.join(directory, "hub-key.pem");
  const cert = path.join(directory, "hub-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  return { cert, key };
}

beforeEach(() => {
  vi.stubEnv("AGENT_MAIL_HUB_URL", "");
  vi.stubEnv("AGENT_MAIL_HUB_TOKEN", "");
  vi.stubEnv("AGENT_MAIL_HUB_CA_FILE", "");
  vi.stubEnv("AGENT_MAIL_HUB_INSECURE_TLS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporary.length > 0) {
    fs.rmSync(temporary.pop()!, { recursive: true, force: true });
  }
});

describe("TypeScript doctor", () => {
  it("passes local config, roster and SQLite quick_check", async () => {
    const root = tempDir("am-doctor-local");
    const home = svc.initProject(path.join(root, ".agent-mail"));

    const report = await runDoctor(home);
    const byId = new Map(report.checks.map((item) => [item.id, item]));

    expect(report.ok).toBe(true);
    expect(byId.get("config")?.status).toBe("pass");
    expect(byId.get("roster")?.status).toBe("pass");
    expect(byId.get("store")?.status).toBe("pass");
    expect(byId.get("store")?.message).toContain("quick_check ok");
  });

  it("fails for missing home, invalid config and a corrupt store", async () => {
    const root = tempDir("am-doctor-failures");
    const missing = await runDoctor(path.join(root, "missing", ".agent-mail"));
    expect(missing.ok).toBe(false);
    expect(missing.checks[0]?.id).toBe("home");

    const invalidHome = svc.initProject(path.join(root, "invalid", ".agent-mail"));
    fs.writeFileSync(path.join(invalidHome, "config.json"), "{broken", "utf8");
    const invalid = await runDoctor(invalidHome);
    expect(invalid.ok).toBe(false);
    expect(invalid.checks.find((item) => item.id === "config")?.status).toBe(
      "fail",
    );

    const corruptHome = svc.initProject(path.join(root, "corrupt", ".agent-mail"));
    fs.writeFileSync(path.join(corruptHome, "store.sqlite"), "not sqlite", "utf8");
    const corrupt = await runDoctor(corruptHome);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.checks.find((item) => item.id === "store")?.status).toBe(
      "fail",
    );
  });

  it("checks runner PATH without making optional runners hard failures", () => {
    const directory = tempDir("am-doctor-runner");
    const executable = path.join(directory, "codex");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(checkRunnerBinary("codex", directory).status).toBe("pass");
    expect(checkRunnerBinary("grok", directory).status).toBe("warn");
    expect(checkRunnerBinary("antigravity", directory)).toMatchObject({
      id: "runner.antigravity",
      status: "warn",
      message: "agy CLI not found on PATH",
    });
  });

  it("checks only requested runners and resolves the Antigravity CLI as agy", async () => {
    const root = tempDir("am-doctor-antigravity");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    const executable = path.join(root, "agy");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const report = await runDoctor(home, { runners: ["codex", "antigravity"], pathEnv: root });
    expect(report.ok).toBe(true);
    expect(report.deep).toBe(true);
    expect(report.checks.filter((item) => item.id.startsWith("runner."))).toMatchObject([
      { id: "runner.codex", status: "warn" },
      { id: "runner.antigravity", status: "pass", message: expect.stringContaining(executable) },
    ]);
  });

  it("recognizes environment-only remote connection settings", async () => {
    const root = tempDir("am-doctor-env-connection");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    vi.stubEnv("AGENT_MAIL_HUB_URL", "http://127.0.0.1:7421");
    vi.stubEnv("AGENT_MAIL_HUB_TOKEN", "environment-only-token");

    const report = await runDoctor(home, { deep: true, pathEnv: "" });
    expect(
      report.checks.find((item) => item.id === "connection.config")?.status,
    ).toBe("pass");
    expect(
      report.checks.find((item) => item.id === "connection.token")?.status,
    ).toBe("pass");
    expect(JSON.stringify(report)).not.toContain("environment-only-token");
  });

  it("checks hashed token-store success and failure without printing hashes", async () => {
    const root = tempDir("am-doctor-token-store");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    const token = mintToken(home, "codex@local");

    const valid = await runDoctor(home, { deep: true, pathEnv: "" });
    const validCheck = valid.checks.find((item) => item.id === "tokens.store");
    expect(validCheck?.status).toBe("pass");
    expect(JSON.stringify(valid)).not.toContain(token);

    const tokenStore = path.join(home, "auth", "hub_tokens.json");
    const payload = JSON.parse(fs.readFileSync(tokenStore, "utf8")) as {
      tokens: Array<{ token_hash: string }>;
    };
    payload.tokens[0]!.token_hash = "invalid";
    fs.writeFileSync(tokenStore, `${JSON.stringify(payload)}\n`, "utf8");

    const invalid = await runDoctor(home, { deep: true, pathEnv: "" });
    expect(invalid.ok).toBe(false);
    expect(
      invalid.checks.find((item) => item.id === "tokens.store")?.status,
    ).toBe("fail");
    expect(JSON.stringify(invalid)).not.toContain(token);
  });

  it("fails an invalid configured CA without exposing token content", async () => {
    const root = tempDir("am-doctor-ca");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    const tokenFile = path.join(home, "client.token");
    const caFile = path.join(home, "ca.pem");
    fs.writeFileSync(tokenFile, "super-secret-bearer\n", { mode: 0o600 });
    fs.writeFileSync(caFile, "not a certificate\n", "utf8");
    setConnection(home, {
      hub_url: "https://localhost:7443",
      token_file: "client.token",
      ca_file: "ca.pem",
    });

    const report = await runDoctor(home, { deep: true, pathEnv: "" });
    const serialized = JSON.stringify(report);
    expect(report.ok).toBe(false);
    expect(
      report.checks.find((item) => item.id === "connection.certificate")?.status,
    ).toBe("fail");
    expect(serialized).not.toContain("super-secret-bearer");
  });

  it("probes HTTPS Hub health, certificate and bearer identity", async () => {
    const root = tempDir("am-doctor-hub");
    const hubHome = svc.initProject(path.join(root, "hub", ".agent-mail"));
    const clientHome = svc.initProject(path.join(root, "client", ".agent-mail"));
    const pem = makePemPair(root);
    const token = mintToken(hubHome, "codex@local");
    const tokenFile = path.join(clientHome, "hub.token");
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

    const hub = await listenHub({
      home: hubHome,
      host: "127.0.0.1",
      port: 0,
      tlsCertFile: pem.cert,
      tlsKeyFile: pem.key,
      requireAuth: true,
    });
    try {
      setConnection(clientHome, {
        hub_url: hub.url,
        token_file: "hub.token",
        ca_file: pem.cert,
      });
      const report = await runDoctor(clientHome, {
        deep: true,
        wake: true,
        pathEnv: "",
      });
      const byId = new Map(report.checks.map((item) => [item.id, item]));

      expect(report.ok).toBe(true);
      expect(byId.get("connection.certificate")?.status).toBe("pass");
      expect(byId.get("connection.token")?.status).toBe("pass");
      expect(byId.get("hub.health")?.status).toBe("pass");
      expect(byId.get("hub.auth")?.status).toBe("pass");
      expect(byId.get("hub.auth")?.message).toContain("codex@local");
      expect(JSON.stringify(report)).not.toContain(token);
    } finally {
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
    }
  });

  it("reports a bad bearer before claiming remote Hub health", async () => {
    const root = tempDir("am-doctor-auth");
    const hubHome = svc.initProject(path.join(root, "hub", ".agent-mail"));
    const clientHome = svc.initProject(path.join(root, "client", ".agent-mail"));
    mintToken(hubHome, "codex@local");
    fs.writeFileSync(path.join(clientHome, "hub.token"), "wrong-token\n", {
      mode: 0o600,
    });
    const hub = await listenHub({
      home: hubHome,
      host: "127.0.0.1",
      port: 0,
      requireAuth: true,
    });
    try {
      setConnection(clientHome, {
        hub_url: hub.url,
        token_file: "hub.token",
      });
      const report = await runDoctor(clientHome, {
        deep: true,
        wake: true,
        pathEnv: "",
      });
      const byId = new Map(report.checks.map((item) => [item.id, item]));

      expect(report.ok).toBe(false);
      expect(byId.get("hub.health")?.status).toBe("fail");
      expect(byId.get("hub.auth")?.status).toBe("fail");
      expect(JSON.stringify(report)).not.toContain("wrong-token");
    } finally {
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
    }
  });

  it("reports an unreachable remote Hub as a hard failure", async () => {
    const root = tempDir("am-doctor-hub-down");
    const home = svc.initProject(path.join(root, ".agent-mail"));
    const report = await runDoctor(home, {
      deep: true,
      wake: true,
      hubUrl: "http://127.0.0.1:1",
      pathEnv: "",
      timeoutMs: 250,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((item) => item.id === "hub.health")?.status).toBe(
      "fail",
    );
  });

  it("CLI emits JSON and preserves exit code 3 on doctor failure", () => {
    const root = tempDir("am-doctor-cli");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "doctor",
        "--path",
        root,
        "--json",
      ],
      {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(3);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "home", status: "fail" });
  });
});
