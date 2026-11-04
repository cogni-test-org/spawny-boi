// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Distinguishes authoritative server errors from abandoned native executions:
 * only the former permit fresh-session recovery without amplifying native work.
 */

import { toWorkItemId } from "@cogni-dao/work-items";
import { WorkItemWriteOutcomeUnknownError } from "../../src/errors.js";
import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  DoltgresWorkItemAdapter,
  type WorkItemLogger,
  WorkItemsBusyError,
} from "../../src/adapters/doltgres/adapter.js";

type Row = Record<string, unknown>;
type Rows = ReadonlyArray<Row>;

const baseRow: Row = {
  id: "task.0001",
  type: "task",
  title: "survives timeout",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 0,
  deploy_verified: false,
  created_by_principal_id: "principal-1",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

interface TimeoutHarnessState {
  row?: Row;
  pendingRow?: Row;
  branchBefore?: Row;
  branchAfter?: Row;
  branch?: string;
  branchCommit?: string;
  durable: boolean;
  deadUnlockAttempts: number;
  inserts: number;
  commits: number;
  mainCommits: Set<string>;
  poolBuilds: number;
  queries: string[];
  commitMessage?: string;
  commitDate?: string;
  branchBase?: string;
  failHistoricalReachability?: boolean;
}

function makeTimeoutHarness({
  failFreshReachability = false,
  timeoutAfterDml = false,
  timeoutFreshHousekeeping = false,
  laterMainUpdateAfterLostAck = false,
  slowCheckoutMs = 0,
  branchTimeoutMs = 10,
  mergeMode = "server-error",
  baseHashPending,
}: {
  readonly failFreshReachability?: boolean;
  readonly timeoutAfterDml?: boolean;
  readonly timeoutFreshHousekeeping?: boolean;
  readonly laterMainUpdateAfterLostAck?: boolean;
  /**
   * Make `dolt_checkout('-b', …)` take this long, to exercise the housekeeping
   * budget. `branch.create` is the right stage to test it on: it runs BEFORE
   * the write, so blowing its budget fails the operation. A `branch.delete`
   * timeout is deliberately TOLERATED (`cleanup_pending`) because by then the
   * merge is already durable — so it proves nothing about the budget.
   */
  readonly slowCheckoutMs?: number;
  readonly branchTimeoutMs?: number;
  readonly mergeMode?: "server-error" | "success" | "stalled";
  readonly baseHashPending?: Promise<Rows>;
} = {}) {
  const state: TimeoutHarnessState = {
    durable: false,
    deadUnlockAttempts: 0,
    inserts: 0,
    commits: 0,
    mainCommits: new Set(["main"]),
    poolBuilds: 0,
    queries: [],
  };
  const events: string[] = [];
  const logger: WorkItemLogger = {
    info: (fields) => events.push(String(fields.event)),
    warn: (fields) => events.push(String(fields.event)),
    error: (fields) => events.push(String(fields.event)),
  };

  const buildPool = (): Sql => {
    state.poolBuilds += 1;
    const poolNumber = state.poolBuilds;
    if (poolNumber === 2 && laterMainUpdateAfterLostAck && state.row) {
      state.row = {
        ...state.row,
        title: "later serialized update",
        revision: Number(state.row.revision ?? 0) + 1,
        updated_at: "2026-10-03T00:02:00.000Z",
      };
    }
    let ended = false;
    let rejectTimedOutMerge: ((error: Error) => void) | undefined;
    let rejectTimedOutQuery: ((error: Error) => void) | undefined;
    let freshReachabilityProven = false;

    const unsafe = async (query: string): Promise<Rows> => {
      state.queries.push(`pool-${poolNumber}:${query}`);
      if (ended && query.startsWith("SELECT pg_advisory_unlock")) {
        state.deadUnlockAttempts += 1;
        return await new Promise<Rows>(() => undefined);
      }
      if (ended) {
        const error = new Error("connection ended") as Error & {
          code: string;
        };
        error.code = "CONNECTION_ENDED";
        throw error;
      }
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
      if (query === "SELECT dolt_hashof('main') AS dolt_hashof") {
        if (baseHashPending) return baseHashPending;
        return [{ dolt_hashof: "main" }];
      }
      if (query.includes("dolt_checkout('-b'")) {
        if (slowCheckoutMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, slowCheckoutMs));
        }
        state.branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1];
        state.branchCommit = undefined;
        state.branchBase = "main";
        state.branchBefore = state.row;
        state.branchAfter = undefined;
        return [{ dolt_checkout: [0, ""] }];
      }
      if (query === "SELECT table_name FROM dolt.status") {
        return [];
      }
      if (query === "SELECT name, hash FROM dolt.branches") {
        return state.branch
          ? [{ name: state.branch, hash: state.branchCommit ?? "main" }]
          : [];
      }
      if (query === "SELECT active_branch() AS branch_name")
        return [{ branch_name: state.branch ?? "main" }];
      if (query === "SELECT is_merging FROM dolt.merge_status")
        return [{ is_merging: false }];
      if (query.includes("FROM dolt.merge_status")) return [];
      if (query === "SELECT dolt_add('work_items')") {
        if (poolNumber === 1 && timeoutAfterDml) {
          return await new Promise<Rows>((_resolve, reject) => {
            rejectTimedOutQuery = reject;
          });
        }
        return [{ dolt_add: [0, ""] }];
      }
      if (query.startsWith("SELECT dolt_commit")) {
        state.commits += 1;
        state.branchCommit = `test-commit-${state.commits}`;
        state.commitMessage = /SELECT dolt_commit\('-m', '(.*)'\)/
          .exec(query)?.[1]
          ?.replace(/''/g, "'");
        state.commitDate =
          state.inserts === 1
            ? "2026-10-03T00:01:00.000Z"
            : "2026-10-03T00:03:00.000Z";
        return [{ dolt_commit: state.branchCommit }];
      }
      if (query.includes("FROM dolt.commits")) {
        return state.branchCommit
          ? [
              {
                commit_hash: state.branchCommit,
                message: state.commitMessage,
                date: state.commitDate,
              },
            ]
          : [];
      }
      if (query.includes("FROM dolt.commit_ancestors")) {
        return state.branchCommit
          ? [
              {
                commit_hash: state.branchCommit,
                parent_hash: state.branchBase,
                parent_index: 0,
              },
            ]
          : [];
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
        const before = state.branchBefore;
        const after = state.branchAfter;
        return [
          {
            ...Object.fromEntries(
              Object.entries(before ?? {}).map(([key, value]) => [
                `from_${key}`,
                value,
              ])
            ),
            ...Object.fromEntries(
              Object.entries(after ?? {}).map(([key, value]) => [
                `to_${key}`,
                value,
              ])
            ),
            diff_type: before ? "modified" : "added",
          },
        ];
      }
      if (query.startsWith("SELECT dolt_merge_base")) {
        if (
          (poolNumber === 2 && failFreshReachability) ||
          state.failHistoricalReachability
        ) {
          const error = new Error("reachability connection ended") as Error & {
            code: string;
          };
          error.code = "CONNECTION_ENDED";
          throw error;
        }
        if (poolNumber === 2) freshReachabilityProven = true;
        const commit = /dolt_merge_base\('main', '([^']+)'\)/.exec(query)?.[1];
        return [
          {
            dolt_merge_base:
              commit && state.mainCommits.has(commit) ? commit : "main",
          },
        ];
      }
      if (query.includes("FROM dolt_merge(")) {
        state.durable = true;
        if (state.branchCommit) state.mainCommits.add(state.branchCommit);
        state.row = state.branchAfter;
        if (poolNumber === 1 && mergeMode === "stalled") {
          return await new Promise<Rows>((_resolve, reject) => {
            rejectTimedOutMerge = reject;
          });
        }
        if (poolNumber === 1 && mergeMode === "server-error") {
          const error = new Error("server reported an error after merge apply");
          error.name = "PostgresError";
          throw error;
        }
        return [
          {
            hash: "test-merge",
            fast_forward: 0,
            conflicts: 0,
            message: "ok",
          },
        ];
      }
      if (query.startsWith("SELECT dolt_branch")) {
        if (
          poolNumber === 2 &&
          timeoutFreshHousekeeping &&
          freshReachabilityProven
        ) {
          return await new Promise<Rows>((_resolve, reject) => {
            rejectTimedOutQuery = reject;
          });
        }
        if (
          state.branchCommit === undefined ||
          !state.mainCommits.has(state.branchCommit)
        ) {
          state.pendingRow = undefined;
          state.branchAfter = undefined;
        }
        state.branch = undefined;
        state.branchCommit = undefined;
        state.branchBefore = undefined;
        state.branchAfter = undefined;
        return [{ dolt_branch: [0, ""] }];
      }
      if (query.startsWith("SELECT id FROM work_items")) {
        return state.row ? [{ id: state.row.id }] : [];
      }
      if (query.startsWith("INSERT INTO work_items")) {
        state.inserts += 1;
        state.branchBefore = undefined;
        const values = /VALUES \('([^']+)', '([^']+)', '([^']+)'/.exec(query);
        state.pendingRow = {
          ...baseRow,
          id: values?.[1] ?? baseRow.id,
          type: values?.[2] ?? baseRow.type,
          title: values?.[3] ?? baseRow.title,
        };
        state.branchAfter = state.pendingRow;
        return [state.pendingRow];
      }
      if (query.startsWith("UPDATE work_items")) {
        state.pendingRow = {
          ...(state.row ?? baseRow),
          title: "still writable",
          revision: 1,
          updated_at: "2026-10-03T00:02:00.000Z",
        };
        state.branchAfter = state.pendingRow;
        return [state.pendingRow];
      }
      if (query.startsWith("SELECT * FROM work_items WHERE id") && state.row) {
        return [state.row];
      }
      if (query.includes("FROM work_items")) {
        return state.row ? [{ ...state.row, claim_active: false }] : [];
      }
      return [];
    };

    const reserved = {
      unsafe,
      release: () => undefined,
    } as unknown as ReservedSql;
    return {
      unsafe,
      reserve: async () => reserved,
      end: async () => {
        ended = true;
        const error = new Error("merge acknowledgement timed out") as Error & {
          code: string;
        };
        error.code = "CONNECTION_DESTROYED";
        rejectTimedOutMerge?.(error);
        rejectTimedOutQuery?.(error);
      },
    } as unknown as Sql;
  };

  const adapter = new DoltgresWorkItemAdapter(buildPool(), {
    logger,
    queryTimeoutMs: 5,
    // Explicit, and deliberately tight: `BRANCH_TIMEOUT_MS` defaults to 30s, so
    // leaving it unset would make the hang-based housekeeping tests below wait
    // half a minute each.
    branchTimeoutMs,
    reserveTimeoutMs: 100,
    recreateClient: buildPool,
    readClient: {
      options: { max: 1 },
      unsafe: async () => (state.row ? [state.row] : []),
    } as unknown as Sql,
  });
  return { adapter, events, state };
}

async function within<T>(promise: Promise<T>, milliseconds = 100): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("test operation timed out")),
        milliseconds
      );
    }),
  ]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("native execution owns capacity beyond the caller deadline", () => {
  it("classifies a readonly base-hash deadline as pre-intent capacity", async () => {
    const hash = deferred<Rows>();
    const { adapter, state } = makeTimeoutHarness({
      baseHashPending: hash.promise,
    });
    const error = await adapter
      .create({ type: "task", title: "not dispatched" }, "principal-1")
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "work_items_native_capacity_held" });
    expect(error).not.toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
    expect(
      state.queries.some((query) => query.includes("dolt_checkout('-b'"))
    ).toBe(false);
    expect(state.inserts).toBe(0);
    expect(state.commits).toBe(0);
    hash.resolve([{ dolt_hashof: "main" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      state.queries.filter((query) => query.includes("pg_advisory_unlock"))
    ).toHaveLength(3);
    expect(state.poolBuilds).toBe(1);
    expect(state.inserts).toBe(0);
    expect(state.branch).toBeUndefined();
  });
  it("privately resets only positively owned uncommitted work after finite SQL settles", async () => {
    const staging = deferred<Rows>();
    const queries: string[] = [];
    const baseHash = "a".repeat(32);
    let branch = "";
    let active = "main";
    let dirty = false;
    let inserted = 0;
    let commits = 0;
    let released = 0;
    let ended = 0;
    const unsafe = async (query: string): Promise<Rows> => {
      queries.push(query);
      if (query.includes("current_database"))
        return [{ dolt_writer_database: "native_test" }];
      if (query.includes("pg_try_advisory_lock"))
        return [{ pg_try_advisory_lock: true }];
      if (query.includes("pg_advisory_unlock"))
        return [{ pg_advisory_unlock: true }];
      if (query === "SELECT active_branch() AS branch_name")
        return [{ branch_name: active }];
      if (query === "SELECT dolt_hashof('main') AS dolt_hashof")
        return [{ dolt_hashof: baseHash }];
      if (query === "SELECT dolt_hashof('HEAD') AS commit_hash")
        return [{ commit_hash: baseHash }];
      if (query.includes("FROM dolt.merge_status"))
        return [{ is_merging: false }];
      if (query.includes("FROM dolt.status"))
        return dirty ? [{ table_name: "public.work_items" }] : [];
      if (query.includes("dolt_checkout('-b'")) {
        branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1] ?? "";
        active = branch;
        return [{ dolt_checkout: [0, ""] }];
      }
      if (query === "SELECT dolt_checkout('main')") {
        active = "main";
        return [{ dolt_checkout: [0, ""] }];
      }
      if (query.startsWith("INSERT INTO work_items")) {
        inserted++;
        dirty = true;
        return [{ ...baseRow, id: "task.9997" }];
      }
      if (query === "SELECT dolt_add('work_items')") return staging.promise;
      if (query.startsWith("SELECT dolt_commit")) commits++;
      if (query === "SELECT dolt_reset('--hard', 'HEAD')") {
        dirty = false;
        return [{ dolt_reset: [0, ""] }];
      }
      return [];
    };
    const writer = {
      unsafe,
      reserve: async () => ({
        unsafe,
        release: () => {
          released++;
        },
      }),
      end: async () => {
        ended++;
      },
    } as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter(writer, {
      readClient: { unsafe: async () => [] } as unknown as Sql,
      queryTimeoutMs: 5,
    });
    const receipt = await adapter
      .create(
        { id: toWorkItemId("task.9997"), type: "task", title: "abandoned DML" },
        "principal-1"
      )
      .catch((error: unknown) => error);
    expect(receipt).toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
    expect(released).toBe(0);
    expect(queries.some((query) => query.includes("dolt_reset"))).toBe(false);
    staging.resolve([{ dolt_add: [0, ""] }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(1);
    expect(active).toBe("main");
    expect(dirty).toBe(false);
    expect(inserted).toBe(1);
    expect(commits).toBe(0);
    expect(ended).toBe(0);
    expect(branch).toMatch(/^work-item-op\//);
    expect(queries.filter((query) => query.includes("dolt_reset"))).toEqual([
      "SELECT dolt_reset('--hard', 'HEAD')",
    ]);
    expect(
      queries.filter((query) => query.includes("pg_advisory_unlock"))
    ).toHaveLength(3);
    expect(queries.some((query) => /dolt_branch\('-D'/.test(query))).toBe(
      false
    );
    await expect(
      adapter.patch(
        { id: toWorkItemId("task.9998"), set: { title: "fresh intent" } },
        "principal-1"
      )
    ).rejects.toThrow(/not found/);
    expect(inserted).toBe(1);
    expect(receipt).toMatchObject({ retryable: false, branch });
  });
  it("serves healthy max-one reader fanout in FIFO order without writer admission", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const reader = {
      options: { max: 1 },
      unsafe: async (query: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(/task\.\d+/.exec(query)?.[0] ?? "missing");
        active--;
        return [];
      },
    } as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter({} as Sql, {
      readClient: reader,
      queryTimeoutMs: 500,
    });
    const ids = Array.from({ length: 8 }, (_, index) => `task.${9900 + index}`);
    await expect(
      Promise.all(ids.map((id) => adapter.get(toWorkItemId(id))))
    ).resolves.toEqual(ids.map(() => null));
    expect(order).toEqual(ids);
    expect(peak).toBe(1);
  });

  it("includes reader waiting in one deadline and removes expired tasks before dispatch", async () => {
    vi.useFakeTimers();
    const first = deferred<Rows>();
    const second = deferred<Rows>();
    const calls: string[] = [];
    const reader = {
      options: { max: 1 },
      unsafe: (query: string) => {
        calls.push(query);
        return calls.length === 1 ? first.promise : second.promise;
      },
      end: async () => undefined,
    } as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter({} as Sql, {
      readClient: reader,
      queryTimeoutMs: 20,
    });
    try {
      const requests = [1, 2, 3].map((id) =>
        adapter.get(toWorkItemId(`task.${id}`)).catch((error: unknown) => error)
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toHaveLength(1);
      first.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(await requests[0]).toBeNull();
      expect(await requests[1]).toBeInstanceOf(WorkItemsBusyError);
      expect(await requests[2]).toBeInstanceOf(WorkItemsBusyError);
      expect(calls).toHaveLength(2);
      second.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
    } finally {
      first.resolve([]);
      second.resolve([]);
      vi.useRealTimers();
    }
  });

  it("bounds reader waiting independently of the driver's unbounded query queue", async () => {
    vi.useFakeTimers();
    const native = deferred<Rows>();
    let dispatched = 0;
    const reader = {
      options: { max: 1 },
      unsafe: () => {
        dispatched++;
        return native.promise;
      },
      end: async () => undefined,
    } as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter({} as Sql, {
      readClient: reader,
      queryTimeoutMs: 20,
    });
    try {
      const waiting = Array.from({ length: 33 }, () =>
        adapter.get(toWorkItemId("task.9998")).catch((error: unknown) => error)
      );
      await expect(
        adapter.get(toWorkItemId("task.9998"))
      ).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
      expect(dispatched).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      await Promise.all(waiting);
      expect(dispatched).toBe(1);
      native.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatched).toBe(1);
    } finally {
      native.resolve([]);
      vi.useRealTimers();
    }
  });

  it("retires a generation's waiting callers before their own deadline without late SQL", async () => {
    vi.useFakeTimers();
    const native = deferred<Rows>();
    let dispatched = 0;
    let ended = 0;
    const reader = {
      options: { max: 1 },
      unsafe: () => {
        dispatched++;
        return native.promise;
      },
      end: async () => {
        ended++;
      },
    } as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter({} as Sql, {
      readClient: reader,
      queryTimeoutMs: 20,
    });
    try {
      const first = adapter
        .get(toWorkItemId("task.9998"))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5);
      const queued = adapter
        .get(toWorkItemId("task.9999"))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15);
      expect(await first).toBeInstanceOf(WorkItemsBusyError);
      expect(await queued).toMatchObject({
        code: "work_items_native_capacity_held",
      });
      expect(dispatched).toBe(1);
      expect(ended).toBe(0);
      native.resolve([]);
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatched).toBe(1);
      expect(ended).toBe(1);
    } finally {
      native.resolve([]);
      vi.useRealTimers();
    }
  });
  it("releases a positively acquired late advisory lock before allowing a successor", async () => {
    const lock = deferred<Rows>();
    const queries: string[] = [];
    let delayed = false;
    let releases = 0;
    let ended = 0;
    const unsafe = async (query: string): Promise<Rows> => {
      queries.push(query);
      if (query.includes("current_database"))
        return [{ dolt_writer_database: "native_test" }];
      if (query.includes("pg_try_advisory_lock") && !delayed) {
        delayed = true;
        return lock.promise;
      }
      if (query.includes("pg_try_advisory_lock"))
        return [{ pg_try_advisory_lock: true }];
      if (query.includes("pg_advisory_unlock"))
        return [{ pg_advisory_unlock: true }];
      if (query === "SELECT dolt_checkout('main')")
        return [{ dolt_checkout: [0, ""] }];
      return [];
    };
    const writer = {
      unsafe,
      reserve: async () => ({
        unsafe,
        release: () => {
          releases++;
        },
      }),
      end: async () => {
        ended++;
      },
    } as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter(writer, {
      readClient: { unsafe: async () => [] } as unknown as Sql,
      queryTimeoutMs: 5,
    });
    await expect(
      adapter.create({ type: "task", title: "abandoned lock" }, "principal-1")
    ).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
    expect(queries.some((query) => query.includes("pg_advisory_unlock"))).toBe(
      false
    );
    lock.resolve([{ pg_try_advisory_lock: true }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      queries.filter((query) => query.includes("pg_try_advisory_lock"))
    ).toHaveLength(1);
    expect(queries).toContain("SELECT pg_advisory_unlock(5001001)");
    expect(releases).toBe(1);
    expect(ended).toBe(0);
    await expect(
      adapter.patch(
        { id: toWorkItemId("task.9998"), set: { title: "successor" } },
        "principal-1"
      )
    ).rejects.toThrow(/not found/);
    expect(releases).toBe(2);
    expect(queries.some((query) => /INSERT|UPDATE|DELETE/.test(query))).toBe(
      false
    );
  });
  it("retains the original prime and FIFO, rejects retries, then recovers without late DML", async () => {
    const prime = deferred<Rows>();
    const queries: string[] = [];
    let stalled = true;
    let reserved = 0;
    let ended = 0;
    let replacements = 0;
    const unsafe = async (query: string): Promise<Rows> => {
      queries.push(query);
      if (query === "SELECT 1 AS work_items_ready" && stalled)
        return prime.promise;
      if (query.includes("current_database"))
        return [{ dolt_writer_database: "native_test" }];
      if (query.includes("pg_try_advisory_lock"))
        return [{ pg_try_advisory_lock: true }];
      if (query.includes("pg_advisory_unlock"))
        return [{ pg_advisory_unlock: true }];
      if (query === "SELECT dolt_checkout('main')")
        return [{ dolt_checkout: [0, ""] }];
      return [];
    };
    const writer = {
      unsafe,
      reserve: async () => {
        reserved++;
        return { unsafe, release: () => undefined };
      },
      end: async () => {
        ended++;
      },
    } as unknown as Sql;
    const reader = {
      options: { max: 1 },
      unsafe: async () => [],
    } as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter(writer, {
      readClient: reader,
      queryTimeoutMs: 5,
      recreateClient: () => {
        replacements++;
        return writer;
      },
    });
    const original = adapter.create(
      { type: "task", title: "abandoned" },
      "principal-1"
    );
    const queued = adapter.create(
      { type: "task", title: "already queued" },
      "principal-1"
    );
    await Promise.all([
      expect(original).rejects.toMatchObject({
        code: "work_items_native_capacity_held",
      }),
      expect(queued).rejects.toMatchObject({
        code: "work_items_native_capacity_held",
      }),
    ]);
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(
        adapter.create({ type: "task", title: "retry" }, "principal-1")
      ).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
    expect(queries).toEqual(["SELECT 1 AS work_items_ready"]);
    expect(reserved).toBe(0);
    expect(ended).toBe(0);
    expect(replacements).toBe(0);
    await expect(adapter.get(toWorkItemId("task.9998"))).resolves.toBeNull();
    stalled = false;
    prime.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reserved).toBe(0);
    await expect(
      adapter.patch(
        { id: toWorkItemId("task.9998"), set: { title: "fresh intent" } },
        "principal-1"
      )
    ).rejects.toThrow(/not found/);
    expect(reserved).toBe(1);
    expect(queries.some((query) => /INSERT|UPDATE|DELETE/.test(query))).toBe(
      false
    );
    expect(ended).toBe(0);
  });

  it("retains reader generations until actual native outcomes and never creates a third while held", async () => {
    const first = deferred<Rows>();
    const second = deferred<Rows>();
    const outcomes = [first.promise, second.promise, Promise.resolve([])];
    const ended: number[] = [];
    let created = 0;
    const reader = () => {
      const index = created++;
      return {
        options: { max: 1 },
        unsafe: () => outcomes[index],
        end: async () => {
          ended.push(index);
        },
      } as unknown as Sql;
    };
    const adapter = new DoltgresWorkItemAdapter({} as Sql, {
      readClient: reader(),
      recreateReadClient: reader,
      readConnectionBudget: 2,
      queryTimeoutMs: 5,
    });
    await expect(adapter.get(toWorkItemId("task.9998"))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    expect(ended).toEqual([]);
    await expect(adapter.get(toWorkItemId("task.9998"))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    await expect(adapter.get(toWorkItemId("task.9998"))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    expect(created).toBe(2);
    expect(ended).toEqual([]);
    first.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ended).toEqual([0]);
    await expect(adapter.get(toWorkItemId("task.9998"))).resolves.toBeNull();
    expect(created).toBe(3);
    second.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ended).toEqual([0, 1]);
  });

  it("transport rejection quarantines a reader slot instead of replenishing native capacity", async () => {
    let created = 0;
    let ended = 0;
    const held = deferred<Rows>();
    const reader = () => {
      const index = created++;
      return {
        options: { max: 1 },
        unsafe: () =>
          index === 0
            ? Promise.reject(
                Object.assign(new Error("lost transport"), {
                  code: "CONNECTION_CLOSED",
                })
              )
            : held.promise,
        end: async () => {
          ended++;
        },
      } as unknown as Sql;
    };
    const adapter = new DoltgresWorkItemAdapter({} as Sql, {
      readClient: reader(),
      recreateReadClient: reader,
      readConnectionBudget: 2,
      queryTimeoutMs: 5,
    });
    await expect(adapter.get(toWorkItemId("task.9998"))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    await expect(adapter.get(toWorkItemId("task.9998"))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    await expect(adapter.get(toWorkItemId("task.9998"))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    expect(created).toBe(2);
    expect(ended).toBe(0);
    held.resolve([]);
  });
});

describe("DoltgresWorkItemAdapter merge timeout recovery", () => {
  it("proves a durable merge after an authoritative server error without replaying", async () => {
    const { adapter, events, state } = makeTimeoutHarness();

    const created = await adapter.create(
      { type: "task", title: "survives timeout" },
      "principal-1"
    );
    expect(created.id).toBe("task.0001");
    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(2);
    expect(
      state.queries.some((query) =>
        query.startsWith("pool-2:SELECT dolt_merge_base")
      )
    ).toBe(true);
    expect(events).toContain("adapter.work_items.stage_complete");

    await expect(adapter.get(toWorkItemId("task.0001"))).resolves.toMatchObject(
      { title: "survives timeout" }
    );
    await expect(
      adapter.patch(
        {
          id: toWorkItemId("task.0001"),
          set: { title: "still writable" },
        },
        "principal-1"
      )
    ).resolves.toMatchObject({ title: "still writable" });
    expect(state.inserts).toBe(1);
  });

  it("uses historical proof after a terminal server error when a later commit changed the row", async () => {
    const { adapter, state } = makeTimeoutHarness({
      laterMainUpdateAfterLostAck: true,
    });

    await expect(
      adapter.create({ type: "task", title: "survives timeout" }, "principal-1")
    ).resolves.toMatchObject({
      id: "task.0001",
      title: "survives timeout",
    });

    expect(state.inserts).toBe(1);
    await expect(adapter.get(toWorkItemId("task.0001"))).resolves.toMatchObject(
      {
        title: "later serialized update",
        revision: 1,
      }
    );
  });

  it("retains native capacity and refuses replay after a post-DML caller timeout", async () => {
    const { adapter, state } = makeTimeoutHarness({ timeoutAfterDml: true });

    await expect(
      within(
        adapter.create(
          { type: "task", title: "times out after DML" },
          "principal-1"
        )
      )
    ).rejects.toBeInstanceOf(WorkItemWriteOutcomeUnknownError);

    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(1);
    expect(state.deadUnlockAttempts).toBe(0);
    await expect(within(adapter.get(toWorkItemId("task.0001")))).resolves.toBe(
      null
    );
    await expect(within(adapter.list())).resolves.toMatchObject({ items: [] });
    await expect(
      within(
        adapter.create(
          { type: "task", title: "successor create" },
          "principal-1"
        )
      )
    ).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
    expect(state.inserts).toBe(1);
    expect(state.deadUnlockAttempts).toBe(0);
  });

  it("acknowledges a proven mutation while retaining native capacity for pending cleanup", async () => {
    const { adapter, state } = makeTimeoutHarness({
      timeoutFreshHousekeeping: true,
    });

    await expect(
      within(
        adapter.create(
          { type: "task", title: "nested recovery" },
          "principal-1"
        )
      )
    ).resolves.toMatchObject({ id: "task.0001" });

    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(2);
    expect(state.deadUnlockAttempts).toBe(0);
    await expect(
      within(adapter.get(toWorkItemId("task.0001")))
    ).resolves.toMatchObject({ id: "task.0001" });
    await expect(within(adapter.list())).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "task.0001" })],
    });
    await expect(
      within(
        adapter.create(
          { type: "bug", title: "successor create" },
          "principal-1"
        )
      )
    ).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
    expect(state.inserts).toBe(1);
    expect(state.deadUnlockAttempts).toBe(0);
  });

  it("returns a nonretryable current-intent receipt when durable outcome cannot be proven", async () => {
    const { adapter, events, state } = makeTimeoutHarness({
      failFreshReachability: true,
    });

    await expect(
      adapter.create(
        { type: "task", title: "ambiguous durable merge" },
        "principal-1"
      )
    ).rejects.toMatchObject({
      name: "WorkItemWriteOutcomeUnknownError",
      code: "work_item_write_outcome_unknown",
      retryable: false,
      receipt: {
        code: "work_item_write_outcome_unknown",
        retryable: false,
        lookup: {
          operationId: expect.any(String),
          branch: expect.stringMatching(/^work-item-op\//),
          commitHash: "test-commit-1",
          itemId: "task.0001",
        },
      },
    });

    expect(state.durable).toBe(true);
    expect(state.inserts).toBe(1);
    expect(state.poolBuilds).toBe(2);
    expect(state.branch).toMatch(/^work-item-op\//);
    expect(events).toContain("adapter.work_items.reconcile");

    // The read serves the committed row while the evidence branch still
    // stands, and — unlike before 0.1.7 — does NOT clean it up. Reconciliation
    // renames or drops a branch, which is a WRITE; having it ride along on
    // `get` violated COMMAND_QUERY_SEPARATION (docs/spec/work-items-port.md)
    // and was the reason a read had to take the write lock at all.
    await expect(adapter.get(toWorkItemId("task.0001"))).resolves.toMatchObject(
      {
        id: "task.0001",
      }
    );
    expect(state.inserts).toBe(1);
    expect(state.branch).toMatch(/^work-item-op\//);

    // Transport loss is not native completion: do not replace or replay it.
    await expect(
      adapter.create({ type: "bug", title: "successor" }, "principal-1")
    ).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
    expect(state.inserts).toBe(1);
    expect(state.branch).toMatch(/^work-item-op\//);
  });
  it("old orphan preflight failure stays retryable because the current intent never runs", async () => {
    const { adapter, state } = makeTimeoutHarness({
      failFreshReachability: true,
    });
    await expect(
      adapter.create({ type: "task", title: "prior unknown" }, "principal-1")
    ).rejects.toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
    state.failHistoricalReachability = true;
    const error = await adapter
      .create({ type: "bug", title: "new intent never runs" }, "principal-1")
      .catch((error) => error);
    expect(error).toBeInstanceOf(WorkItemsBusyError);
    expect(error).not.toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
    expect(error.receipt).toBeUndefined();
    expect(state.inserts).toBe(1);
  });
});

// Operator production, 2026-10-09: ONE budget covered DML and ref housekeeping
// alike, `dolt_branch` exceeded 5s under load, `terminateClient` destroyed the
// pool, and the PATCH returned 500 AFTER its merge had already landed on
// `main`. The same 5s then killed the quarantine rename — the one operation
// whose job is to clear a stuck branch — so writes stayed down with the
// bug.5358 fix deployed.
describe("ref housekeeping gets its own budget", () => {
  // 60ms is 12x the harness DML budget (queryTimeoutMs: 5). The SAME delay is
  // used in both cases, so the budget is the only variable — the assertions
  // turn on the separation, not on the delay.
  const SLOW_CHECKOUT_MS = 60;

  it("survives a dolt_checkout slower than the DML budget", async () => {
    const { adapter, state } = makeTimeoutHarness({
      slowCheckoutMs: SLOW_CHECKOUT_MS,
      branchTimeoutMs: 1_000,
      mergeMode: "success",
    });

    await expect(
      adapter.create({ type: "task", title: "slow checkout" }, "principal-1")
    ).resolves.toMatchObject({ id: "task.0001" });
    expect(state.durable).toBe(true);
    // Non-vacuous: the slow query really was the ref-movement one.
    expect(state.queries.some((q) => /dolt_checkout\('-b'/.test(q))).toBe(true);
  });

  it("still fails closed when the housekeeping budget itself is exceeded", async () => {
    const { adapter } = makeTimeoutHarness({
      slowCheckoutMs: SLOW_CHECKOUT_MS,
      branchTimeoutMs: 10,
    });

    await expect(
      adapter.create({ type: "task", title: "blown budget" }, "principal-1")
    ).rejects.toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
  });
});
