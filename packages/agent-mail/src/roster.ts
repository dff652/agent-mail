import fs from "node:fs";
import path from "node:path";

import { atomicWriteText } from "./atomic-file.js";

export interface AgentRecord {
  id: string;
  display_name: string;
  skills: string[];
}

export interface Roster {
  version: number;
  updated_at: string;
  agents: AgentRecord[];
}

export const DEFAULT_AGENTS: AgentRecord[] = [
  { id: "claude-code@local", display_name: "Claude Code", skills: ["implement", "refactor"] },
  { id: "codex@local", display_name: "Codex", skills: ["review", "long-task"] },
  { id: "grok@local", display_name: "Grok", skills: ["review", "research"] },
  { id: "human@local", display_name: "Human", skills: ["decide", "escalate"] },
];

export function defaultRoster(): Roster {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    agents: [...DEFAULT_AGENTS],
  };
}

export function loadRoster(home: string): Roster {
  const p = path.join(home, "agents.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Roster;
}

export function saveRoster(home: string, roster: Roster): void {
  const p = path.join(home, "agents.json");
  atomicWriteText(p, JSON.stringify(roster, null, 2) + "\n", 0o644);
}

export function rosterHas(roster: Roster, id: string): boolean {
  return roster.agents.some((a) => a.id === id);
}

/** Add agent if missing; returns true if a new agent was appended. */
export function ensureAgent(
  home: string,
  agent: AgentRecord,
): boolean {
  const roster = loadRoster(home);
  if (rosterHas(roster, agent.id)) return false;
  roster.agents.push(agent);
  roster.updated_at = new Date().toISOString();
  saveRoster(home, roster);
  return true;
}

/** Remove agent by id; returns true if removed. */
export function removeAgent(home: string, agentId: string): boolean {
  const roster = loadRoster(home);
  const before = roster.agents.length;
  roster.agents = roster.agents.filter((a) => a.id !== agentId);
  if (roster.agents.length === before) return false;
  roster.updated_at = new Date().toISOString();
  saveRoster(home, roster);
  return true;
}
