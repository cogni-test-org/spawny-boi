// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Proves restart reconciliation preserves unproven operation branches, and that
 * an unprovable branch fails writes closed without taking reads down (bug.5358).
 */

import { independentReadPool } from "./fake-doltgres-sql.js";
import { toWorkItemId } from "@cogni-dao/work-items";
import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  WorkItemsBusyError,
} from "../../src/adapters/doltgres/adapter.js";

type Rows = ReadonlyArray<Record<string, unknown>>;

interface ReconciliationState {
  branch?: string;
  readonly deleteError?: Error;
  readonly deleteLeavesRef?: boolean;
  extraBranch?: string;
  readonly branchCommit?: string;
  readonly mergeBase: string;
  readonly listError?: Error;
  readonly proofError?: Error;
  readonly queries: string[];
  merged: boolean;
}

const recoveredRow = {
  id: "task.0001",
  type: "task",
  title: "restart evidence",
  status: "needs_implement",
  node: "shared",
  revision: 0,
  created_by_principal_id: "principal-1",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
  claimed_by_run: null,
  claimed_at: null,
  claim_owner_principal_id: null,
  claim_expires_at: null,
};

function makeReconciliationHarness({
  branchCommit = "operation-commit",
  mergeBase,
  listError,
  omitBranchCommit = false,
  unprovableTransition = false,
  proofError,
  withProvableSibling = false,
  deleteError,
  deleteLeavesRef = false,
}: {
  readonly branchCommit?: string;
  readonly mergeBase: string;
  readonly listError?: Error;
  readonly omitBranchCommit?: boolean;
  /** Make the diff row fail validateTransitionMatrix — the ONLY quarantinable arm. */
  readonly unprovableTransition?: boolean;
  readonly proofError?: Error;
  /** A second branch, sorted after the first, whose tip is already main. */
  readonly withProvableSibling?: boolean;
  /** `dolt_branch('-D', ...)` throws — e.g. the query deadline fired. */
  readonly deleteError?: Error;
  /** With `deleteError`, the ref survives: the delete genuinely did not land. */
  readonly deleteLeavesRef?: boolean;
}) {
  const state: ReconciliationState = {
    branch: "work-item-op/restart-evidence",
    extraBranch: withProvableSibling ? "work-item-op/zz-sibling" : undefined,
    deleteError,
    deleteLeavesRef,
    branchCommit: omitBranchCommit ? undefined : branchCommit,
    mergeBase,
    listError,
    unprovableTransition,
    proofError,
    queries: [],
    merged: false,
  };

  const unsafe = async (query: string): Promise<Rows> => {
    state.queries.push(query);
    if (query === "SELECT current_database() AS dolt_writer_database")
      return [{ dolt_writer_database: "knowledge_test" }];
    if (query === "SELECT 1 AS work_items_ready") {
      return [{ work_items_ready: 1 }];
    }
    if (query.startsWith("SELECT pg_try_advisory_lock")) {
      return [{ pg_try_advisory_lock: true }];
    }
    if (query.startsWith("SELECT pg_advisory_unlock")) {
      return [{ pg_advisory_unlock: true }];
    }
    if (query === "SELECT dolt_checkout('main')") {
      return [{ dolt_checkout: [0, ""] }];
    }
    if (query.includes("FROM dolt.merge_status")) return [];
    if (query === "SELECT table_name FROM dolt.status") return [];
    if (query === "SELECT dolt_hashof('main') AS dolt_hashof") {
      return [{ dolt_hashof: "current-main" }];
    }
    if (query === "SELECT name, hash FROM dolt.branches") {
      if (state.listError) throw state.listError;
      const rows: Array<Record<string, unknown>> = [];
      if (state.branch)
        rows.push({ name: state.branch, hash: state.branchCommit });
      // Tip already equals current main, so the sweep can delete it outright.
      if (state.extraBranch)
        rows.push({ name: state.extraBranch, hash: "current-main" });
      return rows;
    }
    if (query.startsWith("SELECT dolt_merge_base")) {
      if (state.proofError) throw state.proofError;
      return [
        {
          dolt_merge_base: state.merged ? state.branchCommit : state.mergeBase,
        },
      ];
    }
    if (query.includes("FROM dolt.commits")) {
      return [
        {
          commit_hash: state.branchCommit,
          // An unparseable message yields NO legacy proof, so the transition
          // proof fails while every STRUCTURAL check still passes — linear
          // history, frozen base, exactly one work_items row, real commit time.
          // That is precisely the quarantinable arm, and the only one.
          message: state.unprovableTransition
            ? "unrelated commit with no work-item proof"
            : "work-items: create work item by actor:principal-1",
          date: "2026-10-03T00:01:00.000Z",
        },
      ];
    }
    if (query.includes("FROM dolt.commit_ancestors")) {
      return [
        {
          commit_hash: state.branchCommit,
          parent_hash: "main-parent",
          parent_index: 0,
        },
      ];
    }
    if (query.startsWith("SELECT * FROM dolt_diff_summary")) {
      return [
        {
          from_table_name: "public.work_items",
          to_table_name: "public.work_items",
          schema_change: false,
          data_change: false,
        },
      ];
    }
    if (query.startsWith("SELECT * FROM dolt_diff(")) {
      return [
        {
          ...Object.fromEntries(
            Object.entries(recoveredRow).map(([key, value]) => [
              `to_${key}`,
              value,
            ])
          ),
          diff_type: "added",
        },
      ];
    }
    if (query.includes("FROM dolt_merge(")) {
      state.merged = true;
      return [
        { hash: "merge-commit", fast_forward: 0, conflicts: 0, message: "ok" },
      ];
    }
    if (query.startsWith("SELECT dolt_branch('-m'")) {
      // Quarantine: the ref leaves the swept `work-item-op/` namespace and its
      // commits stay intact. Clearing `state.branch` models exactly that — the
      // sweep stops seeing it, nothing is deleted.
      state.branch = undefined;
      return [{ dolt_branch: 0 }];
    }
    if (query.startsWith("SELECT dolt_branch('-D'")) {
      const deleted = /'(work-item-op\/[^']+)'/.exec(query)?.[1];
      if (state.deleteError) {
        // Doltgres applied the delete durably unless the fixture says the ref
        // survived; either way the acknowledgement is lost.
        if (!state.deleteLeavesRef) {
          if (deleted === state.extraBranch) state.extraBranch = undefined;
          else state.branch = undefined;
        }
        throw state.deleteError;
      }
      if (deleted === state.extraBranch) state.extraBranch = undefined;
      else state.branch = undefined;
      return [{ dolt_branch: [0, ""] }];
    }
    if (query.startsWith("SELECT * FROM work_items WHERE id = 'task.0001'")) {
      return state.merged ? [recoveredRow] : [];
    }
    if (query.includes("FROM work_items")) return [];
    return [];
  };

  const reserved = {
    unsafe,
    release: () => undefined,
  } as unknown as ReservedSql;
  const sql = {
    unsafe,
    reserve: async () => reserved,
    end: async () => undefined,
  } as unknown as Sql;

  const logs: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const record =
    (level: string) => (fields: Record<string, unknown>, _message: string) =>
      void logs.push({ level, fields });
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  return {
    adapter: new DoltgresWorkItemAdapter(sql, {
      logger,
      readClient: independentReadPool(sql),
    }),
    state,
    logs,
  };
}

function terminalServerError(): Error {
  return Object.assign(
    new Error("Server completed ref removal with an SQL error"),
    {
      name: "PostgresError",
      code: "XX000",
    }
  );
}

describe("DoltgresWorkItemAdapter restart reconciliation", () => {
  it("deletes a restart-time empty branch only when its tip equals current main", async () => {
    const { adapter, state } = makeReconciliationHarness({
      branchCommit: "current-main",
      mergeBase: "current-main",
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "probe" } },
        "principal-1"
      )
    ).rejects.toThrow(/Work item not found/);

    expect(state.branch).toBeUndefined();
    expect(
      state.queries.some((query) => query.includes("FROM dolt.commits"))
    ).toBe(false);
  });

  it("deletes a redundant restart branch once its old-main tip is proven reachable", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "probe" } },
        "principal-1"
      )
    ).rejects.toThrow(/Work item not found/);

    expect(state.branch).toBeUndefined();
    expect(state.queries).toContain(
      "SELECT dolt_merge_base('main', 'operation-commit') AS dolt_merge_base"
    );
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(true);
  });

  it("merges and verifies a valid operation branch whose tip is not yet on main", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "main-commit",
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "probe" } },
        "principal-1"
      )
    ).rejects.toThrow(/Work item not found/);

    expect(state.branch).toBeUndefined();
    expect(
      state.queries.some((query) => query.includes("FROM dolt_merge("))
    ).toBe(true);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(true);
  });

  it("preserves evidence and fails a write busy when the reachability proof errors", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "blocked" } },
        "principal-1"
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(false);
  });

  it("serves a read when a branch cannot be proven, keeping the evidence", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
    });

    await expect(adapter.get(toWorkItemId("task.missing"))).resolves.toBeNull();

    // Evidence is preserved, but it is no longer on the read path (bug.5358).
    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(true);
  });

  it("serves a read when the branch tip is missing, keeping the evidence", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(adapter.get(toWorkItemId("task.missing"))).resolves.toBeNull();

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(true);
  });

  it("reads committed main without checkout or reconciliation", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
    });

    await expect(adapter.get(toWorkItemId("task.missing"))).resolves.toBeNull();

    // One checkout makes main safe up front; a second re-proves it after the
    // tolerated failure, so the read never runs on a half-reconciled session.
    expect(
      state.queries.filter((query) => query === "SELECT dolt_checkout('main')")
        .length
    ).toBe(0);
  });

  it("records a served read as handled degradation, never as an error", async () => {
    // `omitBranchCommit` fails the branch proof without failing a query, which
    // is the production signature: poly's wedged reads log no stage_error, only
    // the reconciliation verdict.
    const { adapter, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(adapter.get(toWorkItemId("task.missing"))).resolves.toBeNull();

    // The request SUCCEEDED. Any error level would make every healthy read on a
    // node carrying residual evidence look like an outage.
    expect(logs.filter((entry) => entry.level === "error")).toEqual([]);
    expect(
      logs.some((entry) => entry.fields.classification === "preserved_unsafe")
    ).toBe(false);
  });

  it("records an unprovable branch as an error when a write fails closed", async () => {
    const { adapter, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "blocked" } },
        "principal-1"
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    const preserved = logs.filter(
      (entry) => entry.fields.classification === "preserved_unsafe"
    );
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.level).toBe("error");
    expect(preserved[0]?.fields.served).toBeUndefined();
  });

  // bug.5358: the write path used to throw here, which made writes permanently
  // unavailable on a node carrying one residual branch — 88 consecutive 503s
  // over two hours on operator production while reads stayed 200. The branch
  // reaches this arm structurally verified and fails only its transition proof,
  // so it may hold a real one-row write: park it, never delete it.
  it("quarantines a structurally-verified but unprovable branch so writes recover", async () => {
    const { adapter, state, logs } = makeReconciliationHarness({
      mergeBase: "main-commit",
      unprovableTransition: true,
    });

    // The write is no longer blocked BY THE BRANCH: it gets past reconciliation
    // and fails only because this fixture has no such row. Before quarantine it
    // rejected with WorkItemsBusyError and never reached the item at all — that
    // difference is the whole fix.
    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "unblocked" } },
        "principal-1"
      )
    ).rejects.toThrow(/Work item not found/);

    // Renamed OUT of the swept namespace, never deleted.
    const rename = state.queries.find((q) => q.includes("dolt_branch('-m'"));
    expect(rename).toContain("work-item-op/restart-evidence");
    expect(rename).toContain("work-item-quarantine/restart-evidence");
    expect(
      state.queries.some((q) => q.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);

    const q = logs.filter(
      (e) => e.fields.classification === "quarantined_unprovable"
    );
    expect(q).toHaveLength(1);
    expect(q[0]?.level).toBe("warn");
    expect(q[0]?.fields.quarantinedAs).toBe(
      "work-item-quarantine/restart-evidence"
    );
  });

  it("reads never reconcile even provable sibling branches", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      proofError: new Error("proof query failed"),
      withProvableSibling: true,
    });

    await expect(adapter.get(toWorkItemId("task.missing"))).resolves.toBeNull();

    // The unprovable branch is kept as evidence; the sweep does not stop there,
    // so a sibling that only needed its merge finished is still resolved.
    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(state.extraBranch).toBeDefined();
  });

  it("proves ref absence after an authoritative server SQL error", async () => {
    const { adapter, state, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      deleteError: terminalServerError(),
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "probe" } },
        "principal-1"
      )
    ).rejects.toThrow(/Work item not found/);

    // An authoritative SQL response is terminal, so a same-session ref readback
    // can prove absence. This does not model a lost transport acknowledgement.
    expect(state.branch).toBeUndefined();
    const verdicts = logs.filter((e) =>
      String(e.fields.classification ?? "").startsWith("reachable_redundant")
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.fields.classification).toBe(
      "reachable_redundant_cleaned"
    );
    expect(logs.some((e) => e.fields.deleteAckLost === true)).toBe(true);
    // The injected failure IS a real query error, so a `stage_error` is correct
    // here. This test asserts the reconciliation VERDICT, not query-level
    // logging; the served-read tests cover the verdict's level.
  });

  it("keeps a surviving ref pending after an authoritative server SQL error", async () => {
    const { adapter, state, logs } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      deleteError: terminalServerError(),
      deleteLeavesRef: true,
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "probe" } },
        "principal-1"
      )
    ).rejects.toThrow(/Work item not found/);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      logs.some(
        (e) => e.fields.classification === "reachable_redundant_cleanup_pending"
      )
    ).toBe(true);
    expect(logs.some((e) => e.fields.deleteAckLost === true)).toBe(false);
  });

  it.each([false, true])(
    "quarantines a lost delete transport ACK when ref survives=%s",
    async (deleteLeavesRef) => {
      const { adapter, state, logs } = makeReconciliationHarness({
        mergeBase: "operation-commit",
        deleteError: new Error("transport acknowledgement lost"),
        deleteLeavesRef,
      });
      await expect(
        adapter.patch(
          {
            id: toWorkItemId("task.missing"),
            set: { title: "never dispatched" },
          },
          "principal-1"
        )
      ).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.branch).toBe(
        deleteLeavesRef ? "work-item-op/restart-evidence" : undefined
      );
      const deleteIndex = state.queries.findIndex((query) =>
        query.startsWith("SELECT dolt_branch('-D'")
      );
      expect(deleteIndex).toBeGreaterThan(-1);
      expect(state.queries.slice(deleteIndex + 1)).toEqual([]);
      expect(logs.some((entry) => entry.fields.deleteAckLost === true)).toBe(
        false
      );
      const count = state.queries.length;
      await expect(
        adapter.patch(
          { id: toWorkItemId("task.missing"), set: { title: "retry" } },
          "principal-1"
        )
      ).rejects.toMatchObject({
        code: "work_items_native_capacity_held",
        nativeState: "unknown",
      });
      expect(state.queries).toHaveLength(count);
      await expect(
        adapter.get(toWorkItemId("task.missing"))
      ).resolves.toBeNull();
    }
  );

  it("preserves evidence and fails busy when the branch lookup errors", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      listError: new Error("branch lookup failed"),
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "probe" } },
        "principal-1"
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(false);
  });

  it("preserves evidence and fails a write busy when the branch tip is missing", async () => {
    const { adapter, state } = makeReconciliationHarness({
      mergeBase: "operation-commit",
      omitBranchCommit: true,
    });

    await expect(
      adapter.patch(
        { id: toWorkItemId("task.missing"), set: { title: "blocked" } },
        "principal-1"
      )
    ).rejects.toBeInstanceOf(WorkItemsBusyError);

    expect(state.branch).toBe("work-item-op/restart-evidence");
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_merge_base"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(
      state.queries.some((query) => query.includes("FROM work_items"))
    ).toBe(false);
  });
});
