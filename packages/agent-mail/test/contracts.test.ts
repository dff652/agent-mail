import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AgentMailError } from "../src/errors.js";
import type { Message } from "../src/models.js";
import * as svc from "../src/services.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const CONTRACTS = path.join(REPO, "contracts");
const MANIFEST = path.join(CONTRACTS, "manifest.json");

type Fixture = {
  id: string;
  steps: Array<Record<string, unknown>>;
};

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function fixturePaths(): string[] {
  const manifest = loadJson<{ fixtures: string[] }>(MANIFEST);
  return manifest.fixtures.map((rel) => path.join(CONTRACTS, rel));
}

function runFixture(home: string, fixture: Fixture): void {
  const refs: Record<string, Message> = {};

  for (const step of fixture.steps) {
    const op = step.op as string;
    if (op === "send") {
      const call = (): Message =>
        svc.send({
          from_id: step.from as string,
          to: step.to as string,
          type: step.type as string,
          body: step.body as string,
          home,
          effect: (step.effect as string) ?? "none",
          thread_id: step.thread_from
            ? refs[step.thread_from as string].thread_id
            : null,
          task_id: step.task_from
            ? refs[step.task_from as string].task_id
            : null,
        });
      if (step.expect_error) {
        const exp = step.expect_error as { match: string; exit_code?: number };
        try {
          call();
          throw new Error("expected send to fail");
        } catch (e) {
          expect(e).toBeInstanceOf(AgentMailError);
          expect(String(e)).toMatch(new RegExp(exp.match, "i"));
          if (exp.exit_code !== undefined) {
            expect((e as AgentMailError).exitCode).toBe(exp.exit_code);
          }
        }
        continue;
      }
      const msg = call();
      if (step.save_as) refs[step.save_as as string] = msg;
      continue;
    }
    if (op === "approve" || op === "reject") {
      const taskId = refs[step.task_ref as string].task_id!;
      const approval = svc.getApprovalForTask(taskId, { home });
      expect(approval).not.toBeNull();
      const actor = (step.actor as string) ?? "human@local";
      const decided =
        op === "approve"
          ? svc.approve(String(approval!.id), actor, { home })
          : svc.reject(String(approval!.id), actor, { home });
      expect(decided.status).toBe(op === "approve" ? "approved" : "rejected");
      continue;
    }
    if (op === "inbox") {
      const items = svc.inbox(step.agent as string, { home });
      expect(items.length).toBe(step.expect_count as number);
      continue;
    }
    if (op === "claim") {
      const mid = refs[step.message_ref as string].id;
      const agent = step.agent as string;
      if (step.expect_error) {
        const exp = step.expect_error as { match: string; exit_code?: number };
        try {
          svc.claim(mid, agent, { home });
          throw new Error("expected claim to fail");
        } catch (e) {
          expect(e).toBeInstanceOf(AgentMailError);
          expect(String(e)).toMatch(new RegExp(exp.match, "i"));
          if (exp.exit_code !== undefined) {
            expect((e as AgentMailError).exitCode).toBe(exp.exit_code);
          }
        }
      } else {
        const d = svc.claim(mid, agent, { home });
        expect(d.status).toBe(step.expect_status);
      }
      continue;
    }
    if (op === "ack") {
      const mid = refs[step.message_ref as string].id;
      const agent = step.agent as string;
      if (step.expect_error) {
        const exp = step.expect_error as { match: string; exit_code?: number };
        try {
          svc.ack(mid, agent, { home });
          throw new Error("expected ack to fail");
        } catch (e) {
          expect(e).toBeInstanceOf(AgentMailError);
          expect(String(e)).toMatch(new RegExp(exp.match, "i"));
          if (exp.exit_code !== undefined) {
            expect((e as AgentMailError).exitCode).toBe(exp.exit_code);
          }
        }
      } else {
        const d = svc.ack(mid, agent, { home });
        expect(d.status).toBe(step.expect_status);
      }
      continue;
    }
    if (op === "assert") {
      const check = step.check as string;
      const msg = refs[step.ref as string];
      if (check === "message_type") {
        expect(msg.type).toBe(step.expect);
      } else if (check === "task_status") {
        expect(svc.taskStatus(msg.task_id!, { home })).toBe(step.expect);
      } else if (check === "thread_types") {
        const thread = svc.tail({ home, threadId: msg.thread_id });
        expect(thread.map((m) => m.type)).toEqual(step.expect);
      } else if (check === "delivery_status") {
        const items = svc.inbox(step.agent as string, { home, allItems: true });
        const item = items.find((i) => i.message.id === msg.id);
        expect(item?.delivery.status).toBe(step.expect);
      } else if (check === "requires_human_approval") {
        expect(msg.requires_human_approval).toBe(step.expect);
      } else if (check === "approval_status") {
        const approval = svc.getApprovalForTask(msg.task_id!, { home });
        expect(approval?.status ?? null).toBe(step.expect);
      } else {
        throw new Error(`unknown assert ${check}`);
      }
      continue;
    }
    throw new Error(`unknown op ${op}`);
  }
}

describe("R0 lifecycle contracts (TypeScript runner)", () => {
  for (const p of fixturePaths()) {
    const stem = path.basename(p, ".json");
    it(stem, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-ts-"));
      const home = svc.initProject(path.join(dir, ".agent-mail"));
      const fixture = loadJson<Fixture>(p);
      runFixture(home, fixture);
    });
  }
});
