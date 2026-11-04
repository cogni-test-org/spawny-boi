// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-query`
 * Purpose: Unit tests for the core__work_item_query output contract (task.5282 enrichment).
 * Scope: Does not hit a store; verifies additive optional fields flow through, outcome truncation, and back-compat.
 * Invariants: read_only effect; output validates against WorkItemQueryOutputSchema.
 * Side-effects: none
 * Links: src/tools/work-item-query.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import type {
  WorkItemAssignee,
  WorkItemCapability,
  WorkItemInfo,
} from "../src/capabilities/work-item";
import {
  createWorkItemQueryImplementation,
  WORK_ITEM_QUERY_OUTCOME_MAX_CHARS,
  WORK_ITEM_QUERY_SCORE_EV_MAX_CHARS,
  WORK_ITEM_QUERY_SCORES_MAX_AXES,
  WORK_ITEM_QUERY_SCORES_MAX_CHARS,
  WORK_ITEM_QUERY_SUMMARY_MAX_CHARS,
  WorkItemQueryOutputSchema,
  workItemQueryContract,
} from "../src/tools/work-item-query";

function capabilityReturning(
  items: readonly WorkItemInfo[]
): WorkItemCapability {
  return {
    query: vi.fn().mockResolvedValue(items),
    transitionStatus: vi.fn(),
    patch: vi.fn(),
  };
}

const BASE: WorkItemInfo = {
  id: "task.5001",
  type: "task",
  title: "A task",
  status: "needs_implement",
  labels: [],
  assignees: [],
  externalRefs: [],
  specRefs: [],
  updatedAt: "2026-10-19T00:00:00.000Z",
  createdAt: "2026-10-18T00:00:00.000Z",
  deployVerified: false,
  revision: 3,
};

describe("core__work_item_query", () => {
  it("normalizes legacy id-only and canonical capability assignees", async () => {
    const legacy: readonly WorkItemAssignee[] = [
      { kind: "user", id: "user-1" },
      { kind: "agent", id: "agent-1" },
      { kind: "system", id: "service-1" },
    ];
    const cap = capabilityReturning([{
      ...BASE,
      assignees: [
        ...legacy,
        { kind: "user", userId: "user-2" },
        { kind: "agent", agentId: "agent-2" },
        { kind: "system", serviceId: "service-2" },
      ],
    }]);
    const out = WorkItemQueryOutputSchema.parse(
      await createWorkItemQueryImplementation({ workItemCapability: cap }).execute({})
    );
    expect(out.items[0]?.assignees).toEqual([
      { kind: "user", userId: "user-1", id: "user-1" },
      { kind: "agent", agentId: "agent-1", id: "agent-1" },
      { kind: "system", serviceId: "service-1", id: "service-1" },
      { kind: "user", userId: "user-2", id: "user-2" },
      { kind: "agent", agentId: "agent-2", id: "agent-2" },
      { kind: "system", serviceId: "service-2", id: "service-2" },
    ]);
  });

  it("stays read_only", () => {
    expect(workItemQueryContract.effect).toBe("read_only");
  });

  it("passes enrichment fields through and truncates outcome + summary", async () => {
    const longOutcome = "x".repeat(WORK_ITEM_QUERY_OUTCOME_MAX_CHARS + 50);
    const cap = capabilityReturning([
      {
        ...BASE,
        revision: 7,
        outcome: longOutcome,
        summary: "s".repeat(WORK_ITEM_QUERY_SUMMARY_MAX_CHARS + 50),
        estimate: 3,
        scores: {
          goal: { v: 5, ev: "https://external.example/evidence" },
          time: { v: 3 },
        },
        parentId: "story.5096",
        specRefs: ["knowledge:work-items-port"],
      },
    ]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    const out = await impl.execute({ statuses: ["needs_implement"] });

    expect(WorkItemQueryOutputSchema.parse(out)).toEqual(out);
    const [item] = out.items;
    expect(item?.revision).toBe(7);
    expect(item?.estimate).toBe(3);
    expect(item?.scores).toEqual({
      goal: { v: 5, ev: "https://external.example/evidence" },
      time: { v: 3 },
    });
    expect(item?.parentId).toBe("story.5096");
    expect(item?.specRefs).toEqual(["knowledge:work-items-port"]);
    expect(item?.outcome?.length).toBe(WORK_ITEM_QUERY_OUTCOME_MAX_CHARS + 1);
    expect(item?.outcome?.endsWith("…")).toBe(true);
    expect(item?.summary).toBe(
      `${"s".repeat(WORK_ITEM_QUERY_SUMMARY_MAX_CHARS)}…`
    );
  });

  it("caps scores like summary/outcome (story.5111, bug.5518)", async () => {
    const scores: Record<string, { v: number; ev?: string }> = {};
    for (let i = 0; i < WORK_ITEM_QUERY_SCORES_MAX_AXES + 3; i++) {
      scores[`axis_${i}`] = { v: i % 6 };
    }
    scores.axis_0 = {
      v: 5,
      ev: `https://cognidao.org/${"e".repeat(WORK_ITEM_QUERY_SCORE_EV_MAX_CHARS)}`,
    };
    const cap = capabilityReturning([{ ...BASE, scores }]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    const out = await impl.execute({});

    expect(WorkItemQueryOutputSchema.parse(out)).toEqual(out);
    const capped = out.items[0]?.scores ?? {};
    expect(Object.keys(capped)).toHaveLength(WORK_ITEM_QUERY_SCORES_MAX_AXES);
    expect(capped.axis_0?.ev?.length).toBe(
      WORK_ITEM_QUERY_SCORE_EV_MAX_CHARS
    );
    expect(capped.axis_0?.ev?.endsWith("…")).toBe(false);
    expect(capped.axis_1).toEqual({ v: 1 });
  });

  it("keeps one item's scores within the 1 KB blob bound by dropping later ev", async () => {
    const scores: Record<string, { v: number; ev?: string }> = {};
    for (let i = 0; i < WORK_ITEM_QUERY_SCORES_MAX_AXES; i++) {
      scores[`axis_${i}`] = {
        v: 4,
        ev: `https://cognidao.org/${"e".repeat(WORK_ITEM_QUERY_SCORE_EV_MAX_CHARS)}`,
      };
    }
    const impl = createWorkItemQueryImplementation({
      workItemCapability: capabilityReturning([{ ...BASE, scores }]),
    });
    const capped = (await impl.execute({})).items[0]?.scores ?? {};

    expect(Object.keys(capped)).toHaveLength(WORK_ITEM_QUERY_SCORES_MAX_AXES);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(
      WORK_ITEM_QUERY_SCORES_MAX_CHARS
    );
    expect(capped.axis_0?.ev).toBeDefined();
    expect(capped.axis_11).toEqual({ v: 4 });
  });

  it("preserves evidence for a valid scores blob exactly at its byte limit", async () => {
    const scores: Record<string, { v: number; ev?: string }> = {};
    for (let i = 0; i < 4; i++)
      scores[`axis_${i}`] = { v: 4, ev: "https://e.test/" + "a".repeat(200) };
    const before = new TextEncoder().encode(JSON.stringify(scores)).length;
    scores.axis_3!.ev += "b".repeat(WORK_ITEM_QUERY_SCORES_MAX_CHARS - before);
    expect(new TextEncoder().encode(JSON.stringify(scores)).length).toBe(
      WORK_ITEM_QUERY_SCORES_MAX_CHARS
    );
    const impl = createWorkItemQueryImplementation({
      workItemCapability: capabilityReturning([{ ...BASE, scores }]),
    });
    expect((await impl.execute({})).items[0]?.scores).toEqual(scores);
  });

  it("omits scores when the item has none", async () => {
    const impl = createWorkItemQueryImplementation({
      workItemCapability: capabilityReturning([BASE]),
    });
    const out = await impl.execute({});
    expect(out.items[0]).not.toHaveProperty("scores");
  });

  it("preserves actual revision when optional enrichment is absent", async () => {
    const cap = capabilityReturning([BASE]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    const out = await impl.execute({});

    expect(WorkItemQueryOutputSchema.parse(out)).toEqual(out);
    expect(out.items[0]?.revision).toBe(BASE.revision);
    expect(out.items[0]).not.toHaveProperty("outcome");
    expect(out.count).toBe(1);
  });

  it("does not forward an actor filter the caller omitted", async () => {
    const cap = capabilityReturning([]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    await impl.execute({ statuses: ["needs_triage"], limit: 5 });

    expect(cap.query).toHaveBeenCalledWith(
      expect.objectContaining({ actor: undefined, limit: 5 })
    );
  });

  it("always returns createdAt + deployVerified in the envelope (bug.5552)", async () => {
    const cap = capabilityReturning([BASE]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    const out = await impl.execute({});

    expect(WorkItemQueryOutputSchema.parse(out)).toEqual(out);
    expect(out.items[0]?.createdAt).toBe("2026-10-18T00:00:00.000Z");
    expect(out.items[0]?.deployVerified).toBe(false);
  });

  it("forwards labels / labelPrefix / scored filters to the capability (bug.5552)", async () => {
    const cap = capabilityReturning([]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    await impl.execute({
      labels: ["goal", "roadmap"],
      labelPrefix: "area:",
      scored: false,
    });

    expect(cap.query).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ["goal", "roadmap"],
        labelPrefix: "area:",
        scored: false,
      })
    );
  });

  it("omits the scored filter entirely when the caller does not set it", async () => {
    const cap = capabilityReturning([]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    await impl.execute({ statuses: ["needs_triage"] });

    const params = (cap.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(params).not.toHaveProperty("scored");
    expect(params).not.toHaveProperty("labels");
    expect(params).not.toHaveProperty("labelPrefix");
  });
});
