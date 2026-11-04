// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/dao-goals`
 * Purpose: Coverage for the DAO goal list reader — `listActiveGoals` on the Doltgres + fake adapters — and the goal confidence exemption.
 * Scope: Fake postgres.js client; does not connect to live Doltgres.
 * Invariants: ONE_GOAL_LIST, NO_GOAL_CAP, NO_GOALS_FAILS_LOUD (empty list, not an omission), goals excluded from confidence recompute.
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/dao-goals.ts, packages/knowledge-store/src/adapters/doltgres/index.ts
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "../src/adapters/fake/index.js";
import {
  type ActiveGoal,
  GOALS_BOOTSTRAP_INSTRUCTION,
  isGoalRowId,
  renderGoalsLines,
  resolveGoals,
} from "../src/domain/dao-goals.js";
import { HypothesisMissingEvaluateAtError } from "../src/port/knowledge-store.port.js";

type Row = Record<string, unknown>;

function goalRow(id: string, over: Row = {}): Row {
  return {
    id,
    entry_type: "goal",
    status: "draft",
    title: `Goal: ${id}`,
    content: `Statement for ${id}.\nKPI: x\nTarget: 1\nBy: 2026-12-31`,
    evaluate_at: "2026-12-31T00:00:00.000Z",
    ...over,
  };
}

/** Answers the goal read with `rows`, as main-plane Doltgres would. */
class FakeSql {
  readonly queries: string[] = [];
  constructor(
    private readonly rows: Row[],
    private readonly citations: Row[] = []
  ) {}
  async unsafe(query: string): Promise<Row[]> {
    this.queries.push(query);
    return query.includes("FROM citations") ? this.citations : this.rows;
  }
}

function adapterFor(
  rows: Row[],
  citations: Row[] = []
): {
  adapter: DoltgresKnowledgeStoreAdapter;
  fake: FakeSql;
} {
  const fake = new FakeSql(rows, citations);
  return {
    adapter: new DoltgresKnowledgeStoreAdapter({ sql: fake as unknown as Sql }),
    fake,
  };
}

describe("DoltgresKnowledgeStoreAdapter.listActiveGoals", () => {
  it("returns [] when no goal is merged (caller renders it loudly)", async () => {
    const { adapter } = adapterFor([]);
    await expect(adapter.listActiveGoals()).resolves.toEqual([]);
  });

  it("returns goals sorted by id with id, title, content, evaluateAt verbatim", async () => {
    const { adapter } = adapterFor([
      goalRow("goal-b"),
      goalRow("goal-a"),
      goalRow("goal-c"),
    ]);
    const goals = await adapter.listActiveGoals();
    expect(goals.map((g) => g.id)).toEqual(["goal-a", "goal-b", "goal-c"]);
    expect(goals[0]).toEqual({
      id: "goal-a",
      title: "Goal: goal-a",
      content: "Statement for goal-a.\nKPI: x\nTarget: 1\nBy: 2026-12-31",
      evaluateAt: new Date("2026-12-31T00:00:00.000Z"),
    });
  });

  it("excludes deprecated rows, non-goal-prefixed ids and goal-loop hypotheses", async () => {
    const { adapter } = adapterFor([
      goalRow("goal-live"),
      goalRow("goal-old", { status: "deprecated" }),
      goalRow("ship-faster"),
      // The goal-loop start route files `goal-<timestamp>` HYPOTHESIS rows;
      // those are loop targets, never DAO goals.
      goalRow("goal-2026-10-21T00-00-00-000Z", { entry_type: "hypothesis" }),
    ]);
    const goals = await adapter.listActiveGoals();
    expect(goals.map((g) => g.id)).toEqual(["goal-live"]);
  });

  it("returns every active goal sorted by id — no cap, never throws or truncates (NO_GOAL_CAP)", async () => {
    const ids = ["goal-d", "goal-a", "goal-c", "goal-b"];
    const { adapter } = adapterFor(ids.map((id) => goalRow(id)));
    const goals = await adapter.listActiveGoals();
    expect(goals.map((g) => g.id)).toEqual(["goal-a", "goal-b", "goal-c", "goal-d"]);
  });

  it("excludes deprecated rows from the active list", async () => {
    const { adapter } = adapterFor([
      goalRow("goal-a"),
      goalRow("goal-b"),
      goalRow("goal-c"),
      goalRow("goal-d", { status: "deprecated" }),
    ]);
    await expect(adapter.listActiveGoals()).resolves.toHaveLength(3);
  });

  it("reads the main-plane tables only — goal rows + supersedes edges, no branch checkout or AS OF (branch rows excluded)", async () => {
    const { adapter, fake } = adapterFor([]);
    await adapter.listActiveGoals();
    expect(fake.queries).toHaveLength(2);
    const [q, c] = fake.queries as [string, string];
    expect(q).toContain("FROM knowledge WHERE entry_type = 'goal'");
    expect(q).toContain("evaluate_at");
    expect(c).toContain("FROM citations WHERE citation_type = 'supersedes'");
    for (const query of fake.queries) {
      expect(query).not.toMatch(/dolt_checkout|AS OF|contrib\//i);
    }
  });

  it("retires a goal cited by a merged supersedes edge (GOAL_RETIRED_BY_SUPERSEDES)", async () => {
    const { adapter } = adapterFor(
      [goalRow("goal-a"), goalRow("goal-b"), goalRow("goal-c"), goalRow("goal-old")],
      [{ cited_id: "goal-old" }]
    );
    // Four goal rows, one superseded: three active.
    const goals = await adapter.listActiveGoals();
    expect(goals.map((g) => g.id)).toEqual(["goal-a", "goal-b", "goal-c"]);
  });
});

describe("cognition Goals section (resolveGoals + renderGoalsLines)", () => {
  const port = (goals: ActiveGoal[] | Error) => ({
    listActiveGoals: async () => {
      if (goals instanceof Error) throw goals;
      return goals;
    },
  });

  it("zero goals renders `no approved goals` plus the bootstrap instruction", async () => {
    const lines = renderGoalsLines(await resolveGoals(port([])));
    expect(lines).toEqual(["", "## Goals", "", GOALS_BOOTSTRAP_INSTRUCTION]);
    expect(lines.join("\n")).toContain("no approved goals");
    expect(GOALS_BOOTSTRAP_INSTRUCTION).toContain("Ask your node admin for the goals");
    expect(GOALS_BOOTSTRAP_INSTRUCTION).toContain("never merge them yourself");
  });

  it("renders title, By from evaluate_at, id and verbatim content", async () => {
    const md = renderGoalsLines(
      await resolveGoals(
        port([
          {
            id: "goal-g1",
            title: "Goal: outcome 1",
            content: "Statement: s1.\nBy: someday",
            evaluateAt: new Date("2026-12-01T00:00:00.000Z"),
          },
        ])
      )
    ).join("\n");
    expect(md).toContain(
      "### Goal: outcome 1\n\nBy: 2026-12-01 · `goal-g1`\n\nStatement: s1.\nBy: someday"
    );
    expect(md).not.toContain("no approved goals");
  });

  it("renders every goal with no cap and no warning", async () => {
    const four = ["goal-a", "goal-b", "goal-c", "goal-d"].map((id) => ({
      id,
      title: `Goal: ${id}`,
      content: "s",
      evaluateAt: null,
    }));
    const md = renderGoalsLines(await resolveGoals(port(four))).join("\n");
    for (const g of four) expect(md).toContain(`### Goal: ${g.id}`);
    expect(md).not.toMatch(/exceed|cap of/);
  });

  it("a failed read or missing hub is a visible `goals unavailable` line", async () => {
    const failed = await resolveGoals(port(new Error("store read timed out")));
    expect(renderGoalsLines(failed)).toContain(
      "goals unavailable: store read timed out"
    );
    expect(renderGoalsLines(await resolveGoals(undefined))).toContain(
      "goals unavailable: knowledge hub not configured"
    );
  });

  it("isGoalRowId keys the admin gate on the goal namespace", () => {
    expect(isGoalRowId("goal-x")).toBe(true);
    expect(isGoalRowId("dao-goals-design")).toBe(false);
    expect(isGoalRowId(undefined)).toBe(false);
  });
});

describe("FakeKnowledgeStoreAdapter — goal parity", () => {
  async function seed(
    store: FakeKnowledgeStoreAdapter,
    id: string,
    entryType = "goal"
  ) {
    return store.withWrite(
      { operationId: "goal-policy-test-1", message: "goal policy test" },
      async (write) =>
        write.addKnowledge({
          id,
          domain: "strategy",
          title: `Goal: ${id}`,
          content: "statement",
          entryType,
          evaluateAt: new Date("2026-12-31T00:00:00.000Z"),
          sourceType: "human"
        })
    );
  }

  async function freshStore(): Promise<FakeKnowledgeStoreAdapter> {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "strategy", name: "strategy" });
    return store;
  }

  it("selects goal-* goal rows with no cap", async () => {
    const store = await freshStore();
    await expect(store.listActiveGoals()).resolves.toEqual([]);
    await seed(store, "goal-a");
    await seed(store, "goal-x", "hypothesis");
    expect((await store.listActiveGoals()).map((g) => g.id)).toEqual([
      "goal-a",
    ]);
    await seed(store, "goal-b");
    await seed(store, "goal-c");
    await seed(store, "goal-d");
    await expect(store.listActiveGoals()).resolves.toHaveLength(4);
  });

  it("retires a goal once a supersedes edge cites it", async () => {
    const store = await freshStore();
    await seed(store, "goal-old");
    await seed(store, "goal-new");
    await store.withWrite(
      { operationId: "goal-policy-test-2", message: "goal policy test" },
      async (write) =>
        write.addCitation({
          citingId: "goal-new",
          citedId: "goal-old",
          citationType: "supersedes"
        })
    );
    expect((await store.listActiveGoals()).map((g) => g.id)).toEqual([
      "goal-new",
    ]);
  });

  it("rejects a goal without evaluateAt (its By: deadline)", async () => {
    const store = await freshStore();
    await expect(
      store.withWrite(
        { operationId: "goal-policy-test-3", message: "goal policy test" },
        async (write) =>
          write.addKnowledge({
            id: "goal-undated",
            domain: "strategy",
            title: "Goal: undated",
            content: "statement",
            entryType: "goal",
            sourceType: "human"
          })
      )
    ).rejects.toBeInstanceOf(HypothesisMissingEvaluateAtError);
  });

  it("leaves a goal's confidence alone on citation recompute", async () => {
    const store = await freshStore();
    const goal = await seed(store, "goal-a");
    // A supporting edge would bump any non-exempt row's confidence.
    await store.withWrite(
      { operationId: "goal-policy-test-4", message: "goal policy test" },
      async (write) =>
        write.addKnowledge({
          id: "evidence-a",
          domain: "strategy",
          title: "Evidence a",
          content: "supports the goal",
          entryType: "finding",
          sourceType: "agent"
        })
    );
    await store.withWrite(
      { operationId: "goal-policy-test-5", message: "goal policy test" },
      async (write) =>
        write.addCitation({
          citingId: "evidence-a",
          citedId: "goal-a",
          citationType: "supports"
        })
    );
    const resolver = new FakeEdoResolverAdapter(store);
    await expect(resolver.recomputeConfidence("goal-a")).resolves.toBe(
      goal.confidencePct
    );
    expect((await store.getKnowledge("goal-a"))?.confidencePct).toBe(
      goal.confidencePct
    );
  });
});
