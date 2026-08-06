import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as svc from "../src/services.js";
import {
  buildOverviewSnapshot,
  renderTui,
  runTui,
  sanitizeTerminalText,
  supportsInteractiveTui,
  TuiModel,
  type TuiInput,
  type TuiOutput,
} from "../src/tui.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function tempProject(label: string): { root: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return {
    root,
    home: svc.initProject(path.join(root, ".agent-mail")),
  };
}

function typeKeys(model: TuiModel, value: string): void {
  for (const character of value) model.handleKey(character);
}

function fakeTerminal(): {
  input: TuiInput;
  output: TuiOutput;
  inputEvents: EventEmitter;
  writes: string[];
  rawModes: boolean[];
} {
  const inputEvents = new EventEmitter();
  const outputEvents = new EventEmitter();
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  const input: TuiInput = {
    isTTY: true,
    setRawMode(enabled) {
      rawModes.push(enabled);
    },
    resume() {},
    pause() {},
    on(event, listener) {
      inputEvents.on(event, listener);
      return this;
    },
    off(event, listener) {
      inputEvents.off(event, listener);
      return this;
    },
  };
  const output: TuiOutput = {
    isTTY: true,
    columns: 100,
    rows: 30,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    on(event, listener) {
      outputEvents.on(event, listener);
      return this;
    },
    off(event, listener) {
      outputEvents.off(event, listener);
      return this;
    },
  };
  return { input, output, inputEvents, writes, rawModes };
}

describe("TUI S1 operations console", () => {
  it("requires both TTY streams, raw mode, and a known terminal", () => {
    const terminal = fakeTerminal();
    expect(
      supportsInteractiveTui({
        input: terminal.input,
        output: terminal.output,
        env: { TERM: "xterm-256color" },
      }),
    ).toBe(true);
    expect(
      supportsInteractiveTui({
        input: { ...terminal.input, isTTY: false },
        output: terminal.output,
        env: { TERM: "xterm-256color" },
      }),
    ).toBe(false);
    expect(
      supportsInteractiveTui({
        input: terminal.input,
        output: terminal.output,
        env: { TERM: "unknown-terminal" },
      }),
    ).toBe(false);
  });

  it("builds Overview without moving an existing outbox cursor", () => {
    const { home } = tempProject("am-tui-overview");
    svc.send({
      from_id: "claude-code@local",
      to: "codex@local",
      type: "task",
      body: "body must not enter the TUI",
      effect: "read",
      home,
    });
    const event = svc.listOutboxEvents("codex@local", { home })[0]!;
    svc.ackOutbox("wake:codex:test", "codex@local", event.sequence, { home });
    const store = svc.getStore(home);
    const before = store.getOutboxCursor("wake:codex:test", "codex@local");

    const snapshot = buildOverviewSnapshot(home);

    expect(snapshot.counts.outbox_events).toBe(1);
    expect(snapshot.counts.messages).toBe(1);
    expect(
      store.getOutboxCursor("wake:codex:test", "codex@local"),
    ).toBe(before);
    expect(JSON.stringify(snapshot)).not.toContain("body must not enter");
  });

  it("writes Settings through the same config service", () => {
    const { home } = tempProject("am-tui-settings");
    const model = new TuiModel(home);
    model.handleKey("2");
    expect(model.page).toBe("settings");

    model.selectedIndex = 0;
    model.handleKey("enter");
    typeKeys(model, "120");
    model.handleKey("enter");

    expect(svc.configGet("project.lease_seconds", { home }).value).toBe(120);
    expect(model.status).toContain("Updated project.lease_seconds=120");

    model.selectedIndex = 1;
    model.handleKey("enter");
    expect(
      svc.configGet("policy.default_execution_mode", { home }).value,
    ).toBe("view-only");
    expect(model.status).toContain(
      "Updated policy.default_execution_mode=view-only",
    );
  });

  it("keeps a settings failure visible across automatic refreshes", () => {
    const { home } = tempProject("am-tui-settings-error");
    fs.writeFileSync(path.join(home, "policy.yaml"), "{broken", "utf8");
    const model = new TuiModel(home);

    expect(model.status).toContain("Settings unavailable");
    model.refresh();
    expect(model.status).toContain("Settings unavailable");
    expect(model.settings).toEqual([]);
  });

  it("does not write high-risk changes without an exact key confirmation", () => {
    const { home } = tempProject("am-tui-confirm");
    const model = new TuiModel(home);
    model.handleKey("2");
    model.selectedIndex = 3;

    model.handleKey("enter");
    typeKeys(model, "{}");
    model.handleKey("enter");
    expect(model.inputMode).toBe("confirm");
    expect(
      svc.configGet("policy.effect_rules", { home }).value,
    ).not.toEqual({});

    typeKeys(model, "wrong");
    model.handleKey("enter");
    expect(model.status).toContain("did not match");
    expect(
      svc.configGet("policy.effect_rules", { home }).value,
    ).not.toEqual({});

    model.handleKey("enter");
    typeKeys(model, "{}");
    model.handleKey("enter");
    typeKeys(model, "policy.effect_rules");
    model.handleKey("enter");
    expect(svc.configGet("policy.effect_rules", { home }).value).toEqual({});
  });

  it("redacts credential text and ignores runtime-log payloads", () => {
    const snapshot = buildOverviewSnapshot("/tmp/example/.agent-mail", () => ({
      home: "/tmp/example/.agent-mail",
      home_exists: true,
      implementation: "typescript",
      version: "test",
      agents: [],
      database: {
        integrity: ["ok"],
        counts: {},
        delivery_statuses: {},
      },
      runtime_logs: [
        {
          error: "authorization=top-secret-value",
          body: "message-body-secret",
        },
      ],
      warnings: ["\u001b[31mauthorization=top-secret-value\u001b[0m"],
    }));
    expect(JSON.stringify(snapshot)).not.toContain("message-body-secret");

    const { home } = tempProject("am-tui-render");
    const model = new TuiModel(home);
    model.overview = snapshot;
    const overviewRendered = renderTui(model, { columns: 100, rows: 30 });
    expect(overviewRendered).not.toContain("top-secret-value");
    expect(overviewRendered).toContain("authorization=<redacted>");

    model.handleKey("2");
    model.selectedIndex = 3;
    model.settings[3] = {
      ...model.settings[3],
      value: {
        write: "requires_human_approval",
        token: "nested-object-secret",
      },
    };
    const rendered = renderTui(model, { columns: 100, rows: 30 });
    expect(rendered).not.toContain("nested-object-secret");
    expect(rendered).toContain('"token":"<redacted>"');
    expect(sanitizeTerminalText("\u001b[31mhello\u001b[0m")).toBe("hello");
  });

  it("fails fast with CLI alternatives when stdin/stdout are not TTYs", () => {
    const { root } = tempProject("am-tui-nontty");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "tui",
        "--path",
        root,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("requires a supported interactive terminal");
    expect(result.stderr).toContain("agent-mail diagnose --json");
    expect(result.stderr).toContain("agent-mail config list --json");
  });

  it("enters the alternate screen and always restores terminal state on quit", async () => {
    const { home } = tempProject("am-tui-terminal");
    const terminal = fakeTerminal();
    const running = runTui(home, {
      input: terminal.input,
      output: terminal.output,
      env: { TERM: "xterm-256color" },
    });
    terminal.inputEvents.emit("data", "q");
    await running;

    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.writes.join("")).toContain("\u001b[?1049h");
    expect(terminal.writes.join("")).toContain("\u001b[?1049l");
  });
});
