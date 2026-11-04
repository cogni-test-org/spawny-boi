// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Behavioral proof for isolated logical writes; native engine semantics remain a CI gate. */
import { describe, expect, it, vi } from "vitest";
import {
  DoltBranchMutationUncertainError,
  runDoltBranchMutation,
  reconcileAbandonedDoltOperation,
  captureDoltPersistedCleanEdit,
  captureDoltFreshCleanEdit,
} from "../src/branch-mutation.js";
import {
  acquireDoltWriterLocks,
  type DoltWriterConnection,
} from "../src/locks.js";

const HASH = "a".repeat(32);
const BASE = "b".repeat(32);
function engine(
  overrides: {
    lostMergeAck?: boolean;
    cleanupFails?: boolean;
    callbackSqlFails?: boolean;
    existing?: boolean;
    malformedMerge?: boolean;
    commitFails?: boolean;
    targetDirty?: boolean;
  } = {}
) {
  let active = "main";
  let dirty = false;
  let head = BASE;
  let mergeRows: Record<string, unknown>[] = [{ is_merging: false }];
  let conflicts: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const connection: DoltWriterConnection = {
    async unsafe(query) {
      queries.push(query);
      if (query.includes("current_database()"))
        return [{ dolt_writer_database: "knowledge_operator" }];
      if (query.includes("pg_try_advisory_lock"))
        return [{ pg_try_advisory_lock: true }];
      if (query.includes("pg_advisory_unlock"))
        return [{ pg_advisory_unlock: true }];
      if (query.startsWith("SELECT name FROM dolt.branches"))
        return overrides.existing ? [{ name: "retained" }] : [];
      if (query === "SELECT dolt_checkout('main')") {
        active = "main";
        return [{ dolt_checkout: 0 }];
      }
      if (query.startsWith("SELECT dolt_checkout('-b'")) {
        active = query.split("'")[3] ?? "";
        return [{ dolt_checkout: 0 }];
      }
      if (query.startsWith("SELECT dolt_checkout('contrib/")) {
        active = query.split("'")[1] ?? "";
        if (overrides.targetDirty) dirty = true;
        return [{ dolt_checkout: 0 }];
      }
      if (query.includes("active_branch()")) return [{ branch_name: active }];
      if (query === "SELECT is_merging FROM dolt.merge_status")
        return mergeRows;
      if (query === "SELECT * FROM dolt.conflicts") return conflicts;
      if (query === "SELECT * FROM dolt.status")
        return dirty ? [{ table_name: "knowledge" }] : [];
      if (query === "INSERT domain row") {
        dirty = true;
        if (overrides.callbackSqlFails) throw new Error("connection lost");
        return [];
      }
      if (query.startsWith("SELECT dolt_reset")) {
        expect(active).not.toBe("main");
        dirty = false;
        return [{ dolt_reset: 0 }];
      }
      if (query.startsWith("SELECT dolt_commit")) {
        if (overrides.commitFails) throw new Error("terminal commit failed");
        dirty = false;
        head = HASH;
        return [{ dolt_commit: [HASH] }];
      }
      if (query.startsWith("SELECT dolt_hashof"))
        return [{ commit_hash: query.includes("'HEAD'") ? head : HASH }];
      if (query.startsWith("SELECT hash, fast_forward")) {
        if (overrides.lostMergeAck)
          throw new Error("merge acknowledgement lost");
        return overrides.malformedMerge
          ? [{}]
          : [
              {
                hash: HASH,
                fast_forward: true,
                conflicts: 0,
                message: "merged",
              },
            ];
      }
      if (query.startsWith("SELECT dolt_merge_base"))
        return [{ merge_base: HASH }];
      if (query.startsWith("SELECT dolt_branch('-D'")) {
        if (overrides.cleanupFails) throw new Error("cleanup failed");
        return [{ dolt_branch: 0 }];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return {
    connection,
    queries,
    setActive: (value: string) => {
      active = value;
    },
    setHead: (value: string) => {
      head = value;
    },
    setDirty: (value: boolean) => {
      dirty = value;
    },
    setMerge: (value: Record<string, unknown>[]) => {
      mergeRows = value;
    },
    setConflicts: (value: Record<string, unknown>[]) => {
      conflicts = value;
    },
  };
}
async function setup(options: Parameters<typeof engine>[0] = {}) {
  const fixture = engine(options);
  const guard = await acquireDoltWriterLocks(fixture.connection);
  const poison = vi.fn(async () => {});
  return { ...fixture, guard, poison };
}

describe("runDoltBranchMutation", () => {
  it("commits one logical unit and proves its exact hash on main", async () => {
    const f = await setup();
    const result = await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "knowledge:test",
      message: "entry plus edge",
      onSessionUncertain: f.poison,
      run: async (sql) => {
        await sql.unsafe("INSERT domain row");
        return "result";
      },
    });
    expect(result).toEqual({
      value: "result",
      commitHash: HASH,
      cleanupUncertain: false,
    });
    expect(
      f.queries.filter((q) => q.startsWith("SELECT dolt_commit"))
    ).toHaveLength(1);
    expect(f.poison).not.toHaveBeenCalled();
  });
  it("requires a real guard before issuing mutation SQL", async () => {
    const f = await setup();
    await f.guard.release();
    const count = f.queries.length;
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        run: async () => {},
        onSessionUncertain: f.poison,
      })
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(count);
  });
  it("refuses a retained operation without replaying its callback", async () => {
    const f = await setup({ existing: true });
    const run = vi.fn(async () => {});
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        run,
        onSessionUncertain: f.poison,
      })
    ).rejects.toMatchObject({
      reason: "existing_operation_branch",
      retryable: false,
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("cleans domain failure only by resetting its owned branch before switching to main", async () => {
    const f = await setup();
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
          throw new Error("invalid citation");
        },
      })
    ).rejects.toThrow("invalid citation");
    const reset = f.queries.findIndex((q) => q.startsWith("SELECT dolt_reset"));
    expect(reset).toBeGreaterThan(0);
    expect(
      f.queries.indexOf("SELECT dolt_checkout('main')", reset)
    ).toBeGreaterThan(reset);
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_commit"))).toBe(
      false
    );
  });
  it("preserves query uncertainty even when the disposer throws", async () => {
    const f = await setup({ callbackSqlFails: true });
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: async () => {
          throw new Error("disposer failed");
        },
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
        },
      })
    ).rejects.toBeInstanceOf(DoltBranchMutationUncertainError);
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_branch('-D'"))).toBe(
      false
    );
  });
  it("classifies a lost merge acknowledgement by exact ancestry", async () => {
    const f = await setup({ lostMergeAck: true });
    expect(
      (
        await runDoltBranchMutation(f.connection, {
          guard: f.guard,
          operationId: "x",
          message: "x",
          onSessionUncertain: f.poison,
          run: async (sql) => {
            await sql.unsafe("INSERT domain row");
          },
        })
      ).commitHash
    ).toBe(HASH);
  });
  it("preserves committed success when branch cleanup acknowledgement fails", async () => {
    const f = await setup({ cleanupFails: true });
    const result = await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "x",
      message: "x",
      onSessionUncertain: f.poison,
      run: async (sql) => {
        await sql.unsafe("INSERT domain row");
      },
    });
    expect(result.cleanupUncertain).toBe(true);
    expect(result.commitHash).toBe(HASH);
    expect(f.poison).toHaveBeenCalledOnce();
  });
  it("rejects escaped SQL after scope closure", async () => {
    const f = await setup();
    let escaped!: DoltWriterConnection;
    await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "x",
      message: "x",
      onSessionUncertain: f.poison,
      run: async (sql) => {
        escaped = sql;
      },
    });
    const count = f.queries.length;
    await expect(escaped.unsafe("INSERT domain row")).rejects.toThrow(
      "scope has closed"
    );
    expect(f.queries).toHaveLength(count);
  });
  it("never treats a malformed merge receipt as success", async () => {
    const f = await setup({ malformedMerge: true });
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
        },
      })
    ).rejects.toMatchObject({
      reason: "merge_result_invalid",
      retryable: false,
    });
  });
  it("never commits after the callback swallowed a database rejection", async () => {
    const f = await setup({ callbackSqlFails: true });
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run: async (sql) => {
          try {
            await sql.unsafe("INSERT domain row");
          } catch {
            /* application swallowed it */
          }
        },
      })
    ).rejects.toMatchObject({ retryable: false });
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_commit"))).toBe(
      false
    );
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_reset"))).toBe(
      false
    );
    expect(f.poison).toHaveBeenCalledOnce();
  });
  it("never resets while an unawaited query is pending when the callback throws", async () => {
    const f = await setup();
    const previous = f.connection.unsafe.bind(f.connection);
    let finish!: (rows: readonly Record<string, unknown>[]) => void;
    const pending = new Promise<readonly Record<string, unknown>[]>(
      (resolve) => {
        finish = resolve;
      }
    );
    f.connection.unsafe = (query) =>
      query === "INSERT deferred" ? pending : previous(query);
    try {
      await expect(
        runDoltBranchMutation(f.connection, {
          guard: f.guard,
          operationId: "x",
          message: "x",
          onSessionUncertain: f.poison,
          run: async (sql) => {
            void sql.unsafe("INSERT deferred");
            throw new Error("domain rejection");
          },
        })
      ).rejects.toMatchObject({ retryable: false });
      expect(f.queries.some((q) => q.startsWith("SELECT dolt_reset"))).toBe(
        false
      );
      expect(
        f.queries.some((q) => q.startsWith("SELECT dolt_branch('-D'"))
      ).toBe(false);
      expect(f.poison).toHaveBeenCalledOnce();
    } finally {
      finish([]);
    }
  });
  it("never checks out main over a dirty current working set", async () => {
    const f = await setup();
    const previous = f.connection.unsafe.bind(f.connection);
    f.connection.unsafe = (query) =>
      query === "SELECT * FROM dolt.status"
        ? Promise.resolve([{ table_name: "foreign_dirty" }])
        : previous(query);
    const run = vi.fn(async () => {});
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run,
      })
    ).rejects.toMatchObject({
      reason: "current_working_set_is_dirty",
      retryable: false,
    });
    expect(f.queries).not.toContain("SELECT dolt_checkout('main')");
    expect(run).not.toHaveBeenCalled();
    expect(f.poison).toHaveBeenCalledOnce();
  });
  it("reconciles settled uncommitted DML only on its proven original owned branch and preserves the ref", async () => {
    const f = await setup({ callbackSqlFails: true });
    let reconcile!: () => Promise<boolean>;
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "owned:settled",
        message: "owned",
        onSessionUncertain: f.poison,
        onReconcile: (plan) => {
          reconcile = plan;
        },
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
        },
      })
    ).rejects.toBeInstanceOf(DoltBranchMutationUncertainError);
    const before = f.queries.length;
    await expect(reconcile()).resolves.toBe(true);
    const cleanup = f.queries.slice(before);
    expect(cleanup).toContain("SELECT dolt_reset('--hard', 'HEAD')");
    expect(cleanup.indexOf("SELECT dolt_checkout('main')")).toBeGreaterThan(
      cleanup.indexOf("SELECT dolt_reset('--hard', 'HEAD')")
    );
    expect(
      cleanup.some((query) =>
        /dolt_commit|dolt_merge\(|dolt_branch\(/.test(query)
      )
    ).toBe(false);
    expect(
      f.queries.filter((query) => query === "INSERT domain row")
    ).toHaveLength(1);
  });

  it.each([
    "foreign",
    "head-moved",
    "commit-attempt",
    "merge",
    "conflicts",
    "empty-merge-proof",
  ])("refuses unsafe reconciliation: %s", async (scenario) => {
    const f = await setup({ callbackSqlFails: true });
    let reconcile!: () => Promise<boolean>;
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "owned:guarded",
        message: "owned",
        onSessionUncertain: f.poison,
        onReconcile: (plan) => {
          reconcile = plan;
        },
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
        },
      })
    ).rejects.toBeInstanceOf(DoltBranchMutationUncertainError);
    if (scenario === "foreign") f.setActive("foreign/branch");
    if (scenario === "head-moved") f.setHead(HASH);
    if (scenario === "merge") f.setMerge([{ is_merging: true }]);
    if (scenario === "conflicts")
      f.setConflicts([{ table: "knowledge", num_conflicts: 1 }]);
    if (scenario === "empty-merge-proof") f.setMerge([]);
    const before = f.queries.length;
    if (scenario === "commit-attempt") {
      const branch = f.queries
        .find((query) => query.startsWith("SELECT dolt_checkout('-b'"))
        ?.split("'")[3];
      await expect(
        reconcileAbandonedDoltOperation(f.connection, {
          guard: f.guard,
          branch,
          baseHash: BASE,
          creationProven: true,
          commitAttempted: true,
          mergeAttempted: false,
        })
      ).resolves.toBe(false);
    } else await expect(reconcile()).resolves.toBe(false);
    expect(
      f.queries
        .slice(before)
        .some((query) => /dolt_reset|dolt_checkout|dolt_branch/.test(query))
    ).toBe(false);
  });

  it("keeps a dirty branch after a terminal failed COMMIT as an explicit recovery case", async () => {
    const f = await setup({ commitFails: true });
    let reconcile!: () => Promise<boolean>;
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "owned:commit-failed",
        message: "owned",
        onSessionUncertain: f.poison,
        onReconcile: (plan) => {
          reconcile = plan;
        },
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
        },
      })
    ).rejects.toBeInstanceOf(DoltBranchMutationUncertainError);
    const before = f.queries.length;
    await expect(reconcile()).resolves.toBe(false);
    expect(
      f.queries
        .slice(before)
        .some((query) => /dolt_reset|dolt_checkout/.test(query))
    ).toBe(false);
  });

  it("hands the proven result to its owner before deferred ref cleanup", async () => {
    const f = await setup();
    let cleanup!: () => Promise<void>;
    const committed = vi.fn((result, plan: () => Promise<void>) => {
      cleanup = plan;
      expect(result).toEqual({ value: 42, commitHash: HASH });
    });
    const result = await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "owned:ack",
      message: "owned",
      onSessionUncertain: f.poison,
      onCommitted: committed,
      run: async (sql) => {
        await sql.unsafe("INSERT domain row");
        return 42;
      },
    });
    expect(result.value).toBe(42);
    expect(committed).toHaveBeenCalledOnce();
    expect(
      f.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    await cleanup();
    expect(
      f.queries.filter((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toHaveLength(1);
  });

  it("preserves proven success and the ref when its notification observer throws", async () => {
    const f = await setup();
    const result = await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "owned:observer",
      message: "owned",
      onSessionUncertain: f.poison,
      onCommitted: () => {
        throw new Error("observer bug");
      },
      run: async (sql) => {
        await sql.unsafe("INSERT domain row");
        return 42;
      },
    });
    expect(result).toEqual({
      value: 42,
      commitHash: HASH,
      cleanupUncertain: true,
    });
    expect(
      f.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
  });
  it("deferred callbacks reject a released guard before issuing any SQL", async () => {
    const f = await setup();
    let cleanup!: () => Promise<void>;
    let reconcile!: () => Promise<boolean>;
    await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "owned:closed-guard",
      message: "owned",
      onSessionUncertain: f.poison,
      onReconcile: (plan) => {
        reconcile = plan;
      },
      onCommitted: (_result, plan) => {
        cleanup = plan;
      },
      run: async (sql) => {
        await sql.unsafe("INSERT domain row");
      },
    });
    await f.guard.release();
    const count = f.queries.length;
    await expect(cleanup()).rejects.toMatchObject({ reason: "guard_invalid" });
    await expect(reconcile()).rejects.toMatchObject({
      reason: "guard_invalid",
    });
    expect(f.queries).toHaveLength(count);
  });
});

describe("persisted clean edit receipts", () => {
  it.each([false, true])(
    "an interrupted capture restores only a clean target; dirty=%s",
    async (dirty) => {
      const f = await setup();
      let staged:
        | Awaited<ReturnType<typeof captureDoltPersistedCleanEdit>>
        | undefined;
      await expect(
        captureDoltPersistedCleanEdit(f.connection, {
          guard: f.guard,
          branch: "contrib/existing",
          expectedHead: BASE,
          onCaptured: (receipt) => {
            staged = receipt;
            throw new Error("public capture abandoned before return");
          },
        })
      ).rejects.toThrow();
      // Model the positive native checkout settling after its public deadline.
      f.setActive("contrib/existing");
      f.setDirty(dirty);
      const before = f.queries.length;
      await expect(
        reconcileAbandonedDoltOperation(f.connection, {
          guard: f.guard,
          creationProven: false,
          commitAttempted: false,
          mergeAttempted: false,
          persistedCleanEdit: staged,
        })
      ).resolves.toBe(!dirty);
      expect(
        f.queries.slice(before).some((q) => q.includes("dolt_reset"))
      ).toBe(false);
    }
  );
  it("discards only new uncommitted edits while preserving existing HEAD and ref", async () => {
    const f = await setup();
    const receipt = await captureDoltPersistedCleanEdit(f.connection, {
      guard: f.guard,
      branch: "contrib/existing",
      expectedHead: BASE,
    });
    f.setDirty(true);
    await expect(
      reconcileAbandonedDoltOperation(f.connection, {
        guard: f.guard,
        creationProven: false,
        commitAttempted: false,
        mergeAttempted: false,
        persistedCleanEdit: receipt,
      })
    ).resolves.toBe(true);
    expect(f.queries.filter((q) => q.includes("dolt_reset"))).toEqual([
      "SELECT dolt_reset('--hard', 'HEAD')",
    ]);
    expect(f.queries.some((q) => /dolt_commit|dolt_branch/.test(q))).toBe(
      false
    );
    await f.guard.release();
  });
  it.each([
    "dirty-main",
    "dirty-target",
    "changed-head",
    "invalidated",
    "forged",
    "foreign-session",
    "commit",
    "merge",
    "conflicts",
  ])("fails closed for %s", async (condition) => {
    const f = await setup();
    if (condition === "dirty-main") {
      f.setDirty(true);
      await expect(
        captureDoltPersistedCleanEdit(f.connection, {
          guard: f.guard,
          branch: "contrib/existing",
          expectedHead: BASE,
        })
      ).rejects.toThrow();
      return;
    }
    if (condition === "dirty-target") {
      const target = await setup({ targetDirty: true });
      await expect(
        captureDoltPersistedCleanEdit(target.connection, {
          guard: target.guard,
          branch: "contrib/existing",
          expectedHead: BASE,
        })
      ).rejects.toThrow();
      return;
    }
    const receipt = await captureDoltPersistedCleanEdit(f.connection, {
      guard: f.guard,
      branch: "contrib/existing",
      expectedHead: BASE,
    });
    f.setDirty(true);
    if (condition === "changed-head") f.setHead(HASH);
    if (condition === "invalidated") receipt.invalidate();
    if (condition === "merge") f.setMerge([{ is_merging: true }]);
    if (condition === "conflicts") f.setConflicts([{ table: "knowledge" }]);
    let supplied = receipt;
    if (condition === "forged") supplied = { ...receipt };
    if (condition === "foreign-session") {
      const other = await setup();
      other.setActive("contrib/existing");
      other.setDirty(true);
      await expect(
        reconcileAbandonedDoltOperation(other.connection, {
          guard: other.guard,
          creationProven: false,
          commitAttempted: false,
          mergeAttempted: false,
          persistedCleanEdit: supplied,
        })
      ).resolves.toBe(false);
      expect(other.queries.some((q) => q.includes("dolt_reset"))).toBe(false);
      return;
    }
    const before = f.queries.length;
    await expect(
      reconcileAbandonedDoltOperation(f.connection, {
        guard: f.guard,
        creationProven: false,
        commitAttempted: condition === "commit",
        mergeAttempted: condition === "merge",
        persistedCleanEdit: supplied,
      })
    ).resolves.toBe(false);
    expect(
      f.queries.slice(before).some((q) => /dolt_reset|dolt_checkout/.test(q))
    ).toBe(false);
  });
});

describe("fresh clean edit creation receipt", () => {
  it("owns a native new branch and resets only its uncommitted delta at the captured MAIN head", async () => {
    const f = await setup();
    const receipt = await captureDoltFreshCleanEdit(f.connection, {
      guard: f.guard,
      branch: "contrib/new",
    });
    expect(receipt.head).toBe(BASE);
    await f.connection.unsafe("INSERT domain row");
    const before = f.queries.length;
    await expect(
      reconcileAbandonedDoltOperation(f.connection, {
        guard: f.guard,
        creationProven: false,
        commitAttempted: false,
        mergeAttempted: false,
        freshCleanEdit: receipt,
      })
    ).resolves.toBe(true);
    const cleanup = f.queries.slice(before);
    expect(cleanup).toContain("SELECT dolt_reset('--hard', 'HEAD')");
    expect(cleanup.indexOf("SELECT dolt_checkout('main')")).toBeGreaterThan(
      cleanup.indexOf("SELECT dolt_reset('--hard', 'HEAD')")
    );
    expect(
      cleanup.some((query) =>
        /dolt_commit|dolt_merge\(|dolt_branch\(/.test(query)
      )
    ).toBe(false);
  });
  it.each(["dirty-main", "existing-target"] as const)(
    "refuses %s before native creation",
    async (condition) => {
      const f = await setup({ existing: condition === "existing-target" });
      if (condition === "dirty-main") f.setDirty(true);
      await expect(
        captureDoltFreshCleanEdit(f.connection, {
          guard: f.guard,
          branch: "contrib/new",
        })
      ).rejects.toThrow();
      expect(
        f.queries.some((query) => /dolt_checkout|dolt_reset/.test(query))
      ).toBe(false);
    }
  );
  it.each([
    "head-moved",
    "invalidated",
    "forged",
    "foreign-session",
    "commit",
    "merge",
    "conflicts",
  ] as const)("denies reset for %s", async (condition) => {
    const f = await setup();
    const receipt = await captureDoltFreshCleanEdit(f.connection, {
      guard: f.guard,
      branch: "contrib/new",
    });
    f.setDirty(true);
    if (condition === "head-moved") f.setHead(HASH);
    if (condition === "invalidated") receipt.invalidate();
    if (condition === "merge") f.setMerge([{ is_merging: true }]);
    if (condition === "conflicts")
      f.setConflicts([{ table_name: "knowledge" }]);
    const target = condition === "foreign-session" ? await setup() : f;
    if (target !== f) {
      target.setActive("contrib/new");
      target.setDirty(true);
    }
    const before = target.queries.length;
    await expect(
      reconcileAbandonedDoltOperation(target.connection, {
        guard: target.guard,
        creationProven: false,
        commitAttempted: condition === "commit",
        mergeAttempted: condition === "merge",
        freshCleanEdit: condition === "forged" ? { ...receipt } : receipt,
      })
    ).resolves.toBe(false);
    expect(
      target.queries
        .slice(before)
        .some((query) => /dolt_reset|dolt_checkout/.test(query))
    ).toBe(false);
  });
  it("does not reset dirty state if the new target's clean entry was never verified", async () => {
    const f = await setup();
    const native = f.connection.unsafe.bind(f.connection);
    let receipt:
      | Awaited<ReturnType<typeof captureDoltFreshCleanEdit>>
      | undefined;
    f.connection.unsafe = async (query) => {
      const rows = await native(query);
      if (query.startsWith("SELECT dolt_checkout('-b'")) {
        f.setDirty(true);
        throw new Error("creation acknowledgement unavailable");
      }
      return rows;
    };
    await expect(
      captureDoltFreshCleanEdit(f.connection, {
        guard: f.guard,
        branch: "contrib/new",
        onCaptured: (value) => {
          receipt = value;
        },
      })
    ).rejects.toThrow();
    expect(receipt).toBeDefined();
    const before = f.queries.length;
    await expect(
      reconcileAbandonedDoltOperation(f.connection, {
        guard: f.guard,
        creationProven: false,
        commitAttempted: false,
        mergeAttempted: false,
        freshCleanEdit: receipt,
      })
    ).resolves.toBe(false);
    expect(
      f.queries
        .slice(before)
        .some((query) => /dolt_reset|dolt_checkout/.test(query))
    ).toBe(false);
  });
});

describe("clean persisted entry rejection", () => {
  it.each([false, true])(
    "restores MAIN only while the rejected clean target keeps its observed HEAD (laterMove=%s)",
    async (laterMove) => {
      const f = await setup();
      f.setHead(HASH);
      let receipt:
        | Awaited<ReturnType<typeof captureDoltPersistedCleanEdit>>
        | undefined;
      await expect(
        captureDoltPersistedCleanEdit(f.connection, {
          guard: f.guard,
          branch: "contrib/existing",
          expectedHead: BASE,
          onCaptured: (value) => {
            receipt = value;
          },
        })
      ).rejects.toThrow();
      if (laterMove) f.setHead(BASE);
      const before = f.queries.length;
      await expect(
        reconcileAbandonedDoltOperation(f.connection, {
          guard: f.guard,
          creationProven: false,
          commitAttempted: false,
          mergeAttempted: false,
          persistedCleanEdit: receipt,
        })
      ).resolves.toBe(!laterMove);
      expect(
        f.queries
          .slice(before)
          .some((query) => /dolt_reset|dolt_commit|dolt_branch/.test(query))
      ).toBe(false);
      expect(
        f.queries.slice(before).includes("SELECT dolt_checkout('main')")
      ).toBe(!laterMove);
    }
  );
});
