// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Common Doltgres writer protocol over a caller-owned, reserved, bounded session. */
import { createHash } from "node:crypto";

export interface DoltWriterConnection {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
}
export type DoltWriterProtocol = "bridge" | "database";
/** Opaque capability for this module instance; never interchange guards across separately bundled copies. */
export interface DoltWriterLock {
  readonly baseDatabase: string;
  readonly protocol: DoltWriterProtocol;
  readonly keys: readonly string[];
  /** Exactly-once release; uncertainty requires caller-owned session destruction. */
  release(): Promise<void>;
}
export class DoltWriterAdmissionError extends Error {
  constructor(
    readonly reason:
      | "identity_unavailable"
      | "lock_contended"
      | "query_failed"
      | "release_uncertain"
      | "guard_invalid",
    readonly discardSession: boolean,
    options?: { cause?: unknown }
  ) {
    super(`Dolt writer admission failed: ${reason}`);
    this.name = "DoltWriterAdmissionError";
    if (options?.cause !== undefined)
      Object.defineProperty(this, "cause", { value: options.cause });
  }
}

const guards = new WeakMap<
  DoltWriterLock,
  { connection: DoltWriterConnection; active: boolean }
>();
const activeConnections = new WeakMap<DoltWriterConnection, DoltWriterLock>();
const pendingConnections = new WeakSet<DoltWriterConnection>();
const discardedConnections = new WeakSet<DoltWriterConnection>();

/** An owned guard cannot be forged, reused after release, or used on another session. */
export function assertDoltWriterLock(
  connection: DoltWriterConnection,
  guard: DoltWriterLock
): void {
  const state = guards.get(guard);
  if (!state?.active || state.connection !== connection)
    throw new DoltWriterAdmissionError("guard_invalid", false);
}

/** Revision-qualified native names share one physical base database/root. */
export function doltWriterLockKey(nativeDatabase: string): string {
  const baseDatabase = nativeDatabase.split("/")[0];
  if (!baseDatabase || !baseDatabase.trim())
    throw new DoltWriterAdmissionError("identity_unavailable", false);
  const digest = createHash("sha256")
    .update(`dolt-main-writer-v1\0${baseDatabase}`)
    .digest("hex");
  // Negative signed bigint keys cannot collide with the positive legacy keys.
  return BigInt.asIntN(
    64,
    BigInt(`0x${digest.slice(0, 16)}`) | (1n << 63n)
  ).toString();
}

function booleanResult(
  rows: readonly Record<string, unknown>[],
  field: string
): boolean {
  const value = rows[0]?.[field];
  const scalar = Array.isArray(value) ? value[0] : value;
  if (scalar === true || scalar === 1 || scalar === "true") return true;
  if (scalar === false || scalar === 0 || scalar === "false") return false;
  throw new DoltWriterAdmissionError("query_failed", true);
}

export async function acquireDoltWriterLocks(
  connection: DoltWriterConnection,
  options: {
    protocol?: DoltWriterProtocol;
    lockWaitMs?: number;
    lockRetryMs?: number;
    /** Caller-owned scope check; denial must not revoke the guard or ownership. */
    authorizeRelease?: () => void;
  } = {}
): Promise<DoltWriterLock> {
  if (
    activeConnections.has(connection) ||
    pendingConnections.has(connection) ||
    discardedConnections.has(connection)
  )
    throw new DoltWriterAdmissionError("guard_invalid", false);
  const protocol = options.protocol ?? "bridge";
  if (protocol !== "bridge" && protocol !== "database")
    throw new DoltWriterAdmissionError("identity_unavailable", false);
  const lockWaitMs = options.lockWaitMs ?? 2_000;
  const lockRetryMs = options.lockRetryMs ?? 50;
  if (
    !Number.isFinite(lockWaitMs) ||
    lockWaitMs < 0 ||
    !Number.isFinite(lockRetryMs) ||
    lockRetryMs <= 0
  ) {
    throw new DoltWriterAdmissionError("identity_unavailable", false);
  }
  pendingConnections.add(connection);
  const held: string[] = [];
  let released = false;
  let guard: DoltWriterLock | undefined;
  const release = async () => {
    options.authorizeRelease?.();
    if (released) return;
    released = true;
    pendingConnections.add(connection);
    if (guard) {
      const state = guards.get(guard);
      if (state) state.active = false;
      activeConnections.delete(connection);
    }
    try {
      for (const key of [...held].reverse()) {
        const rows = await connection.unsafe(
          `SELECT pg_advisory_unlock(${key})`
        );
        if (!booleanResult(rows, "pg_advisory_unlock"))
          throw new Error("Owned Dolt writer lock was lost");
      }
    } catch (cause) {
      discardedConnections.add(connection);
      throw new DoltWriterAdmissionError("release_uncertain", true, { cause });
    } finally {
      pendingConnections.delete(connection);
    }
  };
  try {
    const rows = await connection.unsafe(
      "SELECT current_database() AS dolt_writer_database"
    );
    const nativeDatabase = rows[0]?.dolt_writer_database;
    if (typeof nativeDatabase !== "string" || !nativeDatabase.trim())
      throw new DoltWriterAdmissionError("identity_unavailable", false);
    const baseDatabase = nativeDatabase.split("/")[0] as string;
    const scopedKey = doltWriterLockKey(nativeDatabase);
    const keys =
      protocol === "bridge" ? ["5001001", "5001002", scopedKey] : [scopedKey];
    const deadline = Date.now() + lockWaitMs;
    for (const key of keys) {
      for (;;) {
        const locked = booleanResult(
          await connection.unsafe(`SELECT pg_try_advisory_lock(${key})`),
          "pg_try_advisory_lock"
        );
        if (locked) {
          held.push(key);
          break;
        }
        if (Date.now() >= deadline)
          throw new DoltWriterAdmissionError("lock_contended", false);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(lockRetryMs, Math.max(0, deadline - Date.now()))
          )
        );
      }
    }
    guard = Object.freeze({
      baseDatabase,
      protocol,
      keys: Object.freeze(keys),
      release,
    });
    guards.set(guard, { connection, active: true });
    activeConnections.set(connection, guard);
    return guard;
  } catch (cause) {
    // Even a failed second/third lock attempt must not leak earlier locks.
    if (held.length) await release();
    if (cause instanceof DoltWriterAdmissionError) {
      if (cause.discardSession) discardedConnections.add(connection);
      throw cause;
    }
    discardedConnections.add(connection);
    // A lost acknowledgement may have acquired a lock not in `held`.
    throw new DoltWriterAdmissionError("query_failed", true, { cause });
  } finally {
    pendingConnections.delete(connection);
  }
}
