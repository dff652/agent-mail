import path from "node:path";

import { AgentMailError } from "./errors.js";
import {
  redactSensitiveText,
  redactSensitiveValue,
} from "./observability.js";
import * as svc from "./services.js";

const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l";
const LEAVE_SCREEN = "\u001b[?25h\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[H\u001b[2J";
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const INVERSE = "\u001b[7m";
// Terminal sanitization intentionally matches control bytes.
const ANSI_SEQUENCE = new RegExp(
  // eslint-disable-next-line no-control-regex
  "\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001b\\\\))",
  "g",
);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");
// eslint-disable-next-line no-control-regex
const ANSI_COLOR = new RegExp("\\u001b\\[[0-9;]*m", "g");

type SettingItem = ReturnType<typeof svc.configList>[number];
type TuiPage = "overview" | "settings";
type InputMode = "normal" | "edit" | "confirm";

export interface TuiInput {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  off(event: "data", listener: (chunk: Buffer | string) => void): this;
}

export interface TuiOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): boolean;
  on(event: "resize", listener: () => void): this;
  off(event: "resize", listener: () => void): this;
}

export interface TuiTerminal {
  input: TuiInput;
  output: TuiOutput;
  env: NodeJS.ProcessEnv;
}

export interface OverviewSnapshot {
  home: string;
  homeExists: boolean;
  implementation: string;
  version: string;
  agents: string[];
  integrity: string[];
  journalMode: string;
  userVersion: number | null;
  counts: Record<string, number>;
  deliveryStatuses: Record<string, number>;
  runtimeLogCount: number;
  warnings: string[];
}

interface TuiDataSource {
  diagnose(home: string): Record<string, unknown>;
  listSettings(home: string): SettingItem[];
  setSetting(home: string, key: string, rawValue: string): SettingItem;
  settingWarnings(key: string): string[];
}

const defaultSource: TuiDataSource = {
  diagnose: (home) => svc.diagnose({ home }),
  listSettings: (home) => svc.configList({ home }),
  setSetting: (home, key, rawValue) =>
    svc.configSet(key, rawValue, { home }),
  settingWarnings: (key) => svc.configWarnings(key),
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(value))
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * Build the Overview from the existing diagnose control-plane result only.
 * This function deliberately has no outbox consumer id and never calls ack.
 */
export function buildOverviewSnapshot(
  home: string,
  diagnose: (home: string) => Record<string, unknown> = defaultSource.diagnose,
): OverviewSnapshot {
  const report = diagnose(path.resolve(home));
  const database = record(report.database);
  return {
    home: String(report.home ?? path.resolve(home)),
    homeExists: report.home_exists === true,
    implementation: String(report.implementation ?? "unknown"),
    version: String(report.version ?? "unknown"),
    agents: stringArray(report.agents),
    integrity: stringArray(database.integrity),
    journalMode: String(database.journal_mode ?? "unknown"),
    userVersion:
      typeof database.user_version === "number"
        ? database.user_version
        : null,
    counts: numberRecord(database.counts),
    deliveryStatuses: numberRecord(database.delivery_statuses),
    runtimeLogCount: Array.isArray(report.runtime_logs)
      ? report.runtime_logs.length
      : 0,
    warnings: stringArray(report.warnings),
  };
}

export function supportsInteractiveTui(
  terminal: Pick<TuiTerminal, "input" | "output" | "env">,
): boolean {
  if (
    terminal.input.isTTY !== true ||
    terminal.output.isTTY !== true ||
    typeof terminal.input.setRawMode !== "function"
  ) {
    return false;
  }
  const term = (terminal.env.TERM ?? "").trim().toLowerCase();
  return /^(alacritty|ansi|cygwin|eterm|foot|kitty|konsole|linux|rxvt|screen|st(?:-|$)|tmux|vt100|wezterm|xterm)/.test(term);
}

export function sanitizeTerminalText(value: unknown): string {
  const withoutAnsi = String(value).replace(ANSI_SEQUENCE, "");
  return redactSensitiveText(withoutAnsi)
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactJson(value: unknown): string {
  const redacted = redactSensitiveValue(value);
  return typeof redacted === "string" ? redacted : JSON.stringify(redacted);
}

function settingInput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function truncate(value: unknown, width: number): string {
  const clean = sanitizeTerminalText(value);
  if (width <= 1) return clean.slice(0, Math.max(width, 0));
  const characters = Array.from(clean);
  return characters.length <= width
    ? clean
    : `${characters.slice(0, width - 1).join("")}…`;
}

function decodeChunk(chunk: Buffer | string): string[] {
  const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  const keys: string[] = [];
  for (let index = 0; index < raw.length; ) {
    const remaining = raw.slice(index);
    const arrow = [
      ["\u001b[A", "up"],
      ["\u001b[B", "down"],
      ["\u001b[C", "right"],
      ["\u001b[D", "left"],
    ].find(([sequence]) => remaining.startsWith(sequence));
    if (arrow) {
      keys.push(arrow[1]);
      index += arrow[0].length;
      continue;
    }
    const character = raw[index]!;
    if (character === "\r" || character === "\n") keys.push("enter");
    else if (character === "\u0003") keys.push("ctrl-c");
    else if (character === "\u001b") keys.push("escape");
    else if (character === "\u007f" || character === "\b") keys.push("backspace");
    else keys.push(character);
    index += 1;
  }
  return keys;
}

export class TuiModel {
  readonly home: string;
  page: TuiPage = "overview";
  overview: OverviewSnapshot;
  settings: SettingItem[] = [];
  selectedIndex = 0;
  inputMode: InputMode = "normal";
  inputBuffer = "";
  pendingValue: { key: string; rawValue: string } | null = null;
  status = "Ready";
  helpVisible = false;

  constructor(
    home: string,
    private readonly source: TuiDataSource = defaultSource,
  ) {
    this.home = path.resolve(home);
    this.overview = buildOverviewSnapshot(this.home, source.diagnose);
    this.refreshSettings();
  }

  refresh(): void {
    this.overview = buildOverviewSnapshot(this.home, this.source.diagnose);
    if (this.refreshSettings()) {
      this.status = `Refreshed ${new Date().toISOString().slice(11, 19)} UTC`;
    }
  }

  private refreshSettings(): boolean {
    if (!this.overview.homeExists) {
      this.settings = [];
      this.selectedIndex = 0;
      return true;
    }
    try {
      this.settings = this.source.listSettings(this.home);
      this.selectedIndex = Math.min(
        this.selectedIndex,
        Math.max(this.settings.length - 1, 0),
      );
      return true;
    } catch (error) {
      this.settings = [];
      this.selectedIndex = 0;
      this.status = `Settings unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return false;
    }
  }

  private selectedSetting(): SettingItem | undefined {
    return this.settings[this.selectedIndex];
  }

  selectedSettingWarnings(): string[] {
    const item = this.selectedSetting();
    return item ? this.source.settingWarnings(item.key) : [];
  }

  private queueValue(item: SettingItem, rawValue: string): void {
    if (item.danger === "high") {
      this.pendingValue = { key: item.key, rawValue };
      this.inputMode = "confirm";
      this.inputBuffer = "";
      this.status = `High-risk change: type ${item.key} to confirm`;
      return;
    }
    this.applyValue(item.key, rawValue);
  }

  private applyValue(key: string, rawValue: string): void {
    const updated = this.source.setSetting(this.home, key, rawValue);
    this.refreshSettings();
    this.selectedIndex = Math.max(
      this.settings.findIndex((item) => item.key === key),
      0,
    );
    const warnings = this.source.settingWarnings(key);
    this.status = `Updated ${key}=${compactJson(updated.value)}${
      warnings.length > 0 ? `; warning: ${warnings.join("; ")}` : ""
    }`;
    this.inputMode = "normal";
    this.inputBuffer = "";
    this.pendingValue = null;
  }

  private beginEdit(): void {
    const item = this.selectedSetting();
    if (!item || !item.writable) {
      this.status = item ? `${item.key} is read-only` : "No setting selected";
      return;
    }
    if (item.type === "enum") {
      const values = item.values ?? [];
      const current = values.indexOf(String(item.value));
      const next = values[(current + 1 + values.length) % values.length];
      if (next !== undefined) this.queueValue(item, next);
      return;
    }
    if (item.type === "bool") {
      this.queueValue(item, String(item.value !== true));
      return;
    }
    this.inputMode = "edit";
    this.inputBuffer = "";
    this.status = `Enter replacement for ${item.key}; current=${compactJson(item.value)}`;
  }

  private restoreDefault(): void {
    const item = this.selectedSetting();
    if (!item || !item.writable) {
      this.status = item ? `${item.key} is read-only` : "No setting selected";
      return;
    }
    this.queueValue(item, settingInput(item.default));
  }

  private handlePromptKey(key: string): boolean {
    if (key === "escape") {
      this.inputMode = "normal";
      this.inputBuffer = "";
      this.pendingValue = null;
      this.status = "Change cancelled";
      return false;
    }
    if (key === "backspace") {
      this.inputBuffer = Array.from(this.inputBuffer).slice(0, -1).join("");
      return false;
    }
    if (key === "enter") {
      if (this.inputMode === "edit") {
        const item = this.selectedSetting();
        if (!item) return false;
        if (this.inputBuffer.length === 0) {
          this.status = "Empty input; change cancelled";
          this.inputMode = "normal";
          return false;
        }
        this.queueValue(item, this.inputBuffer);
        return false;
      }
      const pending = this.pendingValue;
      if (!pending) {
        this.inputMode = "normal";
        return false;
      }
      if (this.inputBuffer !== pending.key) {
        this.status = "Confirmation did not match; no change written";
        this.inputMode = "normal";
        this.inputBuffer = "";
        this.pendingValue = null;
        return false;
      }
      this.applyValue(pending.key, pending.rawValue);
      return false;
    }
    if (
      key.length === 1 &&
      key >= " " &&
      key !== "\u007f" &&
      this.inputBuffer.length < 4096
    ) {
      this.inputBuffer += key;
    }
    return false;
  }

  handleKey(key: string): boolean {
    try {
      if (this.inputMode !== "normal") return this.handlePromptKey(key);
      if (key === "q" || key === "ctrl-c") return true;
      if (key === "escape") {
        if (this.helpVisible) this.helpVisible = false;
        else return true;
        return false;
      }
      if (key === "?") {
        this.helpVisible = !this.helpVisible;
        return false;
      }
      if (key === "1") {
        this.page = "overview";
        return false;
      }
      if (key === "2") {
        this.page = "settings";
        return false;
      }
      if (key === "r") {
        this.refresh();
        return false;
      }
      if (this.page !== "settings") return false;
      if (key === "up" || key === "k") {
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      } else if (key === "down" || key === "j") {
        this.selectedIndex = Math.min(
          this.selectedIndex + 1,
          Math.max(this.settings.length - 1, 0),
        );
      } else if (key === "g") {
        this.selectedIndex = 0;
      } else if (key === "G") {
        this.selectedIndex = Math.max(this.settings.length - 1, 0);
      } else if (key === "enter" || key === " " || key === "right") {
        this.beginEdit();
      } else if (key === "d") {
        this.restoreDefault();
      }
      return false;
    } catch (error) {
      this.inputMode = "normal";
      this.inputBuffer = "";
      this.pendingValue = null;
      this.status = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return false;
    }
  }
}

function renderHeader(model: TuiModel, width: number): string[] {
  const overview =
    model.page === "overview"
      ? `${INVERSE}${BOLD}[1] Overview${RESET}`
      : `${CYAN}[1] Overview${RESET}`;
  const settings =
    model.page === "settings"
      ? `${INVERSE}${BOLD}[2] Settings${RESET}`
      : `${CYAN}[2] Settings${RESET}`;
  return [
    `${BOLD}Agent Mail Operations Console${RESET}`,
    `${overview}  ${settings}`,
    `${DIM}${truncate(model.home, width)}${RESET}`,
    "",
  ];
}

function renderOverview(model: TuiModel, width: number): string[] {
  const item = model.overview;
  const counts = Object.entries(item.counts)
    .map(([key, value]) => `${key}=${value}`)
    .join("  ");
  const delivery = Object.entries(item.deliveryStatuses)
    .map(([key, value]) => `${key}=${value}`)
    .join("  ");
  const integrityOk =
    item.integrity.length === 1 && item.integrity[0] === "ok";
  const status = item.homeExists
    ? `${GREEN}initialized${RESET}`
    : `${RED}missing${RESET}`;
  const lines = [
    `${BOLD}Overview${RESET}`,
    `Home          ${status}`,
    `Runtime       ${truncate(`${item.implementation} ${item.version}`, width - 14)}`,
    `Agents        ${item.agents.length}${
      item.agents.length > 0 ? ` (${truncate(item.agents.join(", "), width - 20)})` : ""
    }`,
    `Database      ${
      integrityOk ? `${GREEN}quick_check ok${RESET}` : `${RED}${truncate(item.integrity.join("; "), width - 18)}${RESET}`
    }`,
    `SQLite        journal=${truncate(item.journalMode, 12)} schema=${item.userVersion ?? "unknown"}`,
    `Counts        ${truncate(counts || "unavailable", width - 14)}`,
    `Deliveries    ${truncate(delivery || "none", width - 14)}`,
    `Runtime logs  ${item.runtimeLogCount} redacted evidence entries loaded`,
    `Warnings      ${
      item.warnings.length === 0
        ? `${GREEN}0${RESET}`
        : `${YELLOW}${item.warnings.length}${RESET}`
    }`,
  ];
  for (const warning of item.warnings.slice(0, 3)) {
    lines.push(`  ${YELLOW}!${RESET} ${truncate(warning, width - 4)}`);
  }
  return lines;
}

function renderSettings(model: TuiModel, width: number): string[] {
  const lines = [`${BOLD}Settings${RESET}`];
  if (!model.overview.homeExists) {
    lines.push(
      `${RED}Project is not initialized.${RESET}`,
      "Run: agent-mail init --path <project>",
    );
    return lines;
  }
  if (model.settings.length === 0) {
    lines.push(`${RED}No settings available.${RESET}`);
    return lines;
  }
  let group = "";
  for (const [index, item] of model.settings.entries()) {
    if (item.group !== group) {
      group = item.group;
      lines.push("", `${BOLD}${truncate(group, width)}${RESET}`);
    }
    const selected = index === model.selectedIndex;
    const danger =
      item.danger === "high"
        ? `${RED}HIGH${RESET}`
        : item.danger === "medium"
          ? `${YELLOW}MED${RESET}`
          : `${DIM}LOW${RESET}`;
    const value = truncate(compactJson(item.value), Math.max(width - 39, 12));
    const row = `${selected ? ">" : " "} ${truncate(item.key, 32).padEnd(32)} ${value}  ${danger}`;
    lines.push(selected ? `${INVERSE}${row}${RESET}` : row);
    if (selected) {
      lines.push(`    ${DIM}${truncate(item.summary, width - 6)}${RESET}`);
      for (const warning of model.selectedSettingWarnings()) {
        lines.push(
          `    ${YELLOW}warning: ${truncate(warning, width - 15)}${RESET}`,
        );
      }
    }
  }
  return lines;
}

function renderFooter(model: TuiModel, width: number): string[] {
  const lines = ["", `${DIM}${truncate(model.status, width)}${RESET}`];
  if (model.inputMode === "edit") {
    lines.push(
      `${CYAN}new value>${RESET} ${truncate(model.inputBuffer, width - 12)}${BOLD}_${RESET}`,
      `${DIM}Enter apply · Esc cancel${RESET}`,
    );
  } else if (model.inputMode === "confirm") {
    lines.push(
      `${RED}confirm key>${RESET} ${truncate(model.inputBuffer, width - 14)}${BOLD}_${RESET}`,
      `${DIM}Type the full setting key · Enter confirm · Esc cancel${RESET}`,
    );
  } else {
    lines.push(
      `${DIM}1/2 page · ↑/↓ or j/k · Enter edit/cycle · d default · r refresh · ? help · q quit${RESET}`,
    );
  }
  if (model.helpVisible) {
    lines.push(
      "",
      `${BOLD}Safety boundaries${RESET}`,
      "• Settings writes call the same locked config service as the CLI.",
      "• Overview reads diagnose() only; it never consumes or acknowledges outbox events.",
      "• High-risk values require typing the full setting key.",
      "• Inbox/chat/send/claim/ack and agent execution are intentionally absent.",
    );
  }
  return lines;
}

export function renderTui(
  model: TuiModel,
  options: { columns?: number; rows?: number } = {},
): string {
  const width = Math.max(options.columns ?? 80, 40);
  const height = Math.max(options.rows ?? 24, 12);
  const content = [
    ...renderHeader(model, width),
    ...(model.page === "overview"
      ? renderOverview(model, width)
      : renderSettings(model, width)),
    ...renderFooter(model, width),
  ];
  const visible = content
    .slice(0, height)
    .map((line) => truncateAnsiAware(line, width));
  return `${CLEAR_SCREEN}${visible.join("\n")}`;
}

function truncateAnsiAware(line: string, width: number): string {
  const plain = line.replace(ANSI_COLOR, "");
  if (Array.from(plain).length <= width) return line;
  return `${truncate(plain, width)}${RESET}`;
}

export async function runTui(
  home: string,
  terminal: TuiTerminal = {
    input: process.stdin,
    output: process.stdout,
    env: process.env,
  },
): Promise<void> {
  if (!supportsInteractiveTui(terminal)) {
    throw new AgentMailError(
      "agent-mail tui requires a supported interactive terminal; " +
        "use `agent-mail diagnose --json` and `agent-mail config list --json` in pipes, CI, or non-interactive SSH",
      2,
    );
  }

  const model = new TuiModel(home);
  const { input, output } = terminal;
  const draw = () =>
    output.write(
      renderTui(model, {
        columns: output.columns,
        rows: output.rows,
      }),
    );

  await new Promise<void>((resolve, reject) => {
    let stopped = false;
    const refreshTimer = setInterval(() => {
      try {
        model.refresh();
        draw();
      } catch (error) {
        model.status = `Refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        draw();
      }
    }, 2_000);
    refreshTimer.unref();

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(refreshTimer);
      input.off("data", onData);
      output.off("resize", draw);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      input.setRawMode?.(false);
      input.pause();
      output.write(LEAVE_SCREEN);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      try {
        for (const key of decodeChunk(chunk)) {
          if (model.handleKey(key)) {
            finish();
            return;
          }
        }
        draw();
      } catch (error) {
        fail(error);
      }
    };
    const onSigint = () => {
      process.exitCode = 130;
      finish();
    };
    const onSigterm = () => {
      process.exitCode = 143;
      finish();
    };

    try {
      output.write(ENTER_SCREEN);
      input.setRawMode?.(true);
      input.resume();
      input.on("data", onData);
      output.on("resize", draw);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      draw();
    } catch (error) {
      fail(error);
    }
  });
}
