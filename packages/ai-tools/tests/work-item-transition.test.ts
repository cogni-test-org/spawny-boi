// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-transition`
 * Purpose: Unit tests for core__work_item_transition patch — optional `expectedRevision` compare-and-set (story.5096).
 * Scope: Does not hit a store; verifies capability passthrough, the non-throwing conflict result, and unchanged behavior without expectedRevision.
 * Invariants: PATCH_CAS_OPTIONAL, CONFLICT_IS_A_RESULT; output validates against WorkItemTransitionOutputSchema.
 * Side-effects: none
 * Links: src/tools/work-item-transition.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
} from "../src/capabilities/work-item";
import {
  createWorkItemTransitionImplementation,
  WorkItemTransitionInputSchema,
  WorkItemTransitionOutputSchema,
} from "../src/tools/work-item-transition";

const PATCHED: WorkItemInfo = {
  id: "task.5001",
  type: "task",
  title: "A task",
  status: "needs_implement",
  priority: 1,
  rank: 4,
  rankScore: 6.4,
  labels: [],
  assignees: [],
  externalRefs: [],
  specRefs: [],
  updatedAt: "2026-10-21T00:00:00.000Z",
  revision: 8,
  createdAt: "2026-10-20T00:00:00.000Z",
  deployVerified: false,
};

function capability(patch: WorkItemCapability["patch"]): WorkItemCapability {
  return {
    query: vi.fn(),
    transitionStatus: vi.fn(),
    patch: vi.fn(patch),
  };
}

describe("core__work_item_transition patch", () => {
  it("accepts expectedRevision + rank in the input schema", () => {
    const parsed = WorkItemTransitionInputSchema.safeParse({
      action: "patch",
      id: "task.5001",
      priority: 1,
      rank: 4,
      expectedRevision: 7,
    });
    expect(parsed.success).toBe(true);
    expect(
      WorkItemTransitionInputSchema.safeParse({
        action: "patch",
        id: "task.5001",
        priority: 1,
        expectedRevision: -1,
      }).success
    ).toBe(false);
  });

  it("forwards expectedRevision and rank to the capability and reports the new revision", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    const out = await tool.execute({
      action: "patch",
      id: "task.5001",
      priority: 1,
      rank: 4,
      expectedRevision: 7,
    });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      expectedRevision: 7,
      set: { priority: 1, rank: 4 },
    });
    expect(out).toMatchObject({ success: true, action: "patch", revision: 8 });
    expect(WorkItemTransitionOutputSchema.safeParse(out).success).toBe(true);
  });

  it("omits expectedRevision when absent (unconditioned patch, unchanged)", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await tool.execute({ action: "patch", id: "task.5001", priority: 2 });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      set: { priority: 2 },
    });
  });

  it("maps a lost compare-and-set to a non-throwing revision_conflict result", async () => {
    const cap = capability(async () => {
      throw new WorkItemPatchConflictError("task.5001", 7, 9);
    });
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    const out = await tool.execute({
      action: "patch",
      id: "task.5001",
      priority: 1,
      expectedRevision: 7,
    });

    expect(out).toMatchObject({
      success: false,
      action: "patch",
      id: "task.5001",
      code: "revision_conflict",
      currentRevision: 9,
    });
    expect(WorkItemTransitionOutputSchema.safeParse(out).success).toBe(true);
  });

  it("still throws on any other capability failure", async () => {
    const cap = capability(async () => {
      throw new Error("not authorized");
    });
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await expect(
      tool.execute({
        action: "patch",
        id: "task.5001",
        priority: 1,
        expectedRevision: 7,
      })
    ).rejects.toThrow("not authorized");
  });

  it("rejects expectedRevision on a status transition", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await expect(
      tool.execute({
        action: "transition",
        id: "task.5001",
        toStatus: "done",
        expectedRevision: 7,
      })
    ).rejects.toThrow("only supported for action 'patch'");
    expect(cap.transitionStatus).not.toHaveBeenCalled();
  });

  it("against a revisioned store: a stale expectedRevision writes nothing; a rank-only patch lands", async () => {
    let row: WorkItemInfo = { ...PATCHED, rank: 4, revision: 9 };
    const cap = capability(async ({ id, expectedRevision, set }) => {
      if (expectedRevision !== undefined && expectedRevision !== row.revision) {
        throw new WorkItemPatchConflictError(
          id,
          expectedRevision,
          row.revision as number
        );
      }
      row = { ...row, ...set, revision: (row.revision as number) + 1 };
      return row;
    });
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    const stale = await tool.execute({
      action: "patch",
      id: "task.5001",
      rank: 1,
      expectedRevision: 7,
    });
    expect(stale).toMatchObject({
      success: false,
      code: "revision_conflict",
      currentRevision: 9,
    });
    expect(row).toMatchObject({ rank: 4, revision: 9 });

    const rankOnly = await tool.execute({
      action: "patch",
      id: "task.5001",
      rank: 1,
      expectedRevision: 9,
    });
    expect(rankOnly).toMatchObject({ success: true, revision: 10 });
    expect(row).toMatchObject({ rank: 1, revision: 10 });
    expect(WorkItemTransitionOutputSchema.safeParse(rankOnly).success).toBe(
      true
    );
  });
  it("forwards scores unchanged to the capability (validation is the store's)", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });
    const scores = {
      goal: { v: 5, ev: "https://cognidao.org/work/items/story.5111" },
      time: { v: 2 },
      ease: { v: 9 },
    };

    const out = await tool.execute({
      action: "patch",
      id: "task.5001",
      scores,
      expectedRevision: 7,
    });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      expectedRevision: 7,
      set: { scores },
    });
    expect(out.success).toBe(true);
    expect(out.message).toContain("scores");
    expect(out.rankScore).toBe(6.4);
  });

  it("sends no priority field on a scores-only patch (p0/p1 priority stays a proposal)", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await tool.execute({
      action: "patch",
      id: "task.5001",
      scores: { goal: { v: 3 }, agent: { v: 2 } },
      expectedRevision: 8,
    });

    const call = vi.mocked(cap.patch).mock.calls[0]?.[0];
    expect(call?.set).not.toHaveProperty("priority");
    expect(Object.keys(call?.set ?? {})).toEqual(["scores"]);
  });

  it("forwards scores: null so the store clears them", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await tool.execute({
      action: "patch",
      id: "task.5001",
      scores: null,
      expectedRevision: 7,
    });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      expectedRevision: 7,
      set: { scores: null },
    });
  });

  it("checks scores shape only: v must be an integer, bounds are the store's", () => {
    const parse = (scores: unknown) =>
      WorkItemTransitionInputSchema.safeParse({
        action: "patch",
        id: "task.5001",
        expectedRevision: 7,
        scores,
      }).success;
    expect(parse({ goal: { v: 7 } })).toBe(true);
    expect(parse({ goal: { v: 4.5 } })).toBe(false);
    expect(parse({ goal: { ev: "https://cognidao.org" } })).toBe(false);
  });

  it("surfaces a store scores rejection (HTTP 400 class) as a tool error naming the axis", async () => {
    // Mirrors @cogni/work-items WorkItemScoresInvalidError, thrown by the adapter's
    // parseWorkItemScores before any SQL (ai-tools does not import the store package).
    class WorkItemScoresInvalidError extends Error {
      readonly code = "work_item_scores_invalid" as const;
      constructor(
        readonly issues: readonly {
          code: string;
          path: readonly string[];
          message: string;
        }[]
      ) {
        super(
          `Invalid work-item scores: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        );
        this.name = "WorkItemScoresInvalidError";
      }
    }
    const cap = capability(async () => {
      throw new WorkItemScoresInvalidError([
        {
          code: "evidence_required",
          path: ["goal"],
          message: "a score of 4 or 5 needs ev",
        },
      ]);
    });
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await expect(
      tool.execute({
        action: "patch",
        id: "task.5001",
        scores: { goal: { v: 5 } },
        expectedRevision: 7,
      })
    ).rejects.toThrow(
      "Invalid work-item scores: goal: a score of 4 or 5 needs ev"
    );
  });
  it("requires CAS and forbids priority for scores and clear, before calling the capability", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });
    for (const scores of [{ goal: { v: 3 } }, null]) {
      const base = { action: "patch" as const, id: "task.5001", scores };
      expect(WorkItemTransitionInputSchema.safeParse(base).success).toBe(false);
      await expect(tool.execute(base)).rejects.toThrow(
        "require expectedRevision"
      );
      const withPriority = { ...base, expectedRevision: 7, priority: 2 };
      expect(
        WorkItemTransitionInputSchema.safeParse(withPriority).success
      ).toBe(false);
      await expect(tool.execute(withPriority)).rejects.toThrow(
        "must not carry priority"
      );
      expect(
        WorkItemTransitionInputSchema.safeParse({
          ...base,
          expectedRevision: 7,
        }).success
      ).toBe(true);
    }
    expect(cap.patch).not.toHaveBeenCalled();
    expect(
      WorkItemTransitionInputSchema.safeParse({
        action: "transition",
        id: "task.5001",
        scores: { goal: { v: 3 } },
        expectedRevision: 7,
        toStatus: "done",
      }).success
    ).toBe(false);
    expect(
      WorkItemTransitionInputSchema.safeParse({
        action: "patch",
        id: "task.5001",
        priority: 2,
      }).success
    ).toBe(true);
  });
});
