// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  acquireDoltWriterLocks,
  assertDoltWriterLock,
  doltWriterLockKey,
  type DoltWriterConnection,
} from "../src/index.js";

function engine() {
  const owners = new Map<string, string>();
  const queries: string[] = [];
  function connection(
    session: string,
    database: string,
    failQuery?: (query: string) => boolean
  ): DoltWriterConnection {
    return {
      async unsafe(query) {
        queries.push(query);
        if (query.includes("current_database()"))
          return [{ dolt_writer_database: database }];
        const key = /\((-?\d+)\)/.exec(query)?.[1] ?? "";
        if (failQuery?.(query)) throw new Error("lost query acknowledgement");
        if (query.includes("pg_try_advisory_lock")) {
          const acquired = !owners.has(key) || owners.get(key) === session;
          if (acquired) owners.set(key, session);
          return [{ pg_try_advisory_lock: acquired }];
        }
        const released = owners.get(key) === session;
        if (released) owners.delete(key);
        return [{ pg_advisory_unlock: released }];
      },
    };
  }
  return { owners, queries, connection };
}

describe("one common per-base-database writer protocol", () => {
  it("revision aliases use the same key; distinct native databases do not", () => {
    expect(doltWriterLockKey("knowledge_a/main")).toBe(
      doltWriterLockKey("knowledge_a/contrib/x")
    );
    expect(doltWriterLockKey("knowledge_a")).not.toBe(
      doltWriterLockKey("knowledge_b")
    );
    expect(BigInt(doltWriterLockKey("knowledge_a"))).toBeLessThan(0n);
  });
  it("bridge takes both legacy domains then database key and releases in reverse", async () => {
    const e = engine();
    const lock = await acquireDoltWriterLocks(e.connection("a", "knowledge_a"));
    expect(lock.keys).toEqual([
      "5001001",
      "5001002",
      doltWriterLockKey("knowledge_a"),
    ]);
    await lock.release();
    await lock.release();
    expect(e.owners.size).toBe(0);
    expect(e.queries.slice(-3)).toEqual(
      [...lock.keys].reverse().map((key) => `SELECT pg_advisory_unlock(${key})`)
    );
  });
  it("scoped databases proceed independently while same database excludes another session", async () => {
    const e = engine();
    const first = await acquireDoltWriterLocks(
      e.connection("a", "knowledge_a"),
      { protocol: "database" }
    );
    const second = await acquireDoltWriterLocks(
      e.connection("b", "knowledge_b"),
      { protocol: "database" }
    );
    await expect(
      acquireDoltWriterLocks(e.connection("c", "knowledge_a"), {
        protocol: "database",
        lockWaitMs: 0,
      })
    ).rejects.toMatchObject({
      reason: "lock_contended",
      discardSession: false,
    });
    await first.release();
    await second.release();
  });
  it("partial bridge contention cleans legacy keys without releasing somebody else's scope", async () => {
    const e = engine();
    const first = await acquireDoltWriterLocks(
      e.connection("a", "knowledge_a"),
      { protocol: "database" }
    );
    await expect(
      acquireDoltWriterLocks(e.connection("b", "knowledge_a"), {
        lockWaitMs: 0,
      })
    ).rejects.toMatchObject({
      reason: "lock_contended",
      discardSession: false,
    });
    expect([...e.owners.keys()]).toEqual(first.keys);
    await first.release();
  });
  it("unknown acquire acknowledgement or uncertain release requires session destruction", async () => {
    const e = engine();
    await expect(
      acquireDoltWriterLocks(
        e.connection("a", "knowledge_a", (q) =>
          q.includes("pg_try_advisory_lock(5001002)")
        )
      )
    ).rejects.toMatchObject({ reason: "query_failed", discardSession: true });
    expect(e.owners.size).toBe(0);
    const bad = await acquireDoltWriterLocks(
      e.connection("b", "knowledge_b", (q) => q.includes("pg_advisory_unlock"))
    );
    await expect(bad.release()).rejects.toMatchObject({
      reason: "release_uncertain",
      discardSession: true,
    });
  });

  it("lost acknowledgement after server acquisition retains unknown key until caller destroys the session", async () => {
    const e = engine();
    const base = e.connection("lost", "knowledge_a");
    const connection: DoltWriterConnection = {
      async unsafe(query) {
        const rows = await base.unsafe(query);
        if (
          query ===
          `SELECT pg_try_advisory_lock(${doltWriterLockKey("knowledge_a")})`
        )
          throw new Error("ACK lost after acquire");
        return rows;
      },
    };
    await expect(acquireDoltWriterLocks(connection)).rejects.toMatchObject({
      reason: "query_failed",
      discardSession: true,
    });
    expect([...e.owners.keys()]).toEqual([doltWriterLockKey("knowledge_a")]);
    await expect(acquireDoltWriterLocks(connection)).rejects.toMatchObject({
      reason: "guard_invalid",
    });
    // Only the caller owns lifecycle; terminating that session releases unknown locks.
    for (const [key, owner] of e.owners)
      if (owner === "lost") e.owners.delete(key);
    expect(e.owners.size).toBe(0);
  });
  it("guards cannot be forged, nested, reused after release, or moved to another connection", async () => {
    const e = engine();
    const first = e.connection("a", "knowledge_a");
    const other = e.connection("b", "knowledge_a");
    const guard = await acquireDoltWriterLocks(first);
    expect(() => assertDoltWriterLock(first, guard)).not.toThrow();
    expect(() => assertDoltWriterLock(other, guard)).toThrow(/guard_invalid/);
    await expect(acquireDoltWriterLocks(first)).rejects.toMatchObject({
      reason: "guard_invalid",
    });
    await guard.release();
    expect(() => assertDoltWriterLock(first, guard)).toThrow(/guard_invalid/);
  });
  it("does not reacquire a connection while asynchronous release is in progress", async () => {
    const e = engine();
    const base = e.connection("a", "knowledge_a");
    let finish: (() => void) | undefined;
    const connection: DoltWriterConnection = {
      async unsafe(query) {
        if (query.includes("pg_advisory_unlock") && !finish)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return base.unsafe(query);
      },
    };
    const guard = await acquireDoltWriterLocks(connection);
    const releasing = guard.release();
    await expect(acquireDoltWriterLocks(connection)).rejects.toMatchObject({
      reason: "guard_invalid",
    });
    finish?.();
    await releasing;
    const successor = await acquireDoltWriterLocks(connection);
    await successor.release();
  });
  it("missing native identity never guesses a database or acquires a lock", async () => {
    const queries: string[] = [];
    await expect(
      acquireDoltWriterLocks({
        unsafe: async (q) => {
          queries.push(q);
          return [];
        },
      })
    ).rejects.toMatchObject({ reason: "identity_unavailable" });
    expect(queries).toHaveLength(1);
  });
});
