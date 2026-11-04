// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/unit/adapters/finance/credit-purchase-income.query`
 * Purpose: Prove the income query is built on the payment_attempts status index, joins payment_events only for the
 *   CREDITED timestamp, bounds the window on that event time, aggregates in SQL, and honours the reader's signal.
 * Scope: Real Drizzle query builder over the pg-proxy driver with a recording callback; no database.
 * Invariants: Reverting to intent time (payment_attempts.created_at) fails this test.
 * Side-effects: none
 * Links: src/adapters/server/finance/credit-purchase-income.query.ts
 * @internal
 */
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";

import type { Database } from "@/adapters/server/db/client";
import {
	CREDITED_STATUS,
	creditedPurchasesQuery,
} from "@/adapters/server/finance/credit-purchase-income.query";

function recordingDb() {
	const calls: { sql: string; params: unknown[]; method: string }[] = [];
	const db = drizzle(async (sql, params, method) => {
		calls.push({ sql, params, method });
		return { rows: [["4500", "3"]] };
	});
	return { db: db as unknown as Database, calls };
}

describe("creditedPurchasesQuery", () => {
	it("drives from payment_attempts.status, joins the CREDITED event for its time, bounds on that time, and aggregates", async () => {
		const { db, calls } = recordingDb();
		const since = new Date("2026-09-26T00:00:00.000Z");
		const totals = await creditedPurchasesQuery(db)(since, new AbortController().signal);
		expect(totals).toEqual({ totalUsdCents: 4500, count: 3 });
		expect(calls).toHaveLength(1);
		const sql = calls[0]?.sql.replace(/\s+/g, " ") ?? "";
		const params = calls[0]?.params ?? [];
		expect(sql).toMatch(/from "payment_attempts"/);
		expect(sql).toMatch(/inner join \(select .*min\("created_at"\) as "credited_at".*group by "payment_events"\."attempt_id"\) "credited"/);
		expect(sql).toMatch(/"payment_attempts"\."status" = \$\d/);
		expect(sql).toMatch(/"credited_at" >= \$\d/);
		expect(sql).toMatch(/"payment_events"\."event_type" = \$\d/);
		expect(sql).toMatch(/"payment_events"\."from_status" <> \$\d/);
		expect(sql).not.toMatch(/"payment_attempts"\."created_at"/);
		expect(sql).toMatch(/coalesce\(sum\("payment_attempts"\."amount_usd_cents"\), 0\)/);
		expect(sql).toMatch(/count\(\*\)/);
		expect(params.filter((p) => p === CREDITED_STATUS)).toHaveLength(3);
		expect(params.some((p) => p instanceof Date && p.getTime() === since.getTime() || p === since.toISOString())).toBe(true);
	});
	it("does not query once the reader's budget has already expired", async () => {
		const { db, calls } = recordingDb();
		const controller = new AbortController();
		controller.abort();
		await expect(creditedPurchasesQuery(db)(new Date(), controller.signal)).rejects.toThrow("income query aborted");
		expect(calls).toHaveLength(0);
	});
});


describe("canonical credited transitions", () => {
  it.each([
    ["duplicate real transitions", [
      ["STATUS_CHANGED", "VERIFIED", "CREDITED", "2026-10-01T00:00:00.000Z"],
      ["STATUS_CHANGED", "VERIFIED", "CREDITED", "2026-10-02T00:00:00.000Z"],
    ], { totalUsdCents: 1000, count: 1 }],
    ["old purchase with recent verification and status-preserving events", [
      ["STATUS_CHANGED", "VERIFIED", "CREDITED", "2026-08-01T00:00:00.000Z"],
      ["VERIFICATION_ATTEMPTED", "CREDITED", "CREDITED", "2026-10-01T00:00:00.000Z"],
      ["STATUS_CHANGED", "CREDITED", "CREDITED", "2026-10-02T00:00:00.000Z"],
    ], { totalUsdCents: 0, count: 0 }],
    ["old intent credited inside the window", [
      ["STATUS_CHANGED", "VERIFIED", "CREDITED", "2026-10-01T00:00:00.000Z"],
    ], { totalUsdCents: 1000, count: 1 }],
  ] as const)("counts %s by the first transition only", async (_name, events, expected) => {
    // Execute the real builder's portable SELECT against an in-memory relational engine.
    // This proves aggregation semantics, not Postgres adapter/schema integration.
    const memory = new DatabaseSync(":memory:");
    try {
      memory.exec('CREATE TABLE payment_attempts (id TEXT, status TEXT, amount_usd_cents INTEGER, created_at TEXT); CREATE TABLE payment_events (attempt_id TEXT, event_type TEXT, from_status TEXT, to_status TEXT, created_at TEXT)');
      memory.prepare("INSERT INTO payment_attempts VALUES (?, ?, ?, ?)").run("attempt", "CREDITED", 1000, "2026-07-01T00:00:00.000Z");
      for (const event of events) memory.prepare("INSERT INTO payment_events VALUES (?, ?, ?, ?, ?)").run("attempt", ...event);
      const db = drizzle(async (sql, params) => {
        const rows = memory.prepare(sql.replace(/\$\d+/g, "?")).all(...params.map((value) => value instanceof Date ? value.toISOString() : value));
        return { rows: rows.map(Object.values) };
      });
      await expect(creditedPurchasesQuery(db as unknown as Database)(new Date("2026-09-26T00:00:00.000Z"), new AbortController().signal)).resolves.toEqual(expected);
    } finally { memory.close(); }
  });
});
