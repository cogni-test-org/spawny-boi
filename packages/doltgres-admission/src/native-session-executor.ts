// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Native session lifetime executor extracted mechanically from the knowledge runner.
 * Injected bounded pool only. Owns FIFO/deadline/settlement/cleanup; callers own domain errors and telemetry.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { acquireDoltWriterLocks, DoltWriterAdmissionError } from "./locks.js";
import { reconcileAbandonedDoltOperation } from "./branch-mutation.js";
export interface DoltNativeReservedConnection {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
  release(): void;
}
export interface DoltNativeWriterPool {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
  reserve(): PromiseLike<DoltNativeReservedConnection>;
}
export interface DoltNativeSessionErrors {
  busy(message: string): Error;
  outcomeUnknown(
    operationId: string,
    branch: string,
    commitHash?: string
  ): Error;
  fault(message: string): Error;
}

export interface DoltNativeWriteConnection {
  unsafe(
    query: string
  ): Promise<readonly Record<string, unknown>[] & { readonly count?: number }>;
}
export interface DoltNativeWriterGuard {
  readonly baseDatabase: string;
  readonly protocol: "bridge" | "database";
  readonly keys: readonly string[];
  release(): Promise<void>;
}

interface NativeOperation {
  readonly operationId: string;
  branch: string;
  effectsPossible: boolean;
  commitHash?: string;
  abandoned?: Error;
  rejectCaller?: (error: Error) => void;
  transportUnknown?: boolean;
  /** This operation's outcome is uncertain (quarantine path), independent of the
   * now-evicted pool flag — the caller must still receive `outcomeUnknown`. */
  outcomeUncertain?: boolean;
  admitting?: boolean;
  closed?: boolean;
  reconciliationRequired?: boolean;
  reconcile?: () => Promise<boolean>;
  committedCleanup?: () => Promise<void>;
  readonly pending: Set<Promise<unknown>>;
}

/** How long a queued operation waits for its turn before giving up. */
export const QUEUE_WAIT_MS = 30_000;
/**
 * How long to wait for a session-pinned connection once admitted.
 *
 * Covers the priming query AND the reserve: on an exhausted pool the prime is
 * what hangs, so bounding only the reserve bounds nothing.
 */
export const ACQUIRE_TIMEOUT_MS = 5_000;
/** How long to spin for the cross-replica advisory lock. */
export const LOCK_WAIT_MS = 2_000;
/** Gap between advisory-lock attempts. */
export const LOCK_RETRY_MS = 50;

export interface DoltNativeSessionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const noopLogger: DoltNativeSessionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface DoltNativeSessionOptions {
  readonly errors: DoltNativeSessionErrors;
  readonly logger?: DoltNativeSessionLogger;
  readonly queueWaitMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  readonly writerProtocol?: "bridge" | "database";
  readonly queryTimeoutMs?: number;
}

function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorMessage: String(error) };
}

/**
 * Serializes Dolt branch operations and hands each one a proven session.
 *
 * WHY ADMISSION CONTROL AND NOT A BIGGER POOL (bug.5391, mirroring the proven
 * `@cogni/work-items` shape):
 *
 * Every Dolt branch operation needs a session-pinned connection, because
 * `dolt_checkout` is session state. postgres.js exposes that as `reserve()`,
 * and a reserved connection is pinned for the WHOLE operation — on Doltgres
 * that is several seconds of `dolt_merge`/`dolt_commit`/`dolt_branch` under
 * load (bug.5395 measured a lease p99 of 4330ms).
 *
 * Two failure modes compound on the shared `max: 5` pool that also serves
 * reads:
 *
 *   - Starvation. Concurrent branch ops hold their reserved connections for
 *     seconds. Once every slot is held, the next caller's query is parked on
 *     postgres.js's UNBOUNDED `queries` backlog with no deadline of its own —
 *     so reads hang right alongside the writes. That is the prod signature:
 *     four `knowledge.contributions.close` calls timing out in the same second
 *     while the list route intermittently stopped answering (bug.5391).
 *   - A cold `reserve()` that never settles. On a `fetch_types: false` client —
 *     mandatory for Doltgres — `ReadyForQuery` skips `fetchArrayTypes()`, so
 *     `onopen` never fires, and `onopen` is the only caller of
 *     `query.reserve(c)`. `connect_timeout` was already cancelled, so nothing
 *     rescues it and the slot is gone for the process lifetime (bug.5386).
 *
 * Priming with a plain query before reserving fixes the second mode. It does
 * nothing for the first, which is why PR #2611 converted an infinite hang into
 * a bounded 15s error without stopping the outage.
 *
 * Raising `max` only defers the wedge and multiplies reserved sessions on a
 * latency-prone substrate. The fix is to bound concurrency ABOVE the pool:
 *
 *   1. FIFO queue — admit ONE operation before it reserves, so a burst queues
 *      instead of racing. Bounded by `queueWaitMs` so a caller fails fast.
 *   2. Prime, then reserve, under ONE deadline covering both. The deadline must
 *      span the prime: a deadline does not prove native completion. Retain
 *      the original socket and FIFO until SQL actually settles. Transport
 *      uncertainty quarantines the writer without another native generation.
 *      Process death still requires a separate native completion proof.
 *   3. `pg_try_advisory_lock` — the same one-at-a-time guarantee across
 *      replicas, which an in-process queue cannot give.
 *
 * The pool behind this runner is then deliberately `max: 1`, and it is NOT the
 * pool that serves reads.
 */
export class DoltNativeSessionExecutor<TPool extends DoltNativeWriterPool> {
  private readonly errors: DoltNativeSessionErrors;
  private sql: TPool;
  private operationTail: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private readonly queueWaiters = new Set<(error: Error) => void>();
  private readonly logger: DoltNativeSessionLogger;
  private readonly queueWaitMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly writerProtocol: "bridge" | "database";
  private readonly queryTimeoutMs: number;
  private readonly retiredPools = new WeakSet<object>();
  private readonly readClients = new WeakSet<object>();
  private readonly connectionPools = new WeakMap<object, TPool>();
  private readonly cleanupContext = new AsyncLocalStorage<NativeOperation>();
  private heldOperation: NativeOperation | undefined;
  private readonly connectionOperations = new WeakMap<
    object,
    NativeOperation
  >();

  constructor(sql: TPool, options: DoltNativeSessionOptions) {
    this.errors = options.errors;
    this.sql = sql;
    this.logger = options.logger ?? noopLogger;
    this.queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
    this.writerProtocol = options.writerProtocol ?? "bridge";
    this.queryTimeoutMs = options.queryTimeoutMs ?? 30000;
  }

  /** Register readers so writer and ordinary read pools cannot alias. */
  assertIndependentReadClient(reader: object): void {
    if (reader === this.sql)
      throw this.errors.fault(
        "Dolt branch writer must use an independent pool from ordinary reads"
      );
    this.readClients.add(reader);
  }

  /** The fixed writer pool; uncertainty never creates another native generation. */
  get client(): TPool {
    return this.sql;
  }

  /**
   * Run `fn` on a session-pinned connection, one operation at a time.
   *
   * Throws the injected busy error when admission, reservation, or the advisory
   * lock could not be obtained — in every one of those cases nothing was
   * applied, so the caller may retry.
   */
  async run<T>(
    operation: string,
    fn: (
      conn: DoltNativeWriteConnection,
      guard: DoltNativeWriterGuard,
      owner: {
        registerReconciliation(reconcile: () => Promise<boolean>): void;
        committed(
          result: { value: T; commitHash: string },
          cleanup: () => Promise<void>
        ): void;
      }
    ) => Promise<T>,
    options: {
      readonly operationId?: string;
      /** Runtime init requires private cleanup/unlock proof before acknowledging success. */
      readonly awaitSettlement?: boolean;
    } = {}
  ): Promise<T> {
    if (this.heldOperation || this.retiredPools.has(this.sql))
      throw this.errors.busy(
        "Dolt native writer capacity is retained; retry after settlement"
      );
    const leaveQueue = await this.enterQueue(operation);
    const context: NativeOperation = {
      operationId: options.operationId ?? randomUUID(),
      // Lookup location, not proof that this operation owns a created branch.
      branch: "main",
      effectsPossible: false,
      pending: new Set(),
    };
    const abandoned = new Promise<never>((_resolve, reject) => {
      context.rejectCaller = reject;
    });
    let succeed!: (value: T) => void;
    const completed = new Promise<T>((resolve) => {
      succeed = resolve;
    });
    const execution = (async () => {
      try {
        if (this.heldOperation || this.retiredPools.has(this.sql))
          throw this.errors.busy("Dolt native writer capacity is retained");
        const value = await this.withSession(operation, fn, context, succeed);
        if (options.awaitSettlement && (context.transportUnknown || context.outcomeUncertain))
          throw this.errors.outcomeUnknown(context.operationId, context.branch, context.commitHash);
        return value;
      } finally {
        if (
          !context.transportUnknown &&
          !this.retiredPools.has(this.sql) &&
          this.heldOperation === context
        )
          this.heldOperation = undefined;
        leaveQueue();
      }
    })();
    return options.awaitSettlement
      ? Promise.race([execution, abandoned])
      : Promise.race([execution, abandoned, completed]);
  }

  private abandon(context: NativeOperation): void {
    if (context.abandoned) return;
    context.abandoned = context.effectsPossible
      ? this.errors.outcomeUnknown(
          context.operationId,
          context.branch,
          context.commitHash
        )
      : this.errors.busy(
          "Dolt native operation retained after caller deadline; retry after settlement"
        );
    this.heldOperation = context;
    context.rejectCaller?.(context.abandoned);
    for (const reject of this.queueWaiters)
      reject(this.errors.busy("Dolt native writer capacity is retained"));
  }

  private async awaitNative<T>(
    pool: TPool,
    context: NativeOperation,
    native: PromiseLike<T>,
    budgetMs: number,
    allowAbandonedReturn = false
  ): Promise<T> {
    const pending = Promise.resolve(native);
    context.pending.add(pending);
    const timer = setTimeout(() => this.abandon(context), budgetMs);
    let returned = false;
    try {
      const result = await pending;
      returned = true;
      if (context.abandoned && !allowAbandonedReturn) throw context.abandoned;
      return result;
    } catch (error) {
      if (
        !returned &&
        !(error instanceof Error && error.name === "PostgresError")
      ) {
        context.transportUnknown = true;
        this.retiredPools.add(pool);
        this.abandon(context);
      }
      throw context.abandoned ?? error;
    } finally {
      clearTimeout(timer);
      context.pending.delete(pending);
    }
  }

  private log(
    level: "info" | "warn" | "error",
    operation: string,
    stage: string,
    state: "start" | "complete" | "error",
    fields: Record<string, unknown> = {}
  ): void {
    this.logger[level](
      {
        event: "adapter.dolt.native_session",
        component: "doltgres-native-session",
        operation,
        stage,
        state,
        ...fields,
      },
      `dolt ${stage} ${state}`
    );
  }

  /**
   * FIFO admission. Chains onto the previous ticket so operations run in
   * arrival order; a caller that times out still releases its own ticket so the
   * chain cannot deadlock behind an abandoned turn.
   */
  private async enterQueue(operation: string): Promise<() => void> {
    if (this.queuedOperations >= 32)
      throw this.errors.busy("Dolt writer queue capacity reached");
    this.queuedOperations++;
    const predecessor = this.operationTail;
    let releaseTurn: () => void = () => undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.operationTail = predecessor.then(() => turnDone);

    const startedAt = Date.now();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let rejectWaiter!: (error: Error) => void;
    const capacityRetained = new Promise<never>((_resolve, reject) => {
      rejectWaiter = reject;
    });
    this.queueWaiters.add(rejectWaiter);
    try {
      await Promise.race([
        predecessor,
        capacityRetained,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                this.errors.busy(
                  "Dolt write queue wait timed out; retry shortly"
                )
              ),
            this.queueWaitMs
          );
        }),
      ]);
    } catch (error) {
      // Keep the FIFO chain live even though this caller abandoned its turn.
      releaseTurn();
      this.log("warn", operation, "queue", "error", {
        durationMs: Date.now() - startedAt,
        reason: this.heldOperation
          ? "native_capacity_retained"
          : "wait_timeout",
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.queuedOperations--;
      this.queueWaiters.delete(rejectWaiter);
    }

    this.log("info", operation, "queue", "complete", {
      durationMs: Date.now() - startedAt,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTurn();
    };
  }

  /** Retire a session whose mutation or lock acknowledgement is uncertain. */
  async retire(
    connection: DoltNativeWriteConnection,
    error: unknown
  ): Promise<void> {
    this.log(
      "error",
      "dolt.write",
      "session.uncertain",
      "error",
      errorFields(error)
    );
    const pool = this.connectionPools.get(connection);
    if (!pool) throw this.errors.fault("Unknown dolt writer connection");
    const context = this.connectionOperations.get(connection);
    this.quarantine(pool, "dolt.write", "session", "outcome_uncertain");
    if (context) {
      // Mark the op uncertain for the caller, but never latch the shared writer
      // (bug.5544): the `withSession` finally evicts the connection and keeps serving.
      context.reconciliationRequired = true;
      context.outcomeUncertain = true;
    }
  }

  private async restoreMain(
    connection: DoltNativeWriteConnection,
    pool: TPool,
    operation: string
  ): Promise<void> {
    try {
      if ((await connection.unsafe("SELECT * FROM dolt.status")).length)
        throw this.errors.fault("Writer left an unproven dirty working set");
      const rows = await connection.unsafe(
        "SELECT active_branch() AS branch_name"
      );
      const active = rows[0]?.branch_name;
      if (active !== "main") {
        await connection.unsafe("SELECT dolt_checkout('main')");
        const proof = await connection.unsafe(
          "SELECT active_branch() AS branch_name"
        );
        if (
          proof[0]?.branch_name !== "main" ||
          (await connection.unsafe("SELECT * FROM dolt.status")).length
        )
          throw this.errors.fault("Clean main restoration was not proven");
      }
    } catch {
      this.quarantine(pool, operation, "checkout", "restore_uncertain");
    }
  }

  private async withSession<T>(
    operation: string,
    fn: (
      conn: DoltNativeWriteConnection,
      guard: DoltNativeWriterGuard,
      owner: {
        registerReconciliation(reconcile: () => Promise<boolean>): void;
        committed(
          result: { value: T; commitHash: string },
          cleanup: () => Promise<void>
        ): void;
      }
    ) => Promise<T>,
    context: NativeOperation,
    succeed: (value: T) => void
  ): Promise<T> {
    const pool = this.sql;
    let native: DoltNativeReservedConnection | undefined;
    let guard: DoltNativeWriterGuard | undefined;
    let connection: DoltNativeWriteConnection | undefined;
    try {
      native = await this.acquireSession(pool, context);
      const reserved = native;
      connection = {
        unsafe: async (query: string) => {
          const unlock = /^SELECT pg_advisory_unlock\(/.test(query);
          const cleanup = this.cleanupContext.getStore() === context;
          // Admission owns its partial locks before a user callback exists.
          const admissionUnlock =
            unlock && context.admitting && !context.pending.size;
          if (
            (context.closed || context.abandoned) &&
            !cleanup &&
            !admissionUnlock
          ) {
            if (context.admitting && !context.transportUnknown)
              throw new DoltWriterAdmissionError("lock_contended", false, {
                cause: context.abandoned,
              });
            throw (
              context.abandoned ??
              this.errors.fault("Dolt writer scope has closed")
            );
          }
          if (
            context.transportUnknown ||
            (this.retiredPools.has(pool) && !cleanup)
          )
            throw this.errors.busy("Dolt writer session was retired");
          const branch = /dolt_checkout\('(?:-b',\s*')?([^']+)'/.exec(
            query
          )?.[1];
          if (branch && branch !== "main") context.branch = branch;
          // Raw callback SQL can invoke effectful functions, CTEs or CALLs.
          // Only admission and runner-owned cleanup have narrower semantics.
          if (!context.admitting && !cleanup) context.effectsPossible = true;
          const rows = await this.awaitNative(
            pool,
            context,
            reserved.unsafe(query),
            this.queryTimeoutMs,
            context.admitting || unlock || cleanup
          );
          if (/dolt_commit\(/i.test(query)) {
            // A base HEAD lookup is historical evidence, never this operation's commit.
            const value = rows[0]?.dolt_commit;
            const hash = Array.isArray(value) ? value[0] : value;
            if (typeof hash === "string" && /^[a-z0-9]{32,64}$/i.test(hash))
              context.commitHash = hash;
          }
          return rows;
        },
      };
      this.connectionPools.set(connection, pool);
      this.connectionOperations.set(connection, context);
      try {
        context.admitting = true;
        guard = await acquireDoltWriterLocks(connection, {
          protocol: this.writerProtocol,
          lockWaitMs: this.lockWaitMs,
          lockRetryMs: this.lockRetryMs,
          authorizeRelease: () => {
            if (
              !context.admitting &&
              this.cleanupContext.getStore() !== context
            )
              throw this.errors.fault(
                "Dolt writer release is private to its owner"
              );
          },
        });
      } catch (error) {
        if (context.abandoned) throw context.abandoned;
        if (error instanceof DoltWriterAdmissionError && error.discardSession)
          this.quarantine(pool, operation, "lock.acquire", error.reason);
        throw this.errors.busy(
          "Dolt writer admission unavailable; retry before starting a mutation"
        );
      } finally {
        context.admitting = false;
      }
      if (context.abandoned) throw context.abandoned;
      const callbackConnection = connection;
      const callbackGuard = guard;
      const value = await this.cleanupContext.exit(() =>
        fn(callbackConnection, callbackGuard, {
          registerReconciliation: (reconcile) => {
            if (context.reconcile || context.closed || context.abandoned)
              throw this.errors.fault(
                "Dolt reconciliation plan cannot be replaced"
              );
            context.reconcile = reconcile;
          },
          committed: (result, cleanup) => {
            if (
              context.committedCleanup ||
              context.closed ||
              context.abandoned ||
              context.pending.size
            )
              throw this.errors.fault(
                "Dolt commit acknowledgement is no longer available"
              );
            context.committedCleanup = cleanup;
            context.commitHash = result.commitHash;
            context.closed = true;
            succeed(result.value);
          },
        })
      );
      context.closed = true;
      // The caller owns the business proof represented by a successful callback.
      // Cleanup latency must not rewrite that ACK, but unawaited SQL is not ACKed.
      if (!context.abandoned && !context.pending.size) succeed(value);
      return value;
    } finally {
      context.closed = true;
      // Closing the public scope precedes the drain. An escaped callback can
      // neither add another native query nor inherit private cleanup authority.
      await Promise.allSettled([...context.pending]);
      if (context.transportUnknown) {
        // Dead socket: an unlock cannot be sent. Record the uncertainty for the
        // caller; the server session frees the lock when the abandoned op settles.
        // The tail evicts the connection — the writer is never retained (bug.5544).
        this.quarantine(
          pool,
          operation,
          "settlement",
          "native_transport_unknown"
        );
        context.outcomeUncertain = true;
      } else if (guard && connection) {
        const ownedGuard = guard;
        const ownedConnection = connection;
        await this.cleanupContext.run(context, async () => {
          if (context.committedCleanup) {
            const cleanup = context.committedCleanup;
            context.committedCleanup = undefined;
            try {
              await cleanup();
            } catch {
              context.reconciliationRequired = true;
            }
          }
          if (context.transportUnknown) {
            context.outcomeUncertain = true;
            return;
          }
          let safe = false;
          if (context.reconcile) {
            try {
              safe = await context.reconcile();
            } catch {
              safe = false;
            }
          } else {
            // Without an owning plan, never infer ownership of a dirty/foreign
            // branch. Successful normal callbacks retain existing clean restore.
            if (!context.abandoned && !context.reconciliationRequired)
              await this.restoreMain(ownedConnection, pool, operation);
            if (!context.transportUnknown)
              safe = await reconcileAbandonedDoltOperation(ownedConnection, {
                guard: ownedGuard,
                creationProven: false,
                commitAttempted: true,
                mergeAttempted: true,
              });
          }
          if (!safe || context.transportUnknown) {
            // Uncertain outcome (bug.5544): record it for the caller, but DO NOT
            // retain the shared writer. On a still-live session release the
            // advisory lock here (inside the authorized cleanup scope) so other
            // writers and a fresh connection re-acquire it. Data-uncertainty is
            // owned by idempotent reconcile-on-replay, not by holding the lock.
            this.quarantine(
              pool,
              operation,
              "reconciliation",
              "operation_receipt_requires_recovery"
            );
            context.outcomeUncertain = true;
            this.log("error", operation, "recovery", "error", {
              operationId: context.operationId,
              branch: context.branch,
              commitHash: context.commitHash ?? null,
            });
            if (!context.transportUnknown) {
              try {
                await ownedGuard.release();
                this.retiredPools.delete(pool);
              } catch (error) {
                this.log(
                  "error",
                  operation,
                  "lock.release",
                  "error",
                  errorFields(error)
                );
              }
            }
            return;
          }
          try {
            await ownedGuard.release();
            this.retiredPools.delete(pool);
            context.reconciliationRequired = false;
          } catch (error) {
            this.log(
              "error",
              operation,
              "lock.release",
              "error",
              errorFields(error)
            );
            this.quarantine(
              pool,
              operation,
              "lock.release",
              "unlock_uncertain"
            );
            context.outcomeUncertain = true;
          }
        });
      }
      // EVICT-AND-REPLACE (bug.5544): an uncertain outcome must NEVER retain the
      // single shared writer. The old code latched `heldOperation` + `retiredPools`
      // and skipped `native.release()`, so the reserved session kept the shared
      // advisory lock forever and both writers wedged until a pod restart. The
      // lock is now released inside the authorized cleanup scope above; here we
      // only evict the connection and clear the retirement/latch so the next
      // operation is admitted. The caller already holds `outcomeUnknown`.
      this.heldOperation = undefined;
      this.retiredPools.delete(pool);
      if (native) native.release();
    }
  }

  /**
   * Prime, then reserve, under a single deadline.
   *
   * PRIME_BEFORE_RESERVE: an ordinary query reaches postgres.js `onopen`, which
   * a cold `reserve()` does not. A timed-out prime stays owned until its actual
   * settlement; a late reservation is returned without starting a callback.
   */
  private async acquireSession(
    pool: TPool,
    context: NativeOperation
  ): Promise<DoltNativeReservedConnection> {
    const started = Date.now();
    await this.awaitNative(
      pool,
      context,
      pool.unsafe("SELECT 1 AS knowledge_ready"),
      this.acquireTimeoutMs
    );
    if (context.abandoned) throw context.abandoned;
    const reserved = await this.awaitNative(
      pool,
      context,
      pool.reserve(),
      Math.max(1, this.acquireTimeoutMs - (Date.now() - started)),
      true
    );
    if (context.abandoned) {
      reserved.release();
      throw context.abandoned;
    }
    return reserved;
  }

  /**
   * Mark the in-flight connection dead so its remaining queries short-circuit.
   * Capacity is NOT retained permanently: the `withSession` finally tail evicts
   * the connection and clears this flag at settlement (bug.5544), so the shared
   * writer never wedges on an uncertain outcome.
   */
  private quarantine(
    pool: TPool,
    operation: string,
    stage: string,
    reason: string
  ): void {
    this.retiredPools.add(pool);
    this.log("error", operation, "connection.quarantine", "error", {
      failedStage: stage,
      reason,
    });
  }
}
