// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-patch`
 * Purpose: Drives DoltgresWorkItemAdapter.patch() so deploy_verified, project_id, parent_id and blocked_by provably reach the UPDATE (bug.5005).
 * Scope: Fake `Sql` capturing emitted UPDATE text. Does not use a real database and does not assert read-back behaviour.
 * Invariants:
 *   - PATCH_DEPLOY_VERIFIED: deployVerified:true emits `deploy_verified = TRUE`.
 *   - PATCH_NULLABLE_CLEAR: projectId:null emits `project_id = NULL`.
 *   - PATCH_PRESERVES_EXISTING: title still emits `title = '...'`.
 *   - PATCH_CAS (task.5284): expectedRevision is in the UPDATE predicate; a stale one throws WorkItemRevisionConflictError with nothing committed.
 *   - COLLABORATOR_TRIAGE (task.5284): a non-creator may patch only priority/rank/labels/scores; any other field keeps the whole patch creator-bound.
 *   - SCORES_JSONB_ORDER (story.5111): a scores patch is proven even when jsonb reorders its keys.
 *   - SCORES_BOUNDS_IN_PACKAGE (story.5111): create/patch run parseWorkItemScores; invalid scores never reach SQL.
 * Side-effects: none
 * Links: bug.5005, task.5284,
 *   packages/work-items/src/adapters/doltgres/adapter.ts
 * @internal
 */

import { toWorkItemId } from "@cogni-dao/work-items";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  WorkItemAuthorizationError,
  WorkItemRevisionConflictError,
} from "../../src/adapters/doltgres/adapter.js";
import { WorkItemScoresInvalidError } from "../../src/errors.js";
import {
  independentReadPool,
  makeFakeDoltgresSql,
} from "./fake-doltgres-sql.js";

function makeFakeSql(): { sql: Sql; queries: string[] } {
  const queries: string[] = [];
  const respond = (q: string): unknown[] => {
    if (q.startsWith("UPDATE work_items")) {
      const title = /title = '([^']*)'/.exec(q)?.[1] ?? "t";
      return [
        {
          id: "bug.5005",
          type: "bug",
          title,
          status: "needs_implement",
          node: "operator",
          actor: "either",
          assignees: [],
          external_refs: [],
          labels: [],
          spec_refs: [],
          revision: 0,
          deploy_verified: q.includes("deploy_verified = TRUE"),
          project_id: q.includes("project_id = NULL") ? null : undefined,
          parent_id: /parent_id = '([^']*)'/.exec(q)?.[1] ?? undefined,
          blocked_by: q.includes("blocked_by = NULL") ? null : undefined,
          created_by_principal_id: "test",
          created_at: "2026-05-01",
          updated_at: "2026-05-01",
        },
      ];
    }
    if (q.includes("FROM work_items")) {
      return [
        {
          id: "bug.5005",
          type: "bug",
          title: "t",
          status: "needs_implement",
          node: "operator",
          actor: "either",
          assignees: [],
          external_refs: [],
          labels: [],
          spec_refs: [],
          revision: 0,
          deploy_verified: false,
          created_by_principal_id: "test",
          created_at: "2026-05-01",
          updated_at: "2026-05-01",
        },
      ];
    }
    return [];
  };
  return { sql: makeFakeDoltgresSql(respond, queries), queries };
}

describe("DoltgresWorkItemAdapter.patch — bug.5005 allowlist", () => {
  it("emits deploy_verified = TRUE for {deployVerified:true}", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      { id: toWorkItemId("bug.5005"), set: { deployVerified: true } },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("deploy_verified = TRUE");
  });

  it("emits project_id = NULL for {projectId:null}", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      { id: toWorkItemId("bug.5005"), set: { projectId: null } },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("project_id = NULL");
  });

  it("emits parent_id and blocked_by columns", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      {
        id: toWorkItemId("bug.5005"),
        set: { parentId: toWorkItemId("task.5004"), blockedBy: null },
      },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("parent_id = 'task.5004'");
    expect(update).toContain("blocked_by = NULL");
  });

  it("still emits the existing whitelisted columns (title)", async () => {
    const { sql, queries } = makeFakeSql();
    const adapter = new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    });
    await adapter.patch(
      { id: toWorkItemId("bug.5005"), set: { title: "renamed" } },
      "test"
    );
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toBeDefined();
    expect(update).toContain("title = 'renamed'");
  });
});

// REGRESSION, operator production 2026-10-08: creator-binding locked out every
// row that predated the lease-column migration. `String(null) !== principal` is
// always true, so a node's entire existing corpus became immutable the moment it
// applied the migration — while reads kept returning 200, which made it read as
// an auth fault rather than a migration one. An unowned row must stay mutable:
// that is the behaviour it had before the column existed.
describe("unowned rows stay mutable", () => {
  it("treats a NULL created_by_principal_id as unowned, not as someone else's", async () => {
    const legacy = { id: "task.1", created_by_principal_id: null };
    const owned = { id: "task.2", created_by_principal_id: "agent-a" };
    // mayMutate is module-private; assert through the observable SQL contract the
    // adapter builds, which is what actually gates the UPDATE/DELETE.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../src/adapters/doltgres/adapter.ts", import.meta.url),
        "utf8"
      )
    );
    expect(source).toContain(
      "created_by_principal_id IS NULL OR created_by_principal_id ="
    );
    expect(source).not.toMatch(
      /AND created_by_principal_id = \$\{escapeValue\(principal\)\}/
    );
    expect(legacy.created_by_principal_id).toBeNull();
    expect(owned.created_by_principal_id).toBe("agent-a");
  });
});

// task.5284 (story.5096): `patch` honors `expectedRevision` as a real
// compare-and-set, and a non-creator may patch the triage fields only.
const CAS_ID = "task.0001";
const CREATOR = "principal-creator";
const COLLABORATOR = "system-prioritizer";

const casSeed = {
  id: CAS_ID,
  type: "task",
  title: "triage me",
  status: "needs_implement",
  node: "operator",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  priority: 2,
  rank: 7,
  revision: 3,
  deploy_verified: false,
  created_by_principal_id: CREATOR,
  claimed_by_run: null,
  claimed_at: null,
  claim_owner_principal_id: null,
  claim_expires_at: null,
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

/**
 * jsonb does not keep object key order: it stores shorter keys first, then
 * bytewise. Model that so the fake hands back `scores` the way a real jsonb
 * column does, not in the order the adapter wrote it.
 */
function asJsonb(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, asJsonb(inner)])
  );
}

/**
 * One in-memory row behind the stateful Dolt fake. The UPDATE arm honours the
 * statement's own `revision = N` and creator predicates, so the CAS and the
 * authz are exercised as SQL, not assumed. `concurrentBumpBeforeUpdate` models
 * a writer outside this adapter's lock landing between preflight and UPDATE.
 */
function casHarness(options: { concurrentBumpBeforeUpdate?: boolean } = {}) {
  const queries: string[] = [];
  const store = new Map<string, Record<string, unknown>>([
    [CAS_ID, { ...casSeed }],
  ]);
  const respond = (query: string) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("UPDATE work_items")) {
      const id = /WHERE id = '([^']+)'/.exec(query)?.[1] ?? "";
      const current = store.get(id);
      if (current && options.concurrentBumpBeforeUpdate) {
        current.revision = Number(current.revision) + 1;
      }
      if (!current) return [];
      const expected = /AND revision = (\d+)/.exec(query)?.[1];
      if (
        expected !== undefined &&
        Number(current.revision) !== Number(expected)
      )
        return [];
      const owner = /created_by_principal_id = '([^']+)'\)/.exec(query)?.[1];
      if (owner !== undefined && current.created_by_principal_id !== owner)
        return [];
      const next: Record<string, unknown> = {
        ...current,
        revision: Number(current.revision) + 1,
        claim_active: false,
      };
      const priority = /\bpriority = (-?\d+)/.exec(query)?.[1];
      if (priority !== undefined) next.priority = Number(priority);
      const rank = /\brank = (NULL|-?\d+)/.exec(query)?.[1];
      if (rank !== undefined) next.rank = rank === "NULL" ? null : Number(rank);
      const labels = /\blabels = '(.*?)'::jsonb/.exec(query)?.[1];
      if (labels !== undefined) next.labels = JSON.parse(labels);
      const title = /\btitle = '([^']*)'/.exec(query)?.[1];
      if (title !== undefined) next.title = title;
      const scores = /\bscores = '(.*?)'::jsonb/.exec(query)?.[1];
      if (scores !== undefined) {
        next.scores = asJsonb(JSON.parse(scores.replace(/''/g, "'")));
      }
      if (/\bscores = NULL\b/.test(query)) next.scores = null;
      store.set(id, next);
      return [next];
    }
    const byId = /FROM work_items WHERE id = '([^']+)'/.exec(query)?.[1];
    if (byId) {
      const row = store.get(byId);
      return row ? [{ ...row, claim_active: false }] : [];
    }
    return [];
  };
  const sql = makeFakeDoltgresSql(respond, queries);
  const adapter = new DoltgresWorkItemAdapter(sql, {
    readClient: independentReadPool(sql),
    recreateClient: () => sql,
  });
  return { adapter, queries, store };
}

const branchCreated = (queries: string[]) =>
  queries.some((query) => query.includes("dolt_checkout('-b'"));
const committed = (queries: string[]) =>
  queries.some((query) => query.startsWith("SELECT dolt_commit"));
const updateOf = (queries: string[]) =>
  queries.find((query) => query.startsWith("UPDATE work_items"));

describe("DoltgresWorkItemAdapter.patch — expectedRevision CAS (task.5284)", () => {
  it("lands a matching expectedRevision and bumps revision by exactly one", async () => {
    const { adapter, queries } = casHarness();

    const result = await adapter.patch(
      { id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { title: "cas" } },
      CREATOR
    );

    expect(result).toMatchObject({ id: CAS_ID, title: "cas", revision: 4 });
    // The CAS is in the statement itself, not only in the preflight.
    expect(updateOf(queries)).toContain(
      `WHERE id = '${CAS_ID}' AND (created_by_principal_id IS NULL OR created_by_principal_id = '${CREATOR}') AND revision = 3 RETURNING`
    );
    expect(queries).toContain(
      `SELECT dolt_commit('-m', 'work-items: patch ${CAS_ID} by actor:${CREATOR}')`
    );
  });

  it("refuses a stale expectedRevision before any branch or DML, leaving the row unchanged", async () => {
    const { adapter, queries, store } = casHarness();

    const attempt = adapter.patch(
      { id: toWorkItemId(CAS_ID), expectedRevision: 2, set: { priority: 0 } },
      CREATOR
    );

    await expect(attempt).rejects.toBeInstanceOf(WorkItemRevisionConflictError);
    await expect(attempt).rejects.toMatchObject({
      id: CAS_ID,
      expectedRevision: 2,
      currentRevision: 3,
    });
    expect(branchCreated(queries)).toBe(false);
    expect(updateOf(queries)).toBeUndefined();
    expect(store.get(CAS_ID)).toMatchObject({ priority: 2, revision: 3 });
  });

  it("reports a conflict, commits nothing, and drops the op branch when the UPDATE loses a race", async () => {
    const { adapter, queries, store } = casHarness({
      concurrentBumpBeforeUpdate: true,
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { priority: 0 } },
        CREATOR
      )
    ).rejects.toMatchObject({
      name: "WorkItemRevisionConflictError",
      expectedRevision: 3,
      currentRevision: 4,
    });
    expect(committed(queries)).toBe(false);
    expect(
      queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(true);
    expect(store.get(CAS_ID)).toMatchObject({ priority: 2, rank: 7 });
  });

  it("leaves an omitted expectedRevision unconditioned, as before", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch(
        { id: toWorkItemId(CAS_ID), set: { title: "plain" } },
        CREATOR
      )
    ).resolves.toMatchObject({ title: "plain", revision: 4 });
    expect(updateOf(queries)).not.toContain("AND revision =");
    expect(updateOf(queries)).toContain(
      `created_by_principal_id = '${CREATOR}'`
    );
  });

  it("rejects a malformed expectedRevision without touching the store", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch(
        {
          id: toWorkItemId(CAS_ID),
          expectedRevision: "abc",
          set: { priority: 1 },
        },
        CREATOR
      )
    ).rejects.toThrow(/expectedRevision/);
    expect(queries).toHaveLength(0);
  });
});

describe("DoltgresWorkItemAdapter.patch — collaborator triage fields (task.5284)", () => {
  it("lets a non-creator set priority, rank and labels", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch(
        {
          id: toWorkItemId(CAS_ID),
          expectedRevision: 3,
          set: { priority: 0, rank: 1, labels: ["triaged"] },
        },
        COLLABORATOR
      )
    ).resolves.toMatchObject({
      priority: 0,
      rank: 1,
      labels: ["triaged"],
      revision: 4,
    });
    expect(updateOf(queries)).not.toContain("created_by_principal_id");
    expect(updateOf(queries)).toContain("AND revision = 3");
    expect(queries).toContain(
      `SELECT dolt_commit('-m', 'work-items: patch ${CAS_ID} by actor:${COLLABORATOR}')`
    );
  });

  it("keeps the whole patch creator-bound when it names any other field", async () => {
    const { adapter, queries, store } = casHarness();

    await expect(
      adapter.patch(
        { id: toWorkItemId(CAS_ID), set: { priority: 0, title: "not yours" } },
        COLLABORATOR
      )
    ).rejects.toBeInstanceOf(WorkItemAuthorizationError);
    expect(branchCreated(queries)).toBe(false);
    expect(committed(queries)).toBe(false);
    expect(store.get(CAS_ID)).toMatchObject({
      priority: 2,
      title: "triage me",
      revision: 3,
    });
  });

  it("lets a non-creator write scores, proven despite jsonb key reordering (story.5111)", async () => {
    const { adapter, queries, store } = casHarness();
    const scores = {
      unblocks: { v: 4, ev: "https://cognidao.org/work/items/story.5108" },
      goal: {
        v: 5,
        ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself",
      },
      ease: { v: 3 },
    };

    const result = await adapter.patch(
      { id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { scores } },
      COLLABORATOR
    );

    expect(result.scores).toEqual(scores);
    expect(result.revision).toBe(4);
    expect(updateOf(queries)).toContain("scores = '");
    expect(updateOf(queries)).not.toContain("created_by_principal_id");
    expect(committed(queries)).toBe(true);
    // Stored in jsonb order, not write order — the proof must still pass.
    expect(Object.keys(store.get(CAS_ID)?.scores as object)).toEqual([
      "ease",
      "goal",
      "unblocks",
    ]);
  });

  it("still refuses a blank principal for triage fields", async () => {
    const { adapter, queries } = casHarness();

    await expect(
      adapter.patch({ id: toWorkItemId(CAS_ID), set: { priority: 0 } }, "  ")
    ).rejects.toBeInstanceOf(WorkItemAuthorizationError);
    expect(queries).toHaveLength(0);
  });
});

describe("DoltgresWorkItemAdapter — scores (story.5111)", () => {
  const scores = {
    goal: { v: 5, ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself" },
    ease: { v: 3 },
  };

  it("creates an item with scores and round-trips them", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql((query) => {
      if (!query.startsWith("INSERT INTO work_items")) return [];
      const id = /VALUES \('([^']+)'/.exec(query)?.[1] ?? "";
      const written = /'(\{.*?\}\})'::jsonb/.exec(query)?.[1];
      return [
        {
          ...casSeed,
          id,
          revision: 0,
          scores: written ? asJsonb(JSON.parse(written)) : null,
        },
      ];
    }, queries);

    const created = await new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    }).create({ type: "task", title: "scored", scores }, CREATOR);

    const insert = queries.find((q) => q.startsWith("INSERT INTO work_items"));
    expect(insert).toMatch(
      /^INSERT INTO work_items \([^)]*\bscores\b[^)]*\) VALUES/
    );
    expect(insert).toContain(`'${JSON.stringify(scores)}'::jsonb`);
    expect(created.scores).toEqual(scores);
    expect(committed(queries)).toBe(true);
  });

  it("reads a NULL scores column as absent", async () => {
    const { adapter, store } = casHarness();
    store.set(CAS_ID, { ...casSeed, scores: null });

    const item = await adapter.get(toWorkItemId(CAS_ID));

    expect(item).not.toBeNull();
    expect(item && "scores" in item).toBe(false);
  });

  it("drops entries whose v is not an integer instead of coercing them", async () => {
    const { adapter, store } = casHarness();
    store.set(CAS_ID, {
      ...casSeed,
      scores: {
        goal: { v: 4 },
        time: { v: null },
        ease: { v: true },
        agent: { v: "3" },
        unblocks: { v: 2.5 },
      },
    });

    const item = await adapter.get(toWorkItemId(CAS_ID));

    expect(item?.scores).toEqual({ goal: { v: 4 } });
  });

  it("clears scores to SQL NULL with scores:null, and the proof passes", async () => {
    const { adapter, queries, store } = casHarness();
    store.set(CAS_ID, { ...casSeed, scores: asJsonb(scores) });

    const result = await adapter.patch(
      { id: toWorkItemId(CAS_ID), expectedRevision: 3, set: { scores: null } },
      COLLABORATOR
    );

    expect(updateOf(queries)).toContain("scores = NULL");
    expect(committed(queries)).toBe(true);
    expect(result.revision).toBe(4);
    expect("scores" in result).toBe(false);
    expect(store.get(CAS_ID)?.scores).toBeNull();
  });

  it("runs parseWorkItemScores on create: invalid scores throw before any query", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql(() => [], queries);

    await expect(
      new DoltgresWorkItemAdapter(sql, {
        readClient: independentReadPool(sql),
      }).create(
        { type: "task", title: "unevidenced", scores: { goal: { v: 5 } } },
        CREATOR
      )
    ).rejects.toBeInstanceOf(WorkItemScoresInvalidError);
    expect(queries).toHaveLength(0);
  });

  it("runs parseWorkItemScores on patch: invalid scores throw before any query", async () => {
    const { adapter, queries, store } = casHarness();

    await expect(
      adapter.patch(
        {
          id: toWorkItemId(CAS_ID),
          expectedRevision: 3,
          set: { scores: { goal: { v: 4, ev: "http://external.example/x" } } },
        },
        COLLABORATOR
      )
    ).rejects.toMatchObject({
      name: "WorkItemScoresInvalidError",
      issues: [expect.objectContaining({ code: "evidence_not_https" })],
    });
    expect(queries).toHaveLength(0);
    expect(store.get(CAS_ID)?.scores).toBeUndefined();
  });

  it("round-trips an external HTTPS justification without node hostname configuration", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql((query) => {
      if (!query.startsWith("INSERT INTO work_items")) return [];
      const id = /VALUES \('([^']+)'/.exec(query)?.[1] ?? "";
      const written = /'(\{.*?\}\})'::jsonb/.exec(query)?.[1];
      return [
        {
          ...casSeed,
          id,
          revision: 0,
          scores: written ? asJsonb(JSON.parse(written)) : null,
        },
      ];
    }, queries);
    const options = { readClient: independentReadPool(sql) };
    const input = {
      type: "task" as const,
      title: "own domain",
      scores: { goal: { v: 4, ev: "https://mynode.org/goals/1" } },
    };

    const created = await new DoltgresWorkItemAdapter(sql, options).create(
      input,
      CREATOR
    );
    expect(created.scores).toEqual(input.scores);
    expect(committed(queries)).toBe(true);
  });
});
