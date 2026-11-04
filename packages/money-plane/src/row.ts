// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/row`
 * Purpose: Row helpers shared by readers and the snapshot runner: the UNKNOWN row, the grading floor, and safe detail text.
 * Scope: Pure functions. Does not perform IO.
 * Invariants: UNREADABLE_IS_UNKNOWN — `applyGradingFloor` demotes any GREEN/YELLOW row that carries a failure reason, any prepaid row with unmeasured burn, and any INFO row that is not a holding (wallet), an income flow, or a cost line with a measured rate and no balance, to UNKNOWN. Detail text never carries a URL and is ≤60 chars.
 * Side-effects: none
 * Links: src/snapshot.ts, src/readers/
 * @public
 */

import type { MoneyPlaneRow, PayAction, PlaneKind, ReasonCode } from "./types";

const DETAIL_MAX = 60;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const FAILURE_REASONS: ReadonlySet<ReasonCode> = new Set([
  "unconfigured",
  "unreadable",
  "timeout",
  "stale",
  "burn_unmeasured",
]);

/** Strip URLs (they may embed keys) and clamp to the row's detail budget. */
export function safeDetail(text: string): string {
  const clean = text.replace(URL_PATTERN, "<url>").replace(/\s+/g, " ").trim();
  return clean.length <= DETAIL_MAX
    ? clean
    : `${clean.slice(0, DETAIL_MAX - 1)}…`;
}

export interface UnknownRowInput {
  plane: string;
  label: string;
  kind: PlaneKind;
  reasonCode: ReasonCode;
  observedAt: string;
  detail?: string;
  payAction?: PayAction;
}

export function unknownRow(input: UnknownRowInput): MoneyPlaneRow {
  return {
    plane: input.plane,
    label: input.label,
    kind: input.kind,
    balance: null,
    currency: null,
    burnPerDay: null,
    runwayDays: null,
    grade: "UNKNOWN",
    freshness: "unknown",
    sourceObservedAt: null,
    observedAt: input.observedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: safeDetail(input.detail) }),
    ...(input.payAction === undefined ? {} : { payAction: input.payAction }),
  };
}

/** A reader can over-grade; this floor makes an unmeasured plane UNKNOWN regardless of what it claimed. */
export function applyGradingFloor(input: MoneyPlaneRow): MoneyPlaneRow {
  const invalidBalance =
    input.balance !== null &&
    (!Number.isFinite(input.balance) ||
      (input.kind === "wallet" && input.balance < 0));
  const invalidBurn =
    input.burnPerDay !== null &&
    (!Number.isFinite(input.burnPerDay) || input.burnPerDay < 0);
  const invalidRunway =
    input.runwayDays !== null &&
    (!Number.isFinite(input.runwayDays) || input.runwayDays < 0);
  const missingPrepaidBurn =
    input.kind === "prepaid" && (input.burnPerDay === null || invalidBurn);
  const missingPrepaidBalance =
    input.kind === "prepaid" && (input.balance === null || invalidBalance);
  const exhausted =
    input.kind === "prepaid" &&
    input.grade === "RED" &&
    input.balance !== null &&
    Number.isFinite(input.balance) &&
    input.balance <= 0;
  const invalidForecast =
    invalidBalance ||
    invalidBurn ||
    invalidRunway ||
    missingPrepaidBurn ||
    missingPrepaidBalance;
  const row: MoneyPlaneRow = {
    ...input,
    ...(input.children ? { children: input.children.map(applyGradingFloor) } : {}),
    balance: invalidBalance ? null : input.balance,
    burnPerDay: invalidBurn ? null : input.burnPerDay,
    ...(invalidBurn ? { reasonCode: "burn_unmeasured" as const } : {}),
    runwayDays:
      input.kind === "wallet"
        ? null
        : invalidForecast
          ? exhausted
            ? 0
            : null
          : input.runwayDays,
  };
  // Normalize first even for proven RED; bad auxiliary data must not survive serialization.
  if (invalidForecast && (row.grade === "GREEN" || row.grade === "YELLOW")) {
    return {
      ...row,
      grade: "UNKNOWN",
      reasonCode:
        missingPrepaidBurn || invalidBurn ? "burn_unmeasured" : "unreadable",
    };
  }

  // INFO means "no runway semantics": a holding (wallet), an income flow, or a cost
  // line whose rate is measured and which has no balance to divide, or verified idle
  // prepaid credit with zero burn. Anywhere else it
  // would hide an ungraded plane from worstGrade.
  if (row.grade === "INFO") {
    const holding = row.kind === "wallet" && row.balance !== null;
    const flow =
      (row.kind === "income" ||
        row.kind === "usage" ||
        row.kind === "fixed") &&
      row.balance === null &&
      row.burnPerDay !== null;
    const idlePrepaid = row.kind === "prepaid" && !invalidForecast &&
      row.balance !== null && row.balance >= 0 && row.burnPerDay === 0 &&
      row.runwayDays === null;
    if (!holding && !flow && !idlePrepaid) return { ...row, grade: "UNKNOWN" };
  }
  if (row.grade !== "GREEN" && row.grade !== "YELLOW" && row.grade !== "INFO") return row;
  if (row.freshness === "stale") {
    return { ...row, grade: "UNKNOWN", reasonCode: "stale" };
  }
  if (
    row.freshness !== "current" ||
    !row.sourceObservedAt ||
    !Number.isFinite(Date.parse(row.sourceObservedAt))
  ) {
    return { ...row, grade: "UNKNOWN", freshness: "unknown" };
  }
  if (row.reasonCode !== undefined && FAILURE_REASONS.has(row.reasonCode)) {
    return { ...row, grade: "UNKNOWN" };
  }
  if (row.kind === "prepaid" && row.burnPerDay === null) {
    return { ...row, grade: "UNKNOWN", reasonCode: "burn_unmeasured" };
  }
  return row;
}
