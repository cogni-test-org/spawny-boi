// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { toWorkItemId } from "@cogni-dao/work-items";
import { describe, expect, it } from "vitest";

import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import {
  independentReadPool,
  makeFakeDoltgresSql,
} from "./fake-doltgres-sql.js";

const row = {
  id: "task.0001",
  type: "task",
  title: "owned",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 1,
  deploy_verified: false,
  created_by_principal_id: "principal-1",
  claimed_by_run: "run-1",
  claim_owner_principal_id: "principal-1",
  claim_expires_at: "2099-10-02T00:05:00.000Z",
  created_at: "2026-10-02T00:00:00.000Z",
  updated_at: "2026-10-02T00:00:00.000Z",
};

function adapterWithQueries() {
  const queries: string[] = [];
  const sql = makeFakeDoltgresSql((query) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("INSERT INTO work_items")) return [row];
    if (query.startsWith("UPDATE work_items")) {
      return [
        {
          ...row,
          title: /title = '([^']*)'/.exec(query)?.[1] ?? row.title,
          claim_active: query.includes("claim_expires_at"),
        },
      ];
    }
    if (query.startsWith("DELETE FROM work_items")) return [{ id: row.id }];
    if (query.includes("FROM work_items")) return [row];
    return [];
  }, queries);
  return {
    adapter: new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
    }),
    queries,
  };
}

/**
 * An UNADOPTED row: created before `created_by_principal_id` existed, so NULL.
 *
 * Deliberately mirrors `adapterWithQueries` query-for-query — including the
 * `SELECT id FROM work_items` arm, which must come BEFORE the generic
 * `FROM work_items` arm or it swallows the id probe and the branch
 * acknowledgement check derails into recovery. `recreateClient` is supplied
 * for the same reason the production wiring supplies one: a recovery handoff
 * terminates the pool, and without a factory to rebuild it the adapter stays
 * poisoned and every later call reports `requires restart reconciliation`.
 */
function adapterWithUnadoptedRow() {
  const queries: string[] = [];
  const legacy = { ...row, created_by_principal_id: null };
  const respond = (query: string) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("INSERT INTO work_items")) return [legacy];
    if (query.startsWith("UPDATE work_items")) {
      return [
        {
          ...legacy,
          title: /title = '([^']*)'/.exec(query)?.[1] ?? legacy.title,
          claim_active: query.includes("claim_expires_at"),
        },
      ];
    }
    if (query.startsWith("DELETE FROM work_items")) return [{ id: legacy.id }];
    if (query.includes("FROM work_items")) return [legacy];
    return [];
  };
  // ONE fake, used as every lane. The fake is stateful (branch, commit hash,
  // diff rows), and 0.1.7 derives a read pool from `recreateClient` — which in
  // a harness means a SECOND fake with its own state, so the commit the write
  // lane created is invisible to the proof's reads and the branch reads as
  // "unprovable commit evidence". Against a real database both pools see one
  // database, so pinning every lane to one instance is the faithful analogue,
  // not a workaround.
  const sql = makeFakeDoltgresSql(respond, queries);
  const adapter = new DoltgresWorkItemAdapter(sql, {
    readClient: independentReadPool(sql),
    recreateClient: () => sql,
  });
  return { adapter, queries };
}

describe("DoltgresWorkItemAdapter content ownership", () => {
  it("stamps the immutable session principal on create", async () => {
    const { adapter, queries } = adapterWithQueries();
    await adapter.create(
      { type: "task", title: "owned", status: "needs_implement" },
      "principal-1"
    );

    const insert = queries.find((query) =>
      query.startsWith("INSERT INTO work_items")
    );
    expect(insert).toContain("created_by_principal_id");
    expect(insert).toContain("'principal-1'");
  });

  it("owner-scopes patch and increments revision", async () => {
    const { adapter, queries } = adapterWithQueries();
    await adapter.patch(
      { id: toWorkItemId(row.id), set: { title: "renamed" } },
      "principal-1"
    );

    const update = queries.find((query) =>
      query.startsWith("UPDATE work_items SET title")
    );
    expect(update).toContain("revision = revision + 1");
    expect(update).toContain("created_by_principal_id = 'principal-1'");
  });

  it("rejects an unauthorized patch before branch creation and DML", async () => {
    const { adapter, queries } = adapterWithQueries();

    await expect(
      adapter.patch(
        { id: toWorkItemId(row.id), set: { title: "not yours" } },
        "principal-2"
      )
    ).rejects.toMatchObject({ name: "WorkItemAuthorizationError" });

    expect(queries.some((query) => query.includes("dolt_checkout('-b'"))).toBe(
      false
    );
    expect(
      queries.some((query) => query.startsWith("UPDATE work_items SET title"))
    ).toBe(false);
  });
});

// bug.5358. `mayMutate` lets anyone mutate an UNADOPTED row (NULL creator) —
// otherwise every work item predating the column is frozen forever. The
// transition matrix did not share that rule: it demanded `creator ===
// principal`, so the UPDATE was admitted, committed to the operation branch,
// and then failed its own proof. Measured on operator production: every item
// created on or before 2026-10-08 returned 500 on PATCH, every item created
// after returned 200 — the cutover being exactly when creators started being
// stamped. Authorization and proof must agree, or a write is admitted and then
// refused.
describe("unadopted rows (NULL creator) stay mutable", () => {
  it("patches an unadopted row instead of failing its own transition proof", async () => {
    const { adapter } = adapterWithUnadoptedRow();
    await expect(
      adapter.patch(
        { id: toWorkItemId(row.id), set: { title: "renamed" } },
        "principal-1"
      )
    ).resolves.toMatchObject({ id: row.id, title: "renamed" });
  });

  it("rejects hard-delete even for an unadopted row", async () => {
    const { adapter } = adapterWithUnadoptedRow();
    await expect(
      adapter.delete(toWorkItemId(row.id), "principal-1")
    ).rejects.toMatchObject({ name: "WorkItemDeletionRetiredError" });
  });

  it("still refuses a row owned by someone else", async () => {
    // Non-vacuous: the exemption is for NULL only, not for any mismatch.
    const { adapter } = adapterWithQueries();
    await expect(
      adapter.patch(
        { id: toWorkItemId(row.id), set: { title: "stolen" } },
        "principal-2"
      )
    ).rejects.toThrow();
  });
});
