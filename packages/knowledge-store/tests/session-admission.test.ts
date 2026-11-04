// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/session-admission`
 * Purpose: Pin the admission-control invariants that keep the Doltgres knowledge write plane from wedging (bug.5386, bug.5391).
 * Scope: Harness-level proof against a fake PG wire server. Does not connect to Doltgres and does not assert contribution semantics — an integration test against a real Doltgres owns those.
 * Invariants:
 *   - A bare `sql.reserve()` as the first operation on a `fetch_types: false`
 *     client NEVER settles. This is the defect; the first test documents it so
 *     the fix cannot be mistaken for cargo cult.
 *   - Priming alone is NOT enough: concurrent primes land on one connection, so
 *     a burst still burns a slot per cold reserve. That is why admission
 *     control sits ABOVE the pool rather than the pool being made bigger.
 *   - `DoltBranchSessionRunner` admits one operation at a time, fails loud with
 *     `KnowledgeBusyError` instead of hanging, and retains native capacity after caller abandonment.
 * Side-effects: IO (binds a loopback TCP server on an ephemeral port)
 * Links: packages/knowledge-store/src/adapters/doltgres/session-admission.ts
 * @internal
 */

import net from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDoltgresClient } from "../src/adapters/doltgres/build-client.js";
import {
  DoltBranchSessionRunner,
  type DoltWriteConnection,
  type DoltBranchWriterGuard,
} from "../src/adapters/doltgres/session-admission.js";
import { DoltgresKnowledgeStoreAdapter } from "../src/adapters/doltgres/index.js";
import type { KnowledgeWriteSession } from "../src/port/knowledge-store.port.js";
import {
  KnowledgeBusyError,
  KnowledgeWriteOutcomeUnknownError,
} from "../src/port/knowledge-store.port.js";

// ---------------------------------------------------------------------------
// Minimal Postgres wire server: completes startup (trust auth) and answers any
// subsequent client traffic with an empty result set — except
// `pg_try_advisory_lock`, which must answer `t` or the runner would correctly
// refuse to proceed. Enough to drive postgres.js's pool state machine, which is
// the only thing under test.
// ---------------------------------------------------------------------------

function msg(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4, 0);
  return Buffer.concat([Buffer.from(type, "ascii"), len, body]);
}

function int32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return b;
}

function int16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(value, 0);
  return b;
}

const AUTH_OK = msg("R", int32(0));
const BACKEND_KEY = msg("K", Buffer.concat([int32(1234), int32(5678)]));
const READY_IDLE = msg("Z", Buffer.from("I", "ascii"));
const PARSE_COMPLETE = msg("1", Buffer.alloc(0));
const BIND_COMPLETE = msg("2", Buffer.alloc(0));
const NO_DATA = msg("n", Buffer.alloc(0));
const CMD_COMPLETE = msg("C", Buffer.from("SELECT 0\0", "ascii"));

/** One bool column named `pg_try_advisory_lock`. */
const LOCK_ROW_DESCRIPTION = msg(
  "T",
  Buffer.concat([
    int16(1),
    Buffer.from("pg_try_advisory_lock\0", "ascii"),
    int32(0), // table oid
    int16(0), // column attribute number
    int32(16), // bool
    int16(1), // type size
    int32(-1), // type modifier
    int16(0), // text format
  ])
);

const LOCK_DATA_ROW = msg(
  "D",
  Buffer.concat([int16(1), int32(1), Buffer.from("t", "ascii")])
);

function valueResponse(name: string, value: string, type = 25): Buffer {
  return Buffer.concat([
    PARSE_COMPLETE,
    BIND_COMPLETE,
    msg(
      "T",
      Buffer.concat([
        int16(1),
        Buffer.from(`${name}\0`, "ascii"),
        int32(0),
        int16(0),
        int32(type),
        int16(-1),
        int32(-1),
        int16(0),
      ])
    ),
    msg(
      "D",
      Buffer.concat([
        int16(1),
        int32(value.length),
        Buffer.from(value, "ascii"),
      ])
    ),
    msg("C", Buffer.from("SELECT 1\0", "ascii")),
    READY_IDLE,
  ]);
}

function parameterStatus(key: string, value: string): Buffer {
  return msg("S", Buffer.from(`${key}\0${value}\0`, "ascii"));
}

const STARTUP_RESPONSE = Buffer.concat([
  AUTH_OK,
  parameterStatus("server_version", "15.0"),
  parameterStatus("client_encoding", "UTF8"),
  parameterStatus("standard_conforming_strings", "on"),
  BACKEND_KEY,
  READY_IDLE,
]);

const QUERY_RESPONSE = Buffer.concat([
  PARSE_COMPLETE,
  BIND_COMPLETE,
  NO_DATA,
  CMD_COMPLETE,
  READY_IDLE,
]);

const LOCK_RESPONSE = Buffer.concat([
  PARSE_COMPLETE,
  BIND_COMPLETE,
  LOCK_ROW_DESCRIPTION,
  LOCK_DATA_ROW,
  msg("C", Buffer.from("SELECT 1\0", "ascii")),
  READY_IDLE,
]);

function startFakePostgres(): Promise<{
  server: net.Server;
  port: number;
  sockets: Set<net.Socket>;
}> {
  return new Promise((resolve) => {
    // Several tests deliberately strand connections (that IS the defect), so
    // `server.close()` would wait on them forever. Track and destroy instead.
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let startupDone = false;
      socket.on("data", (buf) => {
        if (!startupDone) {
          startupDone = true;
          socket.write(STARTUP_RESPONSE);
          return;
        }
        // Any Sync ('S') or simple Query ('Q') byte terminates a client
        // message batch; answer it with an empty result + ReadyForQuery.
        if (buf.includes(0x53) || buf.includes(0x51)) {
          socket.write(
            buf.includes("pg_try_advisory_lock")
              ? LOCK_RESPONSE
              : buf.includes("pg_advisory_unlock")
                ? valueResponse("pg_advisory_unlock", "t", 16)
                : buf.includes("current_database()")
                  ? valueResponse("dolt_writer_database", "knowledge_test")
                  : buf.includes("active_branch()")
                    ? valueResponse("branch_name", "main")
                    : buf.includes("dolt.merge_status")
                      ? valueResponse("is_merging", "f", 16)
                      : QUERY_RESPONSE
          );
        }
      });
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake postgres failed to bind an ephemeral port");
      }
      resolve({ server, port: address.port, sockets });
    });
  });
}

/** Resolve to `"settled"` or `"pending"` within `ms`, never throwing. */
async function outcomeWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<"settled" | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const
      ),
      pending,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Dolt session admission control (bug.5386, bug.5391)", () => {
  let server: net.Server;
  let port: number;
  let sockets: Set<net.Socket>;

  beforeAll(async () => {
    ({ server, port, sockets } = await startFakePostgres());
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(max = 5) {
    return buildDoltgresClient({
      connectionString: `postgres://u:p@127.0.0.1:${port}/db`,
      max,
    });
  }

  it("documents the postgres.js defect: a bare cold sql.reserve() never settles", async () => {
    const sql = client();
    try {
      // No query has run, so `open` is empty and postgres.js cold-connects a
      // slot with a `{ reserve }` pseudo-query. With `fetch_types: false`
      // (mandatory for Doltgres) `ReadyForQuery` returns without calling
      // `onopen`, so nothing ever invokes `query.reserve(c)`.
      const reserved = sql.reserve();
      expect(await outcomeWithin(reserved, 2_000)).toBe("pending");
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("documents the plane-wide wedge: cold reserves burn every slot and then reads hang too", async () => {
    const max = 3;
    const sql = client(max);
    try {
      for (let i = 0; i < max; i++) {
        void sql.reserve().catch(() => undefined);
      }
      // Let postgres.js move every slot into its `connecting` queue, where a
      // cold reserve leaves it permanently.
      await sleep(1_000);
      // An ordinary read now has no slot to run on and postgres.js parks it on
      // `queries` with no timeout: the read never completes and nothing is
      // logged. This is why the branch-op client must be separate from the one
      // that serves reads, and why /readyz probes with its own deadline.
      expect(await outcomeWithin(sql.unsafe("SELECT 1"), 2_000)).toBe(
        "pending"
      );
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("documents the starvation: held reserves exhaust the pool and the next query parks", async () => {
    // This is the half of bug.5386 that PR #2611 left open and bug.5391 closes.
    // A branch op pins its connection for the whole operation — seconds on a
    // loaded Doltgres. Once every slot is pinned, the next caller's query goes
    // onto postgres.js's unbounded backlog with no deadline of its own, so a
    // READ hangs because WRITES are slow. That is why branch work gets its own
    // client and why the acquire deadline must span the priming query.
    const max = 2;
    const sql = client(max);
    const held: Array<{ release: () => void }> = [];
    try {
      for (let i = 0; i < max; i++) {
        await sql.unsafe("SELECT 1");
        held.push(await sql.reserve());
      }
      expect(await outcomeWithin(sql.unsafe("SELECT 1"), 2_000)).toBe(
        "pending"
      );
    } finally {
      for (const conn of held) conn.release();
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("serializes a burst instead of starving the pool", async () => {
    const sql = client(1);
    const runner = new DoltBranchSessionRunner(sql);
    try {
      let concurrent = 0;
      let peak = 0;
      const order: number[] = [];
      await Promise.all(
        Array.from({ length: 6 }, (_unused, i) =>
          runner.run(`op-${i}`, async (conn) => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            order.push(i);
            await conn.unsafe("SELECT 1");
            await sleep(5);
            concurrent -= 1;
          })
        )
      );
      expect(peak).toBe(1);
      expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("keeps serving after an operation throws", async () => {
    const sql = client(1);
    const runner = new DoltBranchSessionRunner(sql);
    try {
      await expect(
        runner.run("boom", async () => {
          throw new Error("operation failed");
        })
      ).rejects.toThrow("operation failed");
      // A failed operation must release its queue ticket and its connection, or
      // the very next write inherits the failure.
      await expect(
        runner.run("after", async (conn) => {
          await conn.unsafe("SELECT 1");
          return "ok";
        })
      ).resolves.toBe("ok");
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("fails loud with a retryable busy error when the queue backs up", async () => {
    const sql = client(1);
    const runner = new DoltBranchSessionRunner(sql, { queueWaitMs: 100 });
    try {
      let releaseHolder: () => void = () => undefined;
      const holder = runner.run("holder", async () => {
        await new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
      });
      await expect(runner.run("queued", async () => undefined)).rejects.toThrow(
        KnowledgeBusyError
      );
      releaseHolder();
      await holder;
    } finally {
      void sql.end({ timeout: 0 }).catch(() => undefined);
    }
  });

  it("retains a wedged client instead of multiplying unresolved native work", async () => {
    const first = client(1);
    void first.reserve().catch(() => undefined);
    let recreated = 0;
    const runner = new DoltBranchSessionRunner(first, {
      acquireTimeoutMs: 50,
      recreateClient: () => {
        recreated++;
        return client(1);
      },
    });
    try {
      await expect(
        runner.run("wedged", async () => undefined)
      ).rejects.toBeInstanceOf(KnowledgeBusyError);
      for (let i = 0; i < 5; i++)
        await expect(
          runner.run("retry", async () => undefined)
        ).rejects.toBeInstanceOf(KnowledgeBusyError);
      expect(runner.client).toBe(first);
      expect(recreated).toBe(0);
    } finally {
      void first.end({ timeout: 0 }).catch(() => undefined);
    }
  });
});

describe("writer runner native ownership", () => {
  type Rows = Record<string, unknown>[];
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  function pool(
    options: {
      lock?: boolean;
      prime?: () => Promise<Rows>;
      reserve?: () => Promise<void>;
      query?: (query: string) => Promise<Rows> | undefined;
    } = {}
  ) {
    const queries: string[] = [];
    let ended = 0;
    let released = 0;
    let reservedCount = 0;
    let primeCount = 0;
    const reserved = {
      unsafe: async (query: string): Promise<Rows> => {
        queries.push(query);
        const controlled = options.query?.(query);
        if (controlled) return controlled;
        if (query.includes("current_database"))
          return [{ dolt_writer_database: "knowledge_test" }];
        if (query.includes("pg_try_advisory_lock"))
          return [{ pg_try_advisory_lock: options.lock ?? true }];
        if (query.includes("pg_advisory_unlock"))
          return [{ pg_advisory_unlock: true }];
        if (query.includes("active_branch")) return [{ branch_name: "main" }];
        if (query.includes("dolt.merge_status")) return [{ is_merging: false }];
        return [];
      },
      release: () => {
        released++;
      },
    };
    const client = {
      unsafe: async () => {
        primeCount++;
        return await (options.prime?.() ?? Promise.resolve([]));
      },
      reserve: async () => {
        reservedCount++;
        await options.reserve?.();
        return reserved;
      },
      end: async () => {
        ended++;
      },
    } as unknown as Sql;
    return {
      client,
      queries,
      ended: () => ended,
      released: () => released,
      reserved: () => reservedCount,
      primed: () => primeCount,
    };
  }
  function logicalEngine(
    options: { body?: Promise<Rows>; deletion?: Promise<Rows> } = {}
  ) {
    const base = "b".repeat(32);
    const committed = "a".repeat(32);
    let active = "main";
    let dirty = false;
    let mainHead = base;
    let branchHead = base;
    return pool({
      query: (query) => {
        if (query.startsWith("SELECT name FROM dolt.branches"))
          return Promise.resolve([]);
        if (query.startsWith("SELECT dolt_checkout('-b'")) {
          active = query.split("'")[3] ?? "";
          branchHead = mainHead;
          return Promise.resolve([{ dolt_checkout: 0 }]);
        }
        if (query === "SELECT dolt_checkout('main')") {
          expect(dirty).toBe(false);
          active = "main";
          return Promise.resolve([{ dolt_checkout: 0 }]);
        }
        if (query.includes("active_branch"))
          return Promise.resolve([{ branch_name: active }]);
        if (query.includes("dolt_hashof"))
          return Promise.resolve([
            {
              commit_hash: query.includes("'HEAD'")
                ? active === "main"
                  ? mainHead
                  : branchHead
                : branchHead,
            },
          ]);
        if (query === "SELECT * FROM dolt.status")
          return Promise.resolve(dirty ? [{ table_name: "knowledge" }] : []);
        if (query.startsWith("DELETE FROM knowledge")) {
          dirty = true;
          return options.body ?? Promise.resolve([]);
        }
        if (query.startsWith("SELECT dolt_reset")) {
          expect(active).not.toBe("main");
          dirty = false;
          return Promise.resolve([{ dolt_reset: 0 }]);
        }
        if (query.startsWith("SELECT dolt_commit")) {
          dirty = false;
          branchHead = committed;
          return Promise.resolve([{ dolt_commit: [committed] }]);
        }
        if (query.startsWith("SELECT hash, fast_forward")) {
          mainHead = branchHead;
          return Promise.resolve([
            { hash: mainHead, conflicts: 0, fast_forward: true },
          ]);
        }
        if (query.startsWith("SELECT dolt_merge_base"))
          return Promise.resolve([{ merge_base: branchHead }]);
        if (query.startsWith("SELECT dolt_branch('-D'"))
          return options.deletion ?? Promise.resolve([{ dolt_branch: 0 }]);
        return undefined;
      },
    });
  }
  const flush = () => sleep(0);

  it("cannot restore a branch after admission fails without a guard", async () => {
    const first = pool({ lock: false });
    const runner = new DoltBranchSessionRunner(first.client, { lockWaitMs: 0 });
    let invoked = false;
    await expect(
      runner.run("contended", async () => {
        invoked = true;
      })
    ).rejects.toBeInstanceOf(KnowledgeBusyError);
    expect(invoked).toBe(false);
    expect(
      first.queries.some((query) =>
        /dolt_checkout|dolt.status|active_branch/.test(query)
      )
    ).toBe(false);
    expect(first.ended()).toBe(0);
  });

  it("retains one prime across caller timeout and retries, then recovers only after its response", async () => {
    const pending = deferred<Rows>();
    let slow = true;
    const first = pool({
      prime: () => (slow ? pending.promise : Promise.resolve([])),
    });
    let created = 0;
    let invoked = false;
    const runner = new DoltBranchSessionRunner(first.client, {
      acquireTimeoutMs: 10,
      recreateClient: () => {
        created++;
        return first.client;
      },
    });
    await expect(
      runner.run("prime", async () => {
        invoked = true;
      })
    ).rejects.toBeInstanceOf(KnowledgeBusyError);
    for (let i = 0; i < 10; i++)
      await expect(
        runner.run("retry", async () => undefined)
      ).rejects.toBeInstanceOf(KnowledgeBusyError);
    expect(first.primed()).toBe(1);
    expect(first.reserved()).toBe(0);
    expect(first.ended()).toBe(0);
    expect(created).toBe(0);
    slow = false;
    pending.resolve([]);
    await flush();
    expect(invoked).toBe(false);
    await expect(
      runner.run("after-settlement", async () => "ok")
    ).resolves.toBe("ok");
  });

  it("rejects already queued callers at abandonment without freeing the pending native owner", async () => {
    const pending = deferred<Rows>();
    const first = pool({ prime: () => pending.promise });
    const runner = new DoltBranchSessionRunner(first.client, {
      acquireTimeoutMs: 10,
      queueWaitMs: 1000,
    });
    let invoked = 0;
    const owner = runner.run("owner", async () => {
      invoked++;
    });
    const waiting = runner.run("already-queued", async () => {
      invoked++;
    });
    await expect(owner).rejects.toBeInstanceOf(KnowledgeBusyError);
    expect(await outcomeWithin(waiting, 30)).toBe("settled");
    await expect(waiting).rejects.toBeInstanceOf(KnowledgeBusyError);
    expect(first.primed()).toBe(1);
    expect(first.reserved()).toBe(0);
    expect(first.ended()).toBe(0);
    expect(invoked).toBe(0);
    pending.resolve([]);
    await flush();
  });

  it("retains a pending reservation and returns its late slot without invoking the callback", async () => {
    const pending = deferred<void>();
    let slow = true;
    const first = pool({
      reserve: () => (slow ? pending.promise : Promise.resolve()),
    });
    const runner = new DoltBranchSessionRunner(first.client, {
      acquireTimeoutMs: 10,
    });
    let invoked = false;
    await expect(
      runner.run("reserve", async () => {
        invoked = true;
      })
    ).rejects.toBeInstanceOf(KnowledgeBusyError);
    await expect(
      runner.run("retry", async () => undefined)
    ).rejects.toBeInstanceOf(KnowledgeBusyError);
    expect(first.reserved()).toBe(1);
    expect(first.released()).toBe(0);
    slow = false;
    pending.resolve();
    await flush();
    expect(first.released()).toBe(1);
    expect(invoked).toBe(false);
    await expect(runner.run("after", async () => "ok")).resolves.toBe("ok");
  });

  it.each(["bridge", "database"] as const)(
    "waits for a late successful %s advisory result before releasing its exact owned locks",
    async (writerProtocol) => {
      const pending = deferred<Rows>();
      let slow = true;
      const first = pool({
        query: (query) =>
          query.includes("pg_try_advisory_lock") && slow
            ? pending.promise
            : undefined,
      });
      const runner = new DoltBranchSessionRunner(first.client, {
        queryTimeoutMs: 10,
        writerProtocol,
      });
      let invoked = false;
      await expect(
        runner.run("lock", async () => {
          invoked = true;
        })
      ).rejects.toBeInstanceOf(KnowledgeBusyError);
      expect(
        first.queries.filter((q) => q.includes("pg_advisory_unlock"))
      ).toHaveLength(0);
      expect(first.released()).toBe(0);
      await expect(
        runner.run("retry", async () => undefined)
      ).rejects.toBeInstanceOf(KnowledgeBusyError);
      slow = false;
      pending.resolve([{ pg_try_advisory_lock: true }]);
      await flush();
      expect(invoked).toBe(false);
      expect(
        first.queries.filter((q) => q.includes("pg_advisory_unlock"))
      ).toEqual([
        first.queries
          .find((query) => query.includes("pg_try_advisory_lock"))
          ?.replace("pg_try_advisory_lock", "pg_advisory_unlock"),
      ]);
      expect(first.released()).toBe(1);
      await expect(runner.run("after", async () => "ok")).resolves.toBe("ok");
    }
  );

  it("preserves the issued receipt while clean positive settlement releases shared admission", async () => {
    const pending = deferred<Rows>();
    const first = pool({
      query: (query) =>
        query.includes("dolt_merge(")
          ? pending.promise
          : query.includes("dolt_commit(")
            ? Promise.resolve([{ dolt_commit: "a".repeat(32) }])
            : undefined,
    });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 10,
    });
    const request = runner.run(
      "write",
      async (connection) => {
        await connection.unsafe(
          "SELECT dolt_checkout('-b', 'dolt-op/owned', 'main')"
        );
        await connection.unsafe("SELECT dolt_commit('-Am', 'owned')");
        await connection.unsafe("SELECT dolt_checkout('main')");
        await connection.unsafe("SELECT dolt_merge('dolt-op/owned')");
        await connection.unsafe(
          "INSERT INTO knowledge VALUES ('must-not-run')"
        );
      },
      { operationId: "knowledge:stable-input" }
    );
    await expect(request).rejects.toMatchObject({
      name: "KnowledgeWriteOutcomeUnknownError",
      retryable: false,
      operationId: "knowledge:stable-input",
      branch: "dolt-op/owned",
      commitHash: "a".repeat(32),
    });
    expect(first.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(
      false
    );
    expect(first.released()).toBe(0);
    pending.resolve([{ conflicts: 0 }]);
    await flush();
    expect(first.queries.some((q) => /must-not-run/.test(q))).toBe(false);
    expect(first.ended()).toBe(0);
    expect(first.released()).toBe(1);
    await expect(
      runner.run("after-settlement", async () => "ok")
    ).resolves.toBe("ok");
  });

  it("a swallowed late SQL rejection cannot reopen an abandoned callback", async () => {
    const pending = deferred<Rows>();
    const first = pool({
      query: (query) => (query === "STALLED" ? pending.promise : undefined),
    });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 10,
    });
    await expect(
      runner.run("read-only", async (connection) => {
        try {
          await connection.unsafe("STALLED");
        } catch {
          /* callback swallows */
        }
        await connection.unsafe("SELECT forbidden_continuation");
      })
    ).rejects.toBeInstanceOf(KnowledgeWriteOutcomeUnknownError);
    expect(first.released()).toBe(0);
    pending.resolve([]);
    await flush();
    expect(first.queries).not.toContain("SELECT forbidden_continuation");
    expect(first.released()).toBe(1);
    await expect(runner.run("after", async () => "ok")).resolves.toBe("ok");
  });

  it("bug.5544: transport uncertainty evicts native capacity and does NOT wedge the next op", async () => {
    const first = pool({
      query: (query) =>
        query === "BROKEN"
          ? Promise.reject(new Error("socket disappeared"))
          : undefined,
    });
    let created = 0;
    const runner = new DoltBranchSessionRunner(first.client, {
      recreateClient: () => {
        created++;
        return first.client;
      },
    });
    await expect(
      runner.run("transport", async (connection) => {
        await connection.unsafe("BROKEN");
      })
    ).rejects.toBeInstanceOf(KnowledgeWriteOutcomeUnknownError);
    // A dead socket cannot be unlocked here; its server session frees the lock
    // when the abandoned op settles. But the connection IS evicted (released) and
    // the writer is NOT retained: the old code kept the socket + latched the
    // writer, which 503'd both writers until a pod restart (bug.5544).
    expect(first.ended()).toBe(0);
    expect(first.released()).toBe(1);
    expect(created).toBe(0);
    expect(first.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(
      false
    );
    // No wedge: the next operation is admitted and serves (was KnowledgeBusyError).
    await expect(runner.run("retry", async () => "unsafe")).resolves.toBe(
      "unsafe"
    );
  });

  it.each([
    "WITH changed AS (UPDATE knowledge SET value = 'x') SELECT 1",
    "SELECT mutate_knowledge()",
    "/* side effect */ CALL mutate_knowledge()",
  ])(
    "does not infer mutation absence from raw callback SQL: %s",
    async (query) => {
      const pending = deferred<Rows>();
      const first = pool({
        query: (sql) => (sql === query ? pending.promise : undefined),
      });
      const runner = new DoltBranchSessionRunner(first.client, {
        queryTimeoutMs: 10,
      });
      await expect(
        runner.run(
          "custom-sql",
          async (connection) => {
            await connection.unsafe(query);
          },
          { operationId: "custom:current-operation" }
        )
      ).rejects.toMatchObject({
        code: "knowledge_write_outcome_unknown",
        retryable: false,
        operationId: "custom:current-operation",
        branch: "main",
      });
      pending.resolve([]);
      await flush();
      expect(first.released()).toBe(1);
      expect(first.ended()).toBe(0);
      expect(
        first.queries.filter((sql) => sql.includes("pg_advisory_unlock"))
      ).toHaveLength(3);
    }
  );

  it("an escaped callback cannot borrow private cleanup authority while cleanup SQL is pending", async () => {
    const cleanup = deferred<Rows>();
    const started = deferred<void>();
    const first = pool({
      query: (query) => {
        if (query.includes("dolt.status")) {
          started.resolve();
          return cleanup.promise;
        }
        return undefined;
      },
    });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 1000,
    });
    let escaped!: DoltWriteConnection;
    let late!: Promise<void>;
    const request = runner.run("scope", async (connection) => {
      escaped = connection;
      late = started.promise.then(async () => {
        await expect(
          connection.unsafe("INSERT INTO knowledge VALUES ('escaped')")
        ).rejects.toThrow(/scope has closed/);
      });
      return "ok";
    });
    await started.promise;
    await late;
    await expect(escaped.unsafe("SELECT escaped_outside")).rejects.toThrow(
      /scope has closed/
    );
    expect(first.queries.some((q) => q.includes("escaped"))).toBe(false);
    cleanup.resolve([]);
    await expect(request).resolves.toBe("ok");
    await flush();
    expect(first.released()).toBe(1);
    await expect(escaped.unsafe("SELECT after_scope")).rejects.toThrow(
      /scope has closed/
    );
  });

  it("rejects escaped guard release before state mutation, then privately unlocks every owned key", async () => {
    const cleanup = deferred<Rows>();
    const started = deferred<void>();
    const first = pool({
      query: (query) => {
        if (query.includes("dolt.status")) {
          started.resolve();
          return cleanup.promise;
        }
        return undefined;
      },
    });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 1000,
    });
    let escapedGuard!: DoltBranchWriterGuard;
    const request = runner.run("guard-owner", async (_connection, guard) => {
      escapedGuard = guard;
      await expect(guard.release()).rejects.toThrow(/release is private/);
      return "ok";
    });
    await started.promise;
    await expect(escapedGuard.release()).rejects.toThrow(/release is private/);
    expect(
      first.queries.filter((query) => query.includes("pg_advisory_unlock"))
    ).toHaveLength(0);
    expect(first.released()).toBe(0);
    cleanup.resolve([]);
    await expect(request).resolves.toBe("ok");
    await flush();
    const acquired = first.queries.filter((query) =>
      query.includes("pg_try_advisory_lock")
    );
    const unlocked = first.queries.filter((query) =>
      query.includes("pg_advisory_unlock")
    );
    expect(unlocked).toEqual(
      [...acquired]
        .reverse()
        .map((query) =>
          query.replace("pg_try_advisory_lock", "pg_advisory_unlock")
        )
    );
    expect(first.released()).toBe(1);
    await expect(escapedGuard.release()).rejects.toThrow(/release is private/);
    expect(
      first.queries.filter((query) => query.includes("pg_advisory_unlock"))
    ).toHaveLength(acquired.length);
  });

  it("preserves a successful callback ACK while finite private cleanup retains capacity", async () => {
    const cleanup = deferred<Rows>();
    const started = deferred<void>();
    const first = pool({
      query: (query) => {
        if (query.includes("dolt.status")) {
          started.resolve();
          return cleanup.promise;
        }
        return undefined;
      },
    });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 10,
      queueWaitMs: 5,
    });
    const request = runner.run("acknowledged", async () => "business-result");
    await started.promise;
    await expect(request).resolves.toBe("business-result");
    await expect(
      runner.run("queued", async () => "must-not-run")
    ).rejects.toBeInstanceOf(KnowledgeBusyError);
    expect(first.reserved()).toBe(1);
    expect(first.released()).toBe(0);
    await sleep(15);
    await expect(request).resolves.toBe("business-result");
    cleanup.resolve([]);
    await flush();
    expect(first.released()).toBe(1);
    expect(first.ended()).toBe(0);
    await expect(runner.run("after", async () => "ok")).resolves.toBe("ok");
  });

  it("drains unawaited SQL before unlocking or releasing its FIFO ticket", async () => {
    const pending = deferred<Rows>();
    const first = pool({
      query: (query) => (query === "STALLED" ? pending.promise : undefined),
    });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 10,
    });
    await expect(
      runner.run("unawaited", async (connection) => {
        void connection.unsafe("STALLED").catch(() => undefined);
        return "callback-done";
      })
    ).rejects.toBeInstanceOf(KnowledgeWriteOutcomeUnknownError);
    expect(first.released()).toBe(0);
    expect(first.queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(
      false
    );
    pending.resolve([]);
    await flush();
    expect(first.released()).toBe(1);
  });

  it("the actual withWrite path resets only its settled uncommitted branch, preserves the 409/ref, and serves the next write", async () => {
    const body = deferred<Rows>();
    const first = logicalEngine({ body: body.promise });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 10,
    });
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: pool().client,
      writerSession: runner,
    });
    let continued = false;
    let escaped!: KnowledgeWriteSession;
    const request = store.withWrite(
      { operationId: "logical:finite-body", message: "owned body" },
      async (write) => {
        escaped = write;
        await write.deleteKnowledge("owned");
        continued = true;
        return 42;
      }
    );
    await expect(request).rejects.toMatchObject({
      code: "knowledge_write_outcome_unknown",
      retryable: false,
      operationId: "logical:finite-body",
    });
    expect(
      first.queries.some((query) => /dolt_reset|pg_advisory_unlock/.test(query))
    ).toBe(false);
    expect(first.released()).toBe(0);
    body.resolve([]);
    await flush();
    expect(continued).toBe(false);
    expect(
      first.queries.filter((query) => query.startsWith("DELETE FROM knowledge"))
    ).toHaveLength(1);
    expect(first.queries).toContain("SELECT dolt_reset('--hard', 'HEAD')");
    expect(
      first.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(false);
    expect(first.released()).toBe(1);
    await expect(request).rejects.toBeInstanceOf(
      KnowledgeWriteOutcomeUnknownError
    );
    await expect(escaped.deleteKnowledge("escaped")).rejects.toThrow();
    await expect(
      store.withWrite(
        { operationId: "logical:next", message: "next" },
        async (write) => {
          await write.deleteKnowledge("next");
          return 43;
        }
      )
    ).resolves.toBe(43);
  });

  it("the actual withWrite path ACKs proven merge before ref deletion and holds capacity until finite cleanup settles", async () => {
    const deletion = deferred<Rows>();
    const first = logicalEngine({ deletion: deletion.promise });
    const runner = new DoltBranchSessionRunner(first.client, {
      queryTimeoutMs: 10,
      queueWaitMs: 5,
    });
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: pool().client,
      writerSession: runner,
    });
    let escaped!: KnowledgeWriteSession;
    const request = store.withWrite(
      { operationId: "logical:committed-ack", message: "committed" },
      async (write) => {
        escaped = write;
        await write.deleteKnowledge("owned");
        return 42;
      }
    );
    await expect(request).resolves.toBe(42);
    await expect(escaped.deleteKnowledge("escaped")).rejects.toThrow();
    expect(
      first.queries.some((query) => query.startsWith("SELECT dolt_merge_base"))
    ).toBe(true);
    expect(
      first.queries.filter((query) =>
        query.startsWith("SELECT dolt_branch('-D'")
      )
    ).toHaveLength(1);
    expect(
      first.queries.some((query) => query.includes("pg_advisory_unlock"))
    ).toBe(false);
    expect(first.released()).toBe(0);
    await expect(
      runner.run("queued", async () => "unsafe")
    ).rejects.toBeInstanceOf(KnowledgeBusyError);
    await sleep(15);
    await expect(request).resolves.toBe(42);
    deletion.resolve([]);
    await flush();
    expect(first.released()).toBe(1);
    expect(first.ended()).toBe(0);
    await expect(runner.run("after", async () => "ok")).resolves.toBe("ok");
  });

  it("business uncertainty reconciles the original writer without aliasing or destroying readers", async () => {
    const first = pool();
    const reader = pool();
    let created = 0;
    const runner = new DoltBranchSessionRunner(first.client, {
      recreateClient: () => {
        created++;
        return reader.client;
      },
    });
    expect(() => runner.assertIndependentReadClient(first.client)).toThrow(
      /independent/
    );
    runner.assertIndependentReadClient(reader.client);
    await runner.run("retire", async (connection) => {
      await runner.retire(
        connection,
        new KnowledgeWriteOutcomeUnknownError("owned", "dolt-op/owned")
      );
    });
    expect(first.ended()).toBe(0);
    expect(reader.ended()).toBe(0);
    expect(created).toBe(0);
    expect(runner.client).toBe(first.client);
    await flush();
    await expect(
      runner.run("clean-settlement", async () => "ok")
    ).resolves.toBe("ok");
  });
});
