import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { atomicWriteText } from "./atomic-file.js";
import { withHubStateLock } from "./hub/auth.js";

export interface AgentRecord {
  id: string;
  display_name: string;
  skills: string[];
  /** Ownership of one guarded enrollment; omitted on ordinary registrations. */
  enrollment_generation?: string;
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

function saveRosterUnlocked(home: string, roster: Roster): void {
  const p = path.join(home, "agents.json");
  atomicWriteText(p, JSON.stringify(roster, null, 2) + "\n", 0o644);
}

export function saveRoster(home: string, roster: Roster): void {
  withHubStateLock(home, () => saveRosterUnlocked(home, roster));
}

export function rosterHas(roster: Roster, id: string): boolean {
  return roster.agents.some((a) => a.id === id);
}

/** Add agent if missing; returns true if a new agent was appended. */
export function ensureAgent(
  home: string,
  agent: AgentRecord,
): boolean {
  return withHubStateLock(home, () => ensureAgentLocked(home, agent));
}

/** Add an agent while the shared Hub state lock is already held. */
export function ensureAgentLocked(
  home: string,
  agent: AgentRecord,
  enrollmentGeneration?: string,
): boolean {
  const roster = loadRoster(home);
  if (rosterHas(roster, agent.id)) return false;
  const next = { ...agent };
  // Ordinary remove/re-add must not inherit an earlier enrollment's ownership.
  if (enrollmentGeneration) next.enrollment_generation = enrollmentGeneration;
  else delete next.enrollment_generation;
  roster.agents.push(next);
  roster.updated_at = new Date().toISOString();
  saveRosterUnlocked(home, roster);
  return true;
}

/** Remove agent by id; returns true if removed. */
export function removeAgent(home: string, agentId: string): boolean {
  return withHubStateLock(home, () => removeAgentLocked(home, agentId));
}

/** Remove an agent while the shared Hub state lock is already held. */
export function removeAgentLocked(home: string, agentId: string): boolean {
  const roster = loadRoster(home);
  const before = roster.agents.length;
  roster.agents = roster.agents.filter((a) => a.id !== agentId);
  if (roster.agents.length === before) return false;
  roster.updated_at = new Date().toISOString();
  saveRosterUnlocked(home, roster);
  return true;
}

/**
 * Compare this identity's generation and complete record. Unrelated directory
 * changes must not invalidate another identity's enrollment.
 */
export function removeAgentIfOwnedLocked(
  home: string,
  agentId: string,
  expectedGeneration: string,
  expectedAgent: AgentRecord,
): boolean {
  const roster = loadRoster(home);
  const current = roster.agents.find((agent) => agent.id === agentId);
  if (!current) return true;
  if (
    current.enrollment_generation !== expectedGeneration ||
    !isDeepStrictEqual(current, expectedAgent)
  ) {
    return false;
  }
  roster.agents = roster.agents.filter((agent) => agent.id !== agentId);
  roster.updated_at = new Date().toISOString();
  saveRosterUnlocked(home, roster);
  return true;
}
