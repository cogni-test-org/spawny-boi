// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";

import { type MoneyPlaneRow, summarize, takeSnapshot, toUsd, usdBurn } from "../src/index";

const NOW = "2026-10-26T13:40:00.000Z";
const RATE = {
  pair: "EURUSD",
  value: 1.1188,
  source: "ECB" as const,
  date: "2026-10-26",
};
function row(
  over: Partial<MoneyPlaneRow> & Pick<MoneyPlaneRow, "plane">
): MoneyPlaneRow {
  return {
    label: over.plane,
    kind: "usage",
    balance: null,
    currency: "USD",
    burnPerDay: null,
    runwayDays: null,
    grade: "INFO",
    observedAt: NOW,
    sourceObservedAt: NOW,
    freshness: "current",
    ...over,
  };
}

describe("summarize", () => {
  it("sums income and burn in USD, converts EUR, and names the shortest graded runway", () => {
    const rows = [
      row({ plane: "income", kind: "income", burnPerDay: 1.5 }),
      row({
        plane: "treasury",
        label: "DAO treasury",
        kind: "wallet",
        currency: "USDC",
        balance: 74.52,
      }),
      row({
        plane: "akash",
        label: "Akash",
        kind: "prepaid",
        balance: 7.89,
        burnPerDay: 3.13,
        runwayDays: 2.52,
        grade: "RED",
      }),
      row({
        plane: "cherry",
        label: "Cherry credit",
        kind: "prepaid",
        currency: "EUR",
        balance: 12.4,
        burnPerDay: 0.3432,
        runwayDays: 36,
        grade: "GREEN",
      }),
      row({ plane: "grafana", burnPerDay: 9.7173 }),
      row({
        plane: "domain",
        kind: "expiry",
        currency: null,
        runwayDays: 161,
        grade: "GREEN",
      }),
      row({ plane: "unread", grade: "UNKNOWN" }),
    ].map((r) => toUsd(r, [RATE]));
    const summary = summarize({ rows }, { treasuryPlane: "treasury" });
    expect(summary.treasuryUsd).toBe(74.52);
    expect(summary.incomePerDay).toBe(1.5);
    expect(summary.burnPerDay).toBeCloseTo(3.13 + 0.3432 * 1.1188 + 9.7173, 9);
    expect(summary.nextDeadline).toEqual({ days: 2.52, label: "Akash" });
    expect(summary.runwayDays).toBeNull();
    expect(summary.costCoverageGaps).toEqual(["unread"]);
    expect(summary.runwayReason).toBe("costs_incomplete");
    expect(summary.ratesUsed).toEqual([RATE]);
    expect(summary.unconverted).toEqual([]);
  });
  it("never double counts children under a rollup parent, but uses children when the parent has no burn", () => {
    const akash = row({
      plane: "akash",
      kind: "prepaid",
      balance: 7.89,
      burnPerDay: 3.13,
      children: [
        row({ plane: "akash:poly", burnPerDay: 1.57 }),
        row({ plane: "akash:red", burnPerDay: 1.56 }),
      ],
    });
    const grafana = row({
      plane: "grafana",
      children: [
        row({ plane: "logs", burnPerDay: 6 }),
        row({ plane: "metrics", burnPerDay: 4 }),
      ],
    });
    const summary = summarize({
      rows: [akash, grafana].map((r) => toUsd(r, [])),
    });
    expect(summary.burnPerDay).toBeCloseTo(3.13 + 10, 9);
    expect(summary.incomePerDay).toBeNull();
    expect(summary.treasuryUsd).toBeNull();
  });
  it("reports an unconverted EUR row instead of guessing, and nulls when nothing is measured", () => {
    const summary = summarize({
      rows: [
        row({
          plane: "cherry",
          label: "Cherry credit",
          kind: "prepaid",
          currency: "EUR",
          balance: 12.4,
          burnPerDay: 0.34,
          grade: "UNKNOWN",
        }),
      ],
    });
    expect(summary.burnPerDay).toBeNull();
    expect(summary.unconverted).toEqual(["Cherry credit"]);
    expect(summary.nextDeadline).toBeNull();
    expect(summary.runwayDays).toBeNull();
    expect(summarize({ rows: [] })).toEqual({
      treasuryUsd: null,
      incomePerDay: null,
      incomeCoverageGaps: [],
      burnPerDay: null,
      runwayDays: null,
      runwayReason: "treasury_unreadable",
      costCoverageGaps: [],
      nextDeadline: null,
      windowDays: 30,
      ratesUsed: [],
      unconverted: [],
    });
    expect(summarize({ rows: [] }, { windowDays: 7 }).windowDays).toBe(7);
  });
  it("keeps DAO runway and the next deadline apart: a soon-expiring domain moves the deadline, not the runway", () => {
    const base = [
      row({
        plane: "treasury",
        label: "DAO treasury",
        kind: "wallet",
        currency: "USDC",
        balance: 100,
      }),
      row({ plane: "income", kind: "income", burnPerDay: 2 }),
      row({ plane: "hosting", burnPerDay: 12 }),
    ].map((r) => toUsd(r, []));
    const calm = summarize({ rows: base }, { treasuryPlane: "treasury" });
    expect(calm.runwayDays).toBeCloseTo(100 / 12);
    expect(calm.nextDeadline).toBeNull();
    const expiring = summarize(
      {
        rows: [
          ...base,
          row({
            plane: "domain",
            label: "Domain cognidao.org",
            kind: "expiry",
            currency: null,
            runwayDays: 3,
            grade: "RED",
          }),
        ],
      },
      { treasuryPlane: "treasury" }
    );
    expect(expiring.runwayDays).toBeCloseTo(100 / 12);
    expect(expiring.nextDeadline).toEqual({
      days: 3,
      label: "Domain cognidao.org",
    });
    const surplus = summarize(
      {
        rows: [
          base[0]!,
          toUsd(row({ plane: "income", kind: "income", burnPerDay: 20 }), []),
          base[2]!,
        ],
      },
      { treasuryPlane: "treasury" }
    );
    expect(surplus.runwayDays).toBeCloseTo(100 / 12);
  });
});

describe("honest runway coverage", () => {
  const treasury = () =>
    toUsd(row({ plane: "treasury", kind: "wallet", balance: 100 }), []);
  const summaryOf = (...costs: MoneyPlaneRow[]) =>
    summarize(
      { rows: [treasury(), ...costs.map((r) => toUsd(r, []))] },
      { treasuryPlane: "treasury" }
    );
  it("keeps known burn without forecasting from incomplete costs and historical receipts", () => {
    const summary = summaryOf(
      row({ plane: "measured", burnPerDay: 1 }),
      row({ plane: "hosting", grade: "UNKNOWN" }),
      row({ plane: "purchases", kind: "income", burnPerDay: 2 })
    );
    expect(summary).toMatchObject({
      burnPerDay: 1,
      incomePerDay: 2,
      runwayDays: null,
      costCoverageGaps: ["hosting"],
      runwayReason: "costs_incomplete",
    });
  });
  it.each([
    ["missing", { burnPerDay: null }],
    ["unknown currency", { currency: null }],
    ["unconverted", { currency: "EUR" }],
    ["stale", { freshness: "stale" }],
    ["unknown freshness", { freshness: "unknown" }],
    ["missing observation", { sourceObservedAt: null }],
    ["read failed", { reasonCode: "unreadable" }],
    ["negative", { burnPerDay: -1 }],
    ["nonfinite", { burnPerDay: Number.POSITIVE_INFINITY }],
    ["NaN", { burnPerDay: Number.NaN }],
  ] as const)("marks %s cost evidence as a gap", (_name, bad) => {
    const summary = summaryOf(row({ plane: "cost", burnPerDay: 2, ...bad }));
    expect(summary.runwayDays).toBeNull();
    expect(summary.costCoverageGaps).toEqual(["cost"]);
  });
  it("does not hide missing child coverage behind a measured parent or count children twice", () => {
    const summary = summaryOf(
      row({
        plane: "fleet",
        burnPerDay: 10,
        children: [
          row({ plane: "known", burnPerDay: 9 }),
          row({ plane: "missing", grade: "UNKNOWN" }),
        ],
      })
    );
    expect(summary).toMatchObject({
      burnPerDay: 10,
      costCoverageGaps: ["missing"],
      runwayDays: null,
    });
  });
  it("allows complete grouping children but not an independent parent failure", () => {
    const parent = row({
      plane: "group",
      children: [
        row({ plane: "a", burnPerDay: 4 }),
        row({ plane: "b", burnPerDay: 6 }),
      ],
    });
    expect(summaryOf(parent)).toMatchObject({
      burnPerDay: 10,
      runwayDays: 10,
      costCoverageGaps: [],
    });
    expect(summaryOf({ ...parent, reasonCode: "unreadable" })).toMatchObject({
      runwayDays: null,
      costCoverageGaps: ["group"],
    });
  });
  it("excludes wallets, planned income and date-only expiry rows from costs", () => {
    const summary = summaryOf(
      row({ plane: "known", burnPerDay: 10 }),
      row({
        plane: "wallet",
        kind: "wallet",
        burnPerDay: 999,
        grade: "UNKNOWN",
      }),
      row({ plane: "planned income", kind: "income", grade: "UNKNOWN" }),
      row({
        plane: "domain",
        kind: "expiry",
        currency: null,
        runwayDays: 7,
        grade: "YELLOW",
      })
    );
    expect(summary).toMatchObject({
      burnPerDay: 10,
      runwayDays: 10,
      costCoverageGaps: [],
      runwayReason: null,
    });
  });
  it("does not call verified zero burn unlimited runway", () => {
    expect(summaryOf(row({ plane: "zero", burnPerDay: 0 }))).toMatchObject({
      burnPerDay: 0,
      runwayDays: null,
      runwayReason: "no_measured_burn",
      costCoverageGaps: [],
    });
  });
  it.each([
    { freshness: "stale" },
    { sourceObservedAt: null },
    { balance: -1 },
    { balance: Number.POSITIVE_INFINITY },
    { reasonCode: "unreadable" },
  ] as const)("requires current readable treasury evidence: %j", (bad) => {
    const summary = summarize(
      {
        rows: [
          { ...treasury(), ...bad },
          row({ plane: "known", burnPerDay: 1 }),
        ],
      },
      { treasuryPlane: "treasury" }
    );
    expect(summary.treasuryUsd).toBeNull();
    expect(summary.runwayDays).toBeNull();
    expect(summary.runwayReason).toBe("treasury_unreadable");
  });
  it("rejects aggregate, FX conversion and division overflow", () => {
    const huge = row({ plane: "huge", burnPerDay: Number.MAX_VALUE });
    expect(summaryOf(huge, { ...huge, plane: "huge2" }).burnPerDay).toBeNull();
    expect(summaryOf(huge, { ...huge, plane: "huge2" }).runwayDays).toBeNull();
    const foreign = toUsd({ ...huge, currency: "EUR" }, [
      { ...RATE, value: 2 },
    ]);
    expect(
      summarize({ rows: [treasury(), foreign] }, { treasuryPlane: "treasury" })
    ).toMatchObject({
      burnPerDay: null,
      runwayDays: null,
      costCoverageGaps: ["huge"],
    });
    expect(
      summaryOf(row({ plane: "tiny", burnPerDay: Number.MIN_VALUE })).runwayDays
    ).toBeNull();
  });
});


it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("retains invalid expiry cost evidence through the snapshot pipeline: %s", async (burnPerDay) => {
  const rows = [row({ plane: "treasury", kind: "wallet", balance: 100 }), row({ plane: "hosting", burnPerDay: 1 }), row({ plane: "renewal", kind: "expiry", burnPerDay, runwayDays: 20, grade: "GREEN" })];
  const snapshot = await takeSnapshot(rows.map((r) => ({ plane: r.plane, read: async () => r })), { timeoutMs: 1000 });
  const summary = summarize({ rows: snapshot.rows.map((r) => toUsd(r, [])) }, { treasuryPlane: "treasury" });
  expect(summary.runwayDays).toBeNull();
  expect(summary.costCoverageGaps).toContain("renewal");
});


it("does not treat a parent with its own unconverted native rate as a grouping container", () => {
  const rows = [row({ plane: "treasury", kind: "wallet", balance: 100 }), row({ plane: "vendor", currency: "EUR", nativeRate: { amount: "10", currency: "EUR", per: "day" }, children: [row({ plane: "child", burnPerDay: 1 })] })].map((r) => toUsd(r, []));
  expect(summarize({ rows }, { treasuryPlane: "treasury" })).toMatchObject({ runwayDays: null, costCoverageGaps: ["vendor"] });
});
it("never projects an absent denomination into dollars", () => {
  expect(usdBurn(row({ plane: "unknown", currency: null, burnPerDay: 1 }))).toBeUndefined();
});


it.each([
  ["stale", { freshness: "stale" as const }],
  ["failed", { reasonCode: "unreadable" as const }],
  ["undated", { sourceObservedAt: null }],
  ["invalid currency", { currency: null }],
])("excludes %s income from current receipts and reports partial coverage", async (_label, evidence) => {
  const source = row({ plane: "missing income", kind: "income", burnPerDay: 2, ...evidence });
  const snap = await takeSnapshot([{ plane: source.plane, read: async () => source }], { timeoutMs: 100 });
  expect(summarize(snap)).toMatchObject({ incomePerDay: null, incomeCoverageGaps: ["missing income"] });
  const partial = summarize({ rows: [...snap.rows, row({ plane: "known income", kind: "income", burnPerDay: 1 })] });
  expect(partial).toMatchObject({ incomePerDay: 1, incomeCoverageGaps: ["missing income"] });
});
it("keeps income rollups single-counted while exposing unavailable child coverage", () => {
  const good = row({ plane: "known", kind: "income", burnPerDay: 1 });
  const missing = row({ plane: "missing", kind: "income", burnPerDay: 3, freshness: "stale" });
  const parent = row({ plane: "rollup", kind: "income", burnPerDay: 1, children: [good, missing] });
  expect(summarize({ rows: [parent] })).toMatchObject({ incomePerDay: 1, incomeCoverageGaps: ["missing"] });
  expect(summarize({ rows: [{ ...parent, burnPerDay: null, children: [good] }] })).toMatchObject({ incomePerDay: 1, incomeCoverageGaps: [] });
});
