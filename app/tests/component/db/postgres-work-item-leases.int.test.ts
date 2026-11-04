// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real PostgreSQL concurrency, expiry-after-lock-wait, generation and restart proof. */
import { randomUUID } from "node:crypto";
import { toWorkItemId } from "@cogni/work-items";
import { PostgresWorkItemLeaseAdapter } from "@cogni/work-items/adapters/postgres";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const principalId = "lease-component";
const id = () => toWorkItemId(`task.${randomUUID()}`);

describe("PostgreSQL work-item leases", () => {
  let sql: Sql;
  let adapter: PostgresWorkItemLeaseAdapter;
  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL)
      throw new Error("component PostgreSQL required");
    sql = postgres(process.env.DATABASE_SERVICE_URL, { max: 10 });
    adapter = new PostgresWorkItemLeaseAdapter(sql);
  });
  afterAll(async () => {
    await sql?.unsafe("DELETE FROM work_item_leases WHERE principal_id = $1", [
      principalId,
    ]);
    await sql?.end({ timeout: 1 });
  });

  it("one winner among concurrent competing runs; same owner retry retains token", async () => {
    const workItemId = id();
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, n) =>
        adapter.claim({
          id: workItemId,
          principalId,
          runId: `run-${n}`,
          command: "test",
        })
      )
    );
    const wins = results.filter((result) => result.status === "fulfilled");
    expect(wins).toHaveLength(1);
    const winner = wins[0];
    if (winner?.status !== "fulfilled") throw new Error("missing winner");
    const retry = await adapter.claim({
      id: workItemId,
      principalId,
      runId: winner.value.runId,
      command: "retry",
    });
    expect(retry).toEqual(winner.value);
    await expect(
      adapter.heartbeat({
        id: workItemId,
        principalId: "foreign",
        runId: retry.runId,
        leaseToken: retry.leaseToken,
      })
    ).rejects.toMatchObject({ name: "WorkItemLeaseConflictError" });
  });

  it("release retry and adapter recreation preserve authority; successor rejects old tokens even for same run", async () => {
    const workItemId = id();
    const claim = await adapter.claim({
      id: workItemId,
      principalId,
      runId: "same-run",
      command: "test",
    });
    const owner = {
      id: workItemId,
      principalId,
      runId: claim.runId,
      leaseToken: claim.leaseToken,
    };
    const restarted = new PostgresWorkItemLeaseAdapter(sql);
    await expect(restarted.heartbeat(owner)).resolves.toMatchObject({
      active: true,
    });
    await expect(restarted.release(owner)).resolves.toMatchObject({
      active: false,
    });
    await expect(restarted.release(owner)).resolves.toMatchObject({
      active: false,
    });
    const successor = await restarted.claim({
      id: workItemId,
      principalId,
      runId: claim.runId,
      command: "reclaim",
    });
    expect(successor.leaseToken).not.toBe(claim.leaseToken);
    await expect(restarted.heartbeat(owner)).rejects.toMatchObject({
      name: "WorkItemLeaseConflictError",
    });
    await expect(restarted.release(owner)).rejects.toMatchObject({
      name: "WorkItemLeaseConflictError",
    });
  });

  it("checks server expiry after a lock-only wait while unrelated leases progress", async () => {
    const first = await adapter.claim({
      id: id(),
      principalId,
      runId: "locked",
      command: "test",
    });
    const other = await adapter.claim({
      id: id(),
      principalId,
      runId: "independent",
      command: "test",
    });
    await sql.unsafe(
      "UPDATE work_item_leases SET expires_at = clock_timestamp() + interval '300 milliseconds' WHERE work_item_id = $1",
      [first.id]
    );
    let unlock = () => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let locked = () => {};
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx.unsafe(
        "SELECT work_item_id FROM work_item_leases WHERE work_item_id = $1 FOR UPDATE",
        [first.id]
      );
      locked();
      await gate;
    });
    // postgres.js begins lazily; consume the transaction promise to start it.
    const hold = Promise.resolve(holder);
    await lockReady;
    const waiting = adapter
      .heartbeat({
        id: first.id,
        principalId,
        runId: first.runId,
        leaseToken: first.leaseToken,
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error })
      );
    try {
      await expect(
        adapter.heartbeat({
          id: other.id,
          principalId,
          runId: other.runId,
          leaseToken: other.leaseToken,
        })
      ).resolves.toMatchObject({ active: true });
      await sql.unsafe("SELECT pg_sleep(0.4)");
    } finally {
      unlock();
      await hold;
    }
    const outcome = await waiting;
    expect("error" in outcome && outcome.error.name).toBe(
      "WorkItemLeaseConflictError"
    );
    expect((await adapter.getMany([first.id])).size).toBe(0);
  });
  it("an expired claim takes its full TTL after lock wait and preserves stricter role budgets", async () => {
    const first = await adapter.claim({
      id: id(),
      principalId,
      runId: "old",
      command: "test",
    });
    await sql.unsafe(
      "UPDATE work_item_leases SET expires_at = clock_timestamp() + interval '300 milliseconds' WHERE work_item_id = $1",
      [first.id]
    );
    let unlock = () => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let ready = () => {};
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const hold = Promise.resolve(
      sql.begin(async (tx) => {
        await tx.unsafe(
          "SELECT work_item_id FROM work_item_leases WHERE work_item_id = $1 FOR UPDATE",
          [first.id]
        );
        ready();
        await gate;
      })
    );
    await locked;
    const stricter = postgres(process.env.DATABASE_SERVICE_URL as string, {
      max: 1,
      connection: { lock_timeout: "20ms", statement_timeout: "50ms" },
    });
    const limited = new PostgresWorkItemLeaseAdapter(stricter);
    try {
      await expect(
        limited.heartbeat({
          id: first.id,
          principalId,
          runId: first.runId,
          leaseToken: first.leaseToken,
        })
      ).rejects.toMatchObject({ name: "WorkItemsBusyError" });
      const [lockSetting] = await stricter.unsafe("SHOW lock_timeout");
      const [querySetting] = await stricter.unsafe("SHOW statement_timeout");
      expect(lockSetting?.lock_timeout).toBe("20ms");
      expect(querySetting?.statement_timeout).toBe("50ms");
      const acquiring = adapter.claim({
        id: first.id,
        principalId,
        runId: "successor",
        command: "takeover",
      });
      await sql.unsafe("SELECT pg_sleep(0.4)");
      unlock();
      await hold;
      const successor = await acquiring;
      expect(successor.active).toBe(true);
      expect(successor.leaseToken).not.toBe(first.leaseToken);
      expect(
        new Date(successor.expiresAt).getTime() - Date.now()
      ).toBeGreaterThan(295_000);
    } finally {
      unlock();
      await hold;
      await stricter.end({ timeout: 1 });
    }
  });

  it("1000 independent-agent renewals have zero conflicts through the bounded shared pool", async () => {
    const claims = await Promise.all(
      Array.from({ length: 100 }, (_, n) =>
        adapter.claim({
          id: id(),
          principalId,
          runId: `load-${n}`,
          command: "load",
        })
      )
    );
    const rounds = 10;
    for (let round = 0; round < rounds; round++) {
      const results = await Promise.all(
        claims.map((claim) =>
          adapter.heartbeat({
            id: claim.id,
            principalId,
            runId: claim.runId,
            leaseToken: claim.leaseToken,
          })
        )
      );
      expect(results.every((result) => result.active)).toBe(true);
    }
  }, 15_000);
});
