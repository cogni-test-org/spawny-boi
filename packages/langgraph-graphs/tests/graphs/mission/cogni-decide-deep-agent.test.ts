// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LANGGRAPH_CATALOG } from "../../../src/catalog";
import { COGNI_DECIDE_TOOL_IDS } from "../../../src/graphs/mission/cogni-decide";
import { RunReceipts } from "../../../src/graphs/work-prioritizer/receipts";
import { createScoresGuard } from "../../../src/graphs/work-prioritizer/score-guard";

const origin = "https://node.example";
const guidance = ["mission", "goals"];
const source = `${origin}/knowledge/evidence`;
const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "task",
  status: "needs_implement",
  revision: 7,
  createdAt: new Date().toISOString(),
  labels: ["goal:delivery"],
  summary: `Evidence ${source}`,
  scores: {
    goal: { v: 1 },
    agent: { v: 3 },
    ease: { v: 3 },
    confidence: { v: 3 },
  },
  ...overrides,
});
function setup() {
  const receipts = new RunReceipts(origin);
  receipts.observe(
    "core__goal_list",
    {},
    {
      goals: [
        {
          id: "goal-delivery",
          content: `Deliver ${source}`,
          sourceUrl: source,
        },
      ],
    },
  );
  for (const id of guidance)
    receipts.observe(
      "core__knowledge_read",
      { id },
      { mode: "get", entries: [{ id, content: "read guidance" }] },
    );
  const writes: Record<string, unknown>[] = [];
  const writer = new DynamicStructuredTool({
    name: "core__work_item_transition",
    description: "Host writer",
    schema: z.object({}).passthrough(),
    func: async (value) => {
      writes.push(value);
      return JSON.stringify({ success: true });
    },
  });
  const guard = createScoresGuard(receipts, writer, guidance);
  const observe = (value: ReturnType<typeof item>) =>
    receipts.observe("core__work_item_read", { id: value.id }, { item: value });
  const propose = (
    id: string,
    scores: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => guard.invoke({ id, expectedRevision: 7, scores, ...extra });
  return { receipts, writes, guard, observe, propose };
}

describe("scheduled scores-only decision guard", () => {
  it("catalog exposes the narrow writer and no EDO", () => {
    const entry = LANGGRAPH_CATALOG["cogni-decide"];
    expect(entry?.toolIds).toEqual(COGNI_DECIDE_TOOL_IDS);
    expect(entry?.toolIds).not.toContain("core__edo_decide");
  });
  it("requires current-run complete item, goal citation and guidance before any write", async () => {
    const a = setup();
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "guard_rejected",
    );
    a.observe(item("task.1", { labels: [] }));
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "goal_citation",
    );
    a.observe(item("task.1"));
    a.receipts.observe("core__knowledge_read", { id: "mission" }, {
      mode: "get", entries: [{ id: "mission", content: " \n\t" }],
    });
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "guard_rejected",
    );
    expect(a.writes).toHaveLength(0);
  });
  it("no-ops with no goals or unchanged values and rejects unread, closed and stale revisions", async () => {
    const a = setup();
    a.observe(item("task.1"));
    a.receipts.goals.clear();
    expect(await a.propose("task.1", { goal: { v: 3 } })).toContain(
      "goal_citation",
    );
    expect(a.writes).toHaveLength(0);
    const b = setup();
    b.observe(item("task.1"));
    expect(await b.propose("task.1", { goal: { v: 1 } })).toBe("no_change");
    expect(
      await b.guard.invoke({
        id: "task.1",
        expectedRevision: 8,
        scores: { goal: { v: 3 } },
      }),
    ).toContain("guard_rejected");
    b.observe(item("task.2", { status: "done" }));
    expect(await b.propose("task.2", { goal: { v: 3 } })).toContain(
      "guard_rejected",
    );
    expect(b.writes).toHaveLength(0);
  });
  it("writes only a CAS scores patch with observed linked evidence", async () => {
    const a = setup();
    a.observe(item("task.1"));
    expect(await a.propose("task.1", { goal: { v: 4, ev: source } })).toContain(
      '"success":true',
    );
    expect(a.writes).toHaveLength(1);
    expect(Object.keys(a.writes[0] ?? {}).sort()).toEqual([
      "action",
      "expectedRevision",
      "id",
      "scores",
    ]);
    expect(a.writes[0]).toMatchObject({
      action: "patch",
      id: "task.1",
      expectedRevision: 7,
      scores: { goal: { v: 4, ev: source } },
    });
    const b = setup();
    b.observe(item("task.1"));
    expect(
      await b.propose("task.1", {
        goal: { v: 4, ev: "https://unknown.example/evidence" },
      }),
    ).toContain("guard_rejected");
    expect(b.writes).toHaveLength(0);
  });
  it("limits each tick to five writes", async () => {
    const a = setup();
    for (let n = 0; n < 8; n++) {
      const id = `task.${n}`;
      a.observe(item(id));
      await a.propose(id, { goal: { v: 3 } });
    }
    expect(a.writes).toHaveLength(5);
  });
  it("suppresses a one-point score change after a newer revision", async () => {
    const a = setup();
    a.observe(item("task.1"));
    await a.propose("task.1", { goal: { v: 3 } });
    expect(a.writes).toHaveLength(1);
    const b = setup();
    b.observe(item("task.1", { revision: 8, scores: { goal: { v: 3 } } }));
    expect(
      await b.guard.invoke({
        id: "task.1",
        expectedRevision: 8,
        scores: { goal: { v: 2 } },
      }),
    ).toBe("no_change");
    expect(b.writes).toHaveLength(0);
  });
  it("clamps stalled confidence and blocked agent; delivering ease settles at five", async () => {
    const a = setup();
    a.observe(
      item("task.1", {
        createdAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
      }),
    );
    await a.propose("task.1", { confidence: { v: 3 } });
    expect(a.writes[0]).toMatchObject({ scores: { confidence: { v: 2 } } });
    const b = setup();
    b.observe(item("task.2", { status: "blocked" }));
    await b.propose("task.2", { agent: { v: 3 } });
    expect(b.writes[0]).toMatchObject({ scores: { agent: { v: 1 } } });
    const c = setup();
    c.observe(
      item("task.3", { status: "needs_merge", scores: { ease: { v: 3 } } }),
    );
    await c.propose("task.3", { ease: { v: 3, ev: source } });
    expect(c.writes[0]).toMatchObject({ scores: { ease: { v: 5 } } });
    const d = setup();
    d.observe(
      item("task.3", {
        status: "needs_merge",
        scores: { ease: { v: 5, ev: source } },
      }),
    );
    expect(await d.propose("task.3", { ease: { v: 5, ev: source } })).toBe(
      "no_change",
    );
    expect(d.writes).toHaveLength(0);
  });
  it("does not apply a decision-confidence floor to a score patch", async () => {
    const a = setup();
    a.observe(item("task.1"));
    await a.propose("task.1", { goal: { v: 3 } }, { confidence: 0.1 });
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0]).toMatchObject({ scores: { goal: { v: 3 } } });
  });
});
