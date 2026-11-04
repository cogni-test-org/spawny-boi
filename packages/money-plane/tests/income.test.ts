// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";

import { creditPurchaseIncomeReader, takeSnapshot } from "../src/index";

const NOW = new Date("2026-10-26T13:40:00.000Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("creditPurchaseIncomeReader", () => {
  it("sums credited purchases in the trailing 30 days into USD per day and survives the grading floor", async () => {
    const since: Date[] = [];
    const signals: AbortSignal[] = [];
    const reader = creditPurchaseIncomeReader({
      now: () => NOW,
      query: async (s, signal) => {
        since.push(s);
        signals.push(signal);
        return { totalUsdCents: 4500, count: 3 };
      },
    });
    expect(reader.kind).toBe("income");
    expect(since[0]).toBeUndefined();
    const snap = await takeSnapshot([reader], { timeoutMs: 1000, now: () => NOW });
    expect(since[0]?.toISOString()).toBe(day(30).toISOString());
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    const row = snap.rows[0];
    expect(row).toMatchObject({
      plane: "income:credit-purchases",
      label: "Credit purchases",
      kind: "income",
      balance: null,
      currency: "USD",
      runwayDays: null,
      grade: "INFO",
      rail: { kind: "split-inflow", status: "supported" },
      detail: "3 purchases · 45.00 USD in 30d",
      source: "payment_events · CREDITED · trailing 30 days",
    });
    const byIntent = await creditPurchaseIncomeReader({
      now: () => NOW,
      basis: "intent",
      query: async () => ({ totalUsdCents: 0, count: 0 }),
    }).read(new AbortController().signal);
    expect(byIntent.source).toContain("by intent time");
    expect(row?.burnPerDay).toBeCloseTo(1.5, 9);
  });
  it("reports a measured zero when there are no purchases and UNKNOWN when the query fails", async () => {
    const zero = await creditPurchaseIncomeReader({
      now: () => NOW,
      query: async () => ({ totalUsdCents: 0, count: 0 }),
    }).read(new AbortController().signal);
    expect(zero).toMatchObject({ grade: "INFO", burnPerDay: 0, detail: "0 purchases · 0.00 USD in 30d" });
    const failed = await creditPurchaseIncomeReader({
      now: () => NOW,
      query: async () => {
        throw new Error("sensitive-dsn");
      },
    }).read(new AbortController().signal);
    expect(failed).toMatchObject({
      grade: "UNKNOWN",
      reasonCode: "unreadable",
      detail: "income read failed",
      rail: { kind: "split-inflow" },
    });
    expect(JSON.stringify(failed)).not.toContain("sensitive-dsn");
    const malformed = await creditPurchaseIncomeReader({
      now: () => NOW,
      query: async () => ({ totalUsdCents: Number.NaN, count: -1 }),
    }).read(new AbortController().signal);
    expect(malformed).toMatchObject({ grade: "UNKNOWN", reasonCode: "unreadable" });
  });
});
