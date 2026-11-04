// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/work.items.scores.contract`
 * Purpose: Pins the `scores` wire SHAPE on work-item create/patch (story.5111).
 * Scope: Pure Zod schema validation. Does not test bounds, HTTP transport or storage.
 * Invariants:
 *   - SCORES_ONE_ENFORCER: the contract checks shape only ({ axis: { v: number, ev?: string } });
 *     every bound is `parseWorkItemScores`, run once by the Doltgres adapter with the node's
 *     shared bounds (proven in tests/unit/facades/work-item-scores-http.test.ts and
 *     the package's tests/scores.test.ts).
 *   - PATCH_NULL_CLEARS: patch accepts scores:null; create does not.
 * Side-effects: none
 * Links: packages/node-contracts/src/work.items.list.v1.contract.ts, packages/work-items/src/scores.ts, hub work-item-scores-design
 * @internal
 */

import {
  WorkItemScoresInputSchema,
  workItemsCreateOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const ok = (scores: unknown) =>
  WorkItemScoresInputSchema.safeParse(scores).success;

describe("WorkItemScoresInputSchema (shape only)", () => {
  it("accepts six axes with and without evidence", () => {
    expect(
      ok({
        goal: {
          v: 5,
          ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself",
        },
        time: { v: 0 },
        unblocks: {
          v: 4,
          ev: "https://github.com/cogni-dao/node-template/pull/198",
        },
        ease: { v: 3 },
        confidence: { v: 2 },
        agent: { v: 1 },
      })
    ).toBe(true);
  });

  it.each([
    ["string v", { goal: { v: "5" } }],
    ["missing v", { goal: { ev: "https://cognidao.org" } }],
    ["non-string ev", { goal: { v: 1, ev: 42 } }],
    ["non-object entry", { goal: 3 }],
    ["array", []],
  ])("rejects %s", (_label, scores) => {
    expect(ok(scores)).toBe(false);
  });

  it("leaves bounds to the adapter: an out-of-range v and unknown keys pass the shape", () => {
    // Rejected later by parseWorkItemScores with shared bounds (400).
    expect(ok({ goal: { v: 6 } })).toBe(true);
    const parsed = WorkItemScoresInputSchema.safeParse({
      goal: { v: 1, note: "x" },
    });
    expect(parsed.data?.goal).toEqual({ v: 1, note: "x" });
  });
});

describe("scores on create and patch", () => {
  const scores = {
    goal: { v: 5, ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself" },
  };

  it("create accepts scores and rejects scores:null", () => {
    const base = { type: "task", title: "t" };
    expect(
      workItemsCreateOperation.input.safeParse({ ...base, scores }).success
    ).toBe(true);
    expect(
      workItemsCreateOperation.input.safeParse({ ...base, scores: null })
        .success
    ).toBe(false);
  });

  it("patch accepts scores and scores:null (clears the column)", () => {
    const patch = (set: unknown) =>
      workItemsPatchOperation.input.safeParse({ id: "task.0001", set });
    expect(patch({ scores }).success).toBe(true);
    const cleared = patch({ scores: null });
    expect(cleared.success).toBe(true);
    expect(cleared.data?.set.scores).toBeNull();
    expect(patch({ scores: { goal: { v: "6" } } }).success).toBe(false);
  });
});
