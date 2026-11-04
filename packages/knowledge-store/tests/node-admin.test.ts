// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/node-admin`
 * Purpose: The shared node-admin seam — privileged-priority rule, fail-closed authority run, goal-touch rule — and the
 *   direct-write plane refusing goal rows (GOAL_CHANGE_IS_NODE_ADMIN).
 * Scope: Pure helpers, the fake adapter and the capability over a fake port. No Doltgres.
 * Invariants: PRIVILEGED_PRIORITY_IS_AT_MOST_ONE, FAIL_CLOSED_WITH_DISTINCTION, MERGE_GATE_ON_RAW_DIFF, GOAL_CHANGE_IS_NODE_ADMIN.
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/node-admin.ts, story.5101
 * @internal
 */

import { describe, expect, it } from "vitest";

import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import { createKnowledgeCapability } from "../src/capability.js";
import {
  checkNodeAdmin,
  isPrivilegedPriority,
  NodeAdminRequiredError,
  touchesGoalLayer,
} from "../src/domain/node-admin.js";
import { GoalRequiresContributionError } from "../src/port/knowledge-store.port.js";

describe("isPrivilegedPriority", () => {
  it("priority <= 1 (negatives included) is the node-admin tier; 2+ and absent are open", () => {
    expect([-1, 0, 1, 2, null, undefined].map(isPrivilegedPriority)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("checkNodeAdmin", () => {
  const actor = { userId: "u1", walletAddress: "0xabc" };

  it("passes an allow and a deny through", async () => {
    await expect(
      checkNodeAdmin({ check: async () => ({ ok: true }) }, actor)
    ).resolves.toEqual({ ok: true });
    const denied = await checkNodeAdmin(
      { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      actor
    );
    expect(denied).toEqual({ ok: false, errorCode: "authz_denied" });
    const err = new NodeAdminRequiredError(
      denied as Exclude<typeof denied, { ok: true }>,
      "x"
    );
    expect(err.status).toBe(403);
  });

  it("an authority that throws is 503 authz_unavailable, never a denial, and the client message hides the cause", async () => {
    const decision = await checkNodeAdmin(
      {
        check: async () => {
          throw new Error("openfga: connect ECONNREFUSED 10.0.0.7:8080");
        },
      },
      actor
    );
    expect(decision).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    const err = new NodeAdminRequiredError(
      decision as Exclude<typeof decision, { ok: true }>,
      "knowledge.contributions.merge.goal"
    );
    expect(err.status).toBe(503);
    expect(err.message).not.toContain("ECONNREFUSED");
    expect(err.reason).toContain("ECONNREFUSED");
  });

  it("no authority wired fails closed (503)", async () => {
    await expect(checkNodeAdmin(undefined, actor)).resolves.toMatchObject({
      ok: false,
      errorCode: "authz_unavailable",
    });
  });
});

describe("touchesGoalLayer (raw diff ids)", () => {
  it("goal rows, edges leaving a goal, and supersedes onto a goal count; a bet extending a goal does not", () => {
    expect(touchesGoalLayer({ knowledgeIds: ["goal-a"], citations: [] })).toBe(true);
    expect(
      touchesGoalLayer({
        knowledgeIds: [],
        citations: [{ citingId: "goal-a", citedId: "x", citationType: "extends" }],
      })
    ).toBe(true);
    expect(
      touchesGoalLayer({
        knowledgeIds: [],
        citations: [{ citingId: "x", citedId: "goal-a", citationType: "supersedes" }],
      })
    ).toBe(true);
    expect(
      touchesGoalLayer({
        knowledgeIds: ["bet-1"],
        citations: [{ citingId: "bet-1", citedId: "goal-a", citationType: "extends" }],
      })
    ).toBe(false);
  });
});

describe("direct-write plane refuses goals (GOAL_CHANGE_IS_NODE_ADMIN)", () => {
  async function storeWithGoal() {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "strategy", name: "strategy" });
    await store.withWrite(
      { operationId: "goal-policy-test-1", message: "goal policy test" },
      async (write) =>
        write.addKnowledge({
          id: "goal-a",
          domain: "strategy",
          title: "Goal: a",
          content: "KPI x, target 1",
          entryType: "goal",
          evaluateAt: new Date("2027-01-01T00:00:00Z"),
          sourceType: "human"
        })
    );
    await store.withWrite(
      { operationId: "goal-policy-test-2", message: "goal policy test" },
      async (write) =>
        write.addKnowledge({
          id: "note-1",
          domain: "strategy",
          title: "note",
          content: "c",
          entryType: "finding",
          sourceType: "agent"
        })
    );
    return store;
  }

  it("core__knowledge_write rejects a goal-* id and leaves the goal untouched", async () => {
    const store = await storeWithGoal();
    const cap = createKnowledgeCapability(store, { gates: [] });
    await expect(
      cap.write({
        id: "goal-a",
        domain: "strategy",
        title: "Goal: a (rewritten)",
        content: "KPI y, target 0",
        sourceType: "agent",
      })
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
    expect((await store.getKnowledge("goal-a"))?.content).toBe("KPI x, target 1");
  });

  it("core__knowledge_write rejects a raw goal entryType on any id", async () => {
    const store = await storeWithGoal();
    const cap = createKnowledgeCapability(store, { gates: [] });
    await expect(
      cap.write({
        id: "sneaky",
        domain: "strategy",
        title: "t",
        content: "c",
        sourceType: "agent",
        entryType: "goal",
      } as Parameters<typeof cap.write>[0])
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
  });

  it("upsertKnowledge / updateKnowledge refuse to modify a goal or retype a row into one", async () => {
    const store = await storeWithGoal();
    await expect(
      store.withWrite(
        { operationId: "goal-policy-test-3", message: "goal policy test" },
        async (write) =>
          write.upsertKnowledge({
            id: "goal-a",
            domain: "strategy",
            title: "x",
            content: "y",
            sourceType: "agent"
          })
      )
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
    await expect(
      store.withWrite(
        { operationId: "goal-policy-test-4", message: "goal policy test" },
        async (write) =>
          write.updateKnowledge("goal-a", { content: "rewritten" })
      )
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
    await expect(
      store.withWrite(
        { operationId: "goal-policy-test-5", message: "goal policy test" },
        async (write) =>
          write.updateKnowledge("note-1", {
            entryType: "goal",
            evaluateAt: new Date("2027-01-01T00:00:00Z")
          })
      )
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
    await expect(
      store.withWrite(
        { operationId: "goal-policy-test-6", message: "goal policy test" },
        async (write) => write.updateKnowledge("note-1", { content: "fine" })
      )
    ).resolves.toMatchObject({ content: "fine" });
  });
});
