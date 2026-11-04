// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/report`
 * Purpose: The one summary every node shows above its Financials table: treasury, cash received/day, burn/day, known-cost runway (treasury ÷ measured burn) and the next constrained deadline, in USD.
 * Scope: Pure aggregation over a snapshot already projected with `toUsd`. Does not read, grade, or render.
 * Invariants: USD only — a row without a USD projection does not count and is listed in `unconverted`. A parent that
 *   carries burn is the rollup; its children are never added again. Past receipts never offset forecast costs. Missing cost evidence prevents a runway estimate.
 * Side-effects: none
 * Links: ./fx.ts, https://cognidao.org/knowledge/finances-expert
 * @public
 */

import { usdBalance, usdBurn } from "./fx";
import type { MoneyPlaneRow, MoneyPlaneSnapshot, UsdRate } from "./types";

export interface ReportSummary {
  /** The configured treasury's USD balance, or null when unknown or unidentified. */
  treasuryUsd: number | null;
  /** Σ income rows' USD per day; null when no income row is measured. */
  incomePerDay: number | null;
  /** Registered income lines without current, dated, valid USD evidence. */
  incomeCoverageGaps: string[];
  /** Σ cost rows' USD per day (children not double counted); null when nothing is measured. */
  burnPerDay: number | null;
  /** Current treasury ÷ known daily costs; null for any coverage gap, unreadable treasury, zero burn or invalid result. */
  runwayDays: number | null;
  /** Why the estimate is absent; null only for a finite estimate. */
  runwayReason:
    | "treasury_unreadable"
    | "costs_incomplete"
    | "no_measured_burn"
    | "estimate_unavailable"
    | null;
  /** Registered cost lines with missing, failed, stale or invalid rate evidence, including rollup children. */
  costCoverageGaps: string[];
  /** The graded line that runs out or expires first (a vendor credit, a lease escrow, a domain). */
  nextDeadline: { days: number; label: string } | null;
  /** The income window in days the Cash received card names; from `SummarizeOptions.windowDays` (default 30). */
  windowDays: number;
  /** Rates that were applied to at least one row, for the "EUR→USD 1.1188 · ECB date" line. */
  ratesUsed: UsdRate[];
  /** Labels of rows carrying a non-USD amount that could not be projected. */
  unconverted: string[];
}

export interface SummarizeOptions {
  treasuryPlane?: string | null;
  /** The income reader's window, so the card label matches the math. */
  windowDays?: number;
}

function flows(rows: readonly MoneyPlaneRow[]): MoneyPlaneRow[] {
  // A native measured parent owns the total, even if its USD projection is missing.
  return rows.flatMap((row) =>
    row.burnPerDay !== null || row.nativeRate !== undefined || !row.children?.length
      ? [row]
      : flows(row.children)
  );
}

function finiteAmount(value: number | undefined | null): value is number {
  return (
    value !== undefined &&
    value !== null &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function sumOrNull(values: readonly (number | undefined)[]): number | null {
  const known = values.filter(finiteAmount);
  const sum = known.reduce((a, b) => a + b, 0);
  return known.length && finiteAmount(sum) ? sum : null;
}

function currentEvidence(row: MoneyPlaneRow): boolean {
  return (
    row.freshness === "current" &&
    Boolean(
      row.sourceObservedAt && Number.isFinite(Date.parse(row.sourceObservedAt))
    ) &&
    ![
      "unconfigured",
      "unreadable",
      "timeout",
      "stale",
      "burn_unmeasured",
    ].includes(row.reasonCode ?? "")
  );
}

function costRow(row: MoneyPlaneRow): boolean {
  return (
    row.kind === "prepaid" ||
    row.kind === "usage" ||
    row.kind === "fixed" ||
    (row.kind === "expiry" &&
      (row.burnPerDay !== null ||
        row.nativeRate !== undefined ||
        row.reasonCode === "burn_unmeasured"))
  );
}

function measuredFlow(row: MoneyPlaneRow): number | undefined {
  const value = usdBurn(row);
  return row.currency && currentEvidence(row) && finiteAmount(value)
    ? value
    : undefined;
}

function missingCost(row: MoneyPlaneRow): boolean {
  if (!costRow(row)) return false;
  if (!currentEvidence(row)) return true;
  // A rate-less parent may group child costs, but cannot hide its own failed read.
  if (row.burnPerDay === null && row.nativeRate === undefined && row.children?.some(costRow)) return false;
  return measuredFlow(row) === undefined;
}

function graded(row: MoneyPlaneRow): boolean {
  return (
    (row.grade === "RED" || row.grade === "YELLOW" || row.grade === "GREEN") &&
    row.runwayDays !== null &&
    finiteAmount(row.runwayDays) &&
    currentEvidence(row)
  );
}

function walk(rows: readonly MoneyPlaneRow[]): MoneyPlaneRow[] {
  return rows.flatMap((row) => [row, ...walk(row.children ?? [])]);
}

export function summarize(
  snapshot: Pick<MoneyPlaneSnapshot, "rows">,
  options: SummarizeOptions = {}
): ReportSummary {
  const all = walk(snapshot.rows);
  const treasury = options.treasuryPlane
    ? snapshot.rows.find((row) => row.plane === options.treasuryPlane)
    : undefined;
  const income = flows(
    snapshot.rows.filter((row) => row.kind === "income")
  ).filter((row) => row.kind === "income");
  const incomeCoverageGaps = [...new Set(all.filter((row) => {
    if (row.kind !== "income") return false;
    if (!currentEvidence(row)) return true;
    const grouping = row.burnPerDay === null && row.nativeRate === undefined &&
      row.children?.some((child) => child.kind === "income");
    return !grouping && measuredFlow(row) === undefined;
  }).map((row) => row.label))];
  const costs = flows(snapshot.rows.filter(costRow)).filter(costRow);
  const costCoverageGaps = [
    ...new Set(all.filter(missingCost).map((row) => row.label)),
  ];
  const shortest = all
    .filter(graded)
    .reduce<MoneyPlaneRow | null>(
      (best, row) =>
        best === null || (row.runwayDays ?? 0) < (best.runwayDays ?? 0)
          ? row
          : best,
      null
    );
  const ratesUsed = new Map<string, UsdRate>();
  for (const row of all)
    if (row.usd?.rate) ratesUsed.set(row.usd.rate.pair, row.usd.rate);
  const unconverted = all
    .filter(
      (row) =>
        row.currency &&
        row.currency !== "USD" &&
        row.currency !== "USDC" &&
        !row.usd &&
        (row.balance !== null || row.burnPerDay !== null)
    )
    .map((row) => row.label);
  const treasuryBalance = treasury ? usdBalance(treasury) : undefined;
  const treasuryUsd =
    treasury &&
    currentEvidence(treasury) &&
    finiteAmount(treasury.balance) &&
    finiteAmount(treasuryBalance)
      ? treasuryBalance
      : null;
  const incomePerDay = sumOrNull(income.map(measuredFlow));
  const costValues = costs.map(measuredFlow);
  const burnPerDay = sumOrNull(costValues);
  const totalOverflow = burnPerDay === null && costValues.some(finiteAmount);
  const estimate =
    treasuryUsd !== null && burnPerDay !== null && burnPerDay > 0
      ? treasuryUsd / burnPerDay
      : null;
  const runwayReason: ReportSummary["runwayReason"] =
    treasuryUsd === null
      ? "treasury_unreadable"
      : costCoverageGaps.length
        ? "costs_incomplete"
        : totalOverflow
          ? "estimate_unavailable"
          : burnPerDay === null || burnPerDay === 0
            ? "no_measured_burn"
            : !finiteAmount(estimate)
              ? "estimate_unavailable"
              : null;
  const runwayDays = runwayReason === null ? estimate : null;
  return {
    treasuryUsd,
    incomePerDay,
    incomeCoverageGaps,
    burnPerDay,
    runwayDays,
    runwayReason,
    costCoverageGaps,
    nextDeadline:
      shortest && shortest.runwayDays !== null
        ? { days: shortest.runwayDays, label: shortest.label }
        : null,
    windowDays: options.windowDays ?? 30,
    ratesUsed: [...ratesUsed.values()],
    unconverted,
  };
}
