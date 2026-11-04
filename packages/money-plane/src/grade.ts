// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/grade`
 * Purpose: Money-plane policy thresholds and the pure functions that turn a measurement into a Grade.
 * Scope: Pure functions and constants. Does not read any plane or decide alerts (alerting stays in the consuming node).
 * Invariants: UNREADABLE_IS_UNKNOWN — null, NaN or negative input grades UNKNOWN, never GREEN. ESCROW_ADVISORY_UNTIL_CALIBRATED — ESCROW_CALIBRATED stays false until real history sets thresholds.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/money-plane-snapshot-design, https://cognidao.org/knowledge/finances-expert
 * @public
 */

import type { Grade } from "./types";

export interface Thresholds {
  readonly yellow: number;
  readonly red: number;
}

/** Runway policy: warn under 21 days, page under 7 (finances-expert). */
export const RUNWAY_DAYS: Thresholds = Object.freeze({ yellow: 21, red: 7 });
/** @deprecated Historical advisory values; consumers must explicitly choose an approved policy. */
export const SPEND_USD_PER_MONTH: Thresholds = Object.freeze({
  yellow: 100,
  red: 300,
});
/** Expiry policy (e.g. domain renewal) in days left. */
export const EXPIRY_DAYS: Thresholds = Object.freeze({ yellow: 45, red: 14 });
/** Thinnest per-deployment escrow, in days. Advisory until ESCROW_CALIBRATED. */
export const ESCROW_DAYS: Thresholds = Object.freeze({
  yellow: 0.75,
  red: 0.25,
});
/** While false, an escrow breach grades at most YELLOW with reasonCode `escrow_advisory`. */
export const ESCROW_CALIBRATED = false;

function measurable(value: number | null | undefined): value is number {
  return typeof value === "number" && !Number.isNaN(value) && value >= 0;
}

/** Days remaining, lower is worse. Infinity (a measured zero burn) is GREEN. */
export function gradeRunway(
  runwayDays: number | null | undefined,
  thresholds: Thresholds = RUNWAY_DAYS
): Grade {
  if (!measurable(runwayDays)) return "UNKNOWN";
  if (runwayDays < thresholds.red) return "RED";
  if (runwayDays < thresholds.yellow) return "YELLOW";
  return "GREEN";
}

/** Spend rate, higher is worse. */
export function gradeSpend(
  usdPerMonth: number | null | undefined,
  thresholds?: Thresholds
): Grade {
  if (
    thresholds === undefined ||
    !measurable(usdPerMonth) ||
    !Number.isFinite(usdPerMonth)
  )
    return "UNKNOWN";
  if (usdPerMonth >= thresholds.red) return "RED";
  if (usdPerMonth >= thresholds.yellow) return "YELLOW";
  return "GREEN";
}

/** Days until expiry, lower is worse. */
export function gradeExpiry(
  daysLeft: number | null | undefined,
  thresholds: Thresholds = EXPIRY_DAYS
): Grade {
  return gradeRunway(daysLeft, thresholds);
}

const SEVERITY: Record<Grade, number> = {
  INFO: 0,
  GREEN: 1,
  YELLOW: 2,
  UNKNOWN: 3,
  RED: 4,
};

/** RED > UNKNOWN > YELLOW > GREEN > INFO. An empty set is UNKNOWN: nothing measured is not GREEN. */
export function worstGrade(grades: readonly Grade[]): Grade {
  if (grades.length === 0) return "UNKNOWN";
  return grades.reduce((worst, g) =>
    SEVERITY[g] > SEVERITY[worst] ? g : worst
  );
}
