// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests/component/db/schedule-history
 * Purpose: Prove owned schedule reader isolation and complete seek pagination in PostgreSQL.
 * Scope: Real app_user RLS and service-role fixtures; does not run Temporal.
 * Invariants: Own schedule controls access; null requesters/slots remain visible; cursor preserves microseconds.
 * Side-effects: IO (isolated test database)
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
import { randomUUID } from "node:crypto";
import { type Database, DrizzleScheduleRunReader } from "@cogni/db-client";
import {
  billingAccounts,
  executionGrants,
  graphRuns,
  schedules,
  users,
} from "@cogni/db-schema";
import { toUserId } from "@cogni/ids";
import { generateTestWallet } from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";

const ownerA = toUserId(randomUUID());
const ownerB = toUserId(randomUUID());
const scheduleA = randomUUID();
const scheduleB = randomUUID();
const scheduleA2 = randomUUID();
const ids = Array.from({ length: 8 }, () => randomUUID());
let seed: Database;
let reader: DrizzleScheduleRunReader;

describe("schedule history reader (real RLS)", () => {
  beforeAll(async () => {
    seed = getSeedDb();
    reader = new DrizzleScheduleRunReader(getAppDb());
    for (const [owner, scheduleIds] of [
      [ownerA, [scheduleA, scheduleA2]],
      [ownerB, [scheduleB]],
    ] as const) {
      const billingId = randomUUID();
      const grantId = randomUUID();
      await seed.insert(users).values({
        id: owner,
        name: "Schedule history fixture",
        walletAddress: generateTestWallet(owner),
      });
      await seed
        .insert(billingAccounts)
        .values({ id: billingId, ownerUserId: owner, balanceCredits: 0n });
      await seed.insert(executionGrants).values({
        id: grantId,
        userId: owner,
        billingAccountId: billingId,
        scopes: ["graph:execute:test:history"],
      });
      for (const scheduleId of scheduleIds)
        await seed.insert(schedules).values({
          id: scheduleId,
          ownerUserId: owner,
          executionGrantId: grantId,
          graphId: "test:history",
          input: {},
          cron: "0 9 * * *",
          timezone: "UTC",
          enabled: true,
        });
    }
    for (let i = 0; i < 6; i++) {
      await seed.insert(graphRuns).values({
        id: ids[i],
        runId: `history-${ids[i]}`,
        scheduleId: scheduleA,
        requestedBy: i === 0 ? null : ownerB,
        status: "pending",
        stateKey:
          i < 2
            ? "shared-conversation"
            : i === 2
              ? "distinct-conversation"
              : null,
        scheduledFor: i < 4 ? new Date(`2026-10-24T00:00:0${4 - i}Z`) : null,
      });
    }
    // Values differ below Date precision: seek must retain both, in correct order.
    await seed
      .update(graphRuns)
      .set({ scheduledFor: sql`'2026-10-24T00:00:04.000999Z'::timestamptz` })
      .where(eq(graphRuns.id, ids[0] ?? ""));
    await seed
      .update(graphRuns)
      .set({ scheduledFor: sql`'2026-10-24T00:00:04.000001Z'::timestamptz` })
      .where(eq(graphRuns.id, ids[1] ?? ""));
    await seed.insert(graphRuns).values({
      id: ids[6],
      runId: "foreign-schedule-run",
      scheduleId: scheduleB,
      requestedBy: ownerA,
      scheduledFor: new Date("2026-10-25T00:00:00Z"),
    });
    await seed.insert(graphRuns).values({
      id: ids[7],
      runId: "other-owned-schedule-run",
      scheduleId: scheduleA2,
      requestedBy: ownerA,
    });
  });
  afterAll(async () => {
    await seed.delete(users).where(inArray(users.id, [ownerA, ownerB]));
  });

  it("includes owned schedule history with null/other requester and never includes foreign schedules", async () => {
    const rows = await reader.listRuns(ownerA, scheduleA, { limit: 50 });
    expect(rows).toHaveLength(6);
    expect(rows.every((run) => run.startedAt === null)).toBe(true);
    expect(rows.slice(0, 3).map((run) => run.stateKey)).toEqual([
      "shared-conversation",
      "shared-conversation",
      "distinct-conversation",
    ]);
    expect(rows.slice(3).every((run) => run.stateKey === null)).toBe(true);
    expect(await reader.listRuns(ownerB, scheduleA, { limit: 50 })).toEqual([]);
    // requestedBy=caller alone cannot grant access through another owner's schedule.
    expect(await reader.listRuns(ownerA, scheduleB, { limit: 50 })).toEqual([]);
  });

  it("seeks complete pages through microsecond slots and NULL-slot UUID ties", async () => {
    const actual: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const rows = await reader.listRuns(ownerA, scheduleA, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      if (rows[0]) actual.push(rows[0].id);
      if (rows.length <= 1) break;
      cursor = rows[0]?.id;
    }
    expect(actual).toEqual([
      ids[0],
      ids[1],
      ids[2],
      ids[3],
      ...[ids[4], ids[5]].sort().reverse(),
    ]);
    expect(new Set(actual).size).toBe(6);
  });

  it("rejects missing, foreign and same-owner other-schedule cursors", async () => {
    for (const cursor of [randomUUID(), ids[6], ids[7]]) {
      if (!cursor) throw new Error("Missing cursor fixture");
      await expect(
        reader.listRuns(ownerA, scheduleA, { limit: 1, cursor })
      ).rejects.toThrow("Invalid history cursor");
    }
  });

  it("rejects a deleted cursor instead of silently returning an incomplete page", async () => {
    const id = randomUUID();
    await seed
      .insert(graphRuns)
      .values({ id, scheduleId: scheduleA2, runId: `deleted-${id}` });
    await seed.delete(graphRuns).where(eq(graphRuns.id, id));
    await expect(
      reader.listRuns(ownerA, scheduleA2, { limit: 1, cursor: id })
    ).rejects.toThrow("Invalid history cursor");
  });
});
