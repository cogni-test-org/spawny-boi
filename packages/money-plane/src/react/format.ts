// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/react/format`
 * Purpose: Pure label helpers for the shared FinanceReport: USD money, burn, runway, grouping, risk order, rail labels, human reasons.
 * Scope: No React, no IO. Columns read the USD projection; dialogs read exact native fields.
 * Invariants: A tiny positive burn never displays as zero; unknown is a dash; raw reason codes never reach the UI.
 * Side-effects: none
 * Links: ../fx.ts, ../report.ts
 * @internal
 */

import { usdBalance, usdBurn } from "../fx";
import type { Grade, MoneyPlaneRow, Rail } from "../types";

export const DASH = "—";
export type Group = "Income" | "Costs" | "Reserves";
export const GROUPS: readonly Group[] = ["Income", "Costs", "Reserves"];

export function groupOf(row: MoneyPlaneRow): Group {
  if (row.kind === "income") return "Income";
  if (row.kind === "wallet") return "Reserves";
  return "Costs";
}

function hasData(row: MoneyPlaneRow): boolean {
  return (
    row.balance !== null ||
    row.burnPerDay !== null ||
    row.runwayDays !== null ||
    Boolean(row.children?.some(hasData))
  );
}

/** RED, YELLOW first; then measured rows (GREEN, INFO, unmeasured-runway); unread placeholders last. */
export function riskRank(row: MoneyPlaneRow): number {
  const byGrade: Record<Grade, number> = {
    RED: 0,
    YELLOW: 1,
    GREEN: 2,
    INFO: 3,
    UNKNOWN: 4,
  };
  if (row.grade === "RED" || row.grade === "YELLOW") return byGrade[row.grade];
  return hasData(row) ? byGrade[row.grade] : 5;
}

export function byRisk(a: MoneyPlaneRow, b: MoneyPlaneRow): number {
  return riskRank(a) - riskRank(b) || a.label.localeCompare(b.label);
}

export function usd(amount: number, digits = 2): string {
  const text = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
  return `${amount < 0 ? "−" : ""}$${text}`;
}

/** "$74.52" or "—". */
export function balanceLabel(row: MoneyPlaneRow): string {
  const value = usdBalance(row);
  return value === undefined ? DASH : usd(value);
}

/** "$0.19/day", "<$0.01/day" or "—". */
export function burnLabel(row: MoneyPlaneRow): string {
  return dailyUsd(usdBurn(row));
}

/** Shared summary/row formatter: small positive flows never look like zero. */
export function dailyUsd(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return DASH;
  if (value > 0 && value < 0.005) return "<$0.01/day";
  return `${usd(value)}/day`;
}

export function runway(row: MoneyPlaneRow): number | undefined {
  return (row.grade === "RED" ||
    row.grade === "YELLOW" ||
    row.grade === "GREEN") &&
    row.runwayDays !== null &&
    Number.isFinite(row.runwayDays) &&
    row.runwayDays >= 0
    ? row.runwayDays
    : undefined;
}

/** "12d", "<1d" or "—". */
export function runwayLabel(row: MoneyPlaneRow): string {
  const days = runway(row);
  if (days === undefined) return DASH;
  return days < 1 ? "<1d" : `${Math.floor(days)}d`;
}

export function runwayClass(grade: Grade): string {
  return grade === "RED"
    ? "text-destructive"
    : grade === "YELLOW"
      ? "text-warning"
      : grade === "GREEN"
        ? "text-success"
        : "text-muted-foreground";
}

/** Exact native text, with uact scaled to USD credit for humans: "4.21 USD credit (4,210,000 uact)". */
export function nativeLabel(amount: string, currency: string): string {
  const value = Number(amount);
  if (currency === "uact" && Number.isFinite(value)) {
    return `${(value / 1e6).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} USD credit (${amount} uact)`;
  }
  return `${amount} ${currency}`;
}

/** The greyed Action label for a rail that has no live control. */
export function railLabel(rail: Rail): string {
  switch (rail.kind) {
    case "card-manual":
      return `Card · ${rail.guide ?? "manual"}`;
    case "dao-vote":
      return "DAO vote";
    case "split-inflow":
      return "Split · auto";
    case "x402-auto":
      return "x402 · auto";
    case "steward-manual":
      return "Steward wallet";
    default:
      return "No rail";
  }
}

/** One dialog line: how this line gets paid and whether that works today. */
export function railSentence(rail: Rail): string {
  const how: Record<Rail["kind"], string> = {
    "steward-manual": "paid from the steward wallet by a human",
    "card-manual": "paid by card, not from the steward wallet",
    "dao-vote": "moves only by DAO vote",
    "split-inflow": "arrives automatically through the Split",
    "x402-auto": "automatic USDC service payments",
    none: "no payment rail recorded",
  };
  return `${how[rail.kind]} · ${rail.status}`;
}

/** One human line explaining why a cell is unavailable; undefined when the row is fully measured. */
export function unavailableReason(row: MoneyPlaneRow): string | undefined {
  switch (row.reasonCode) {
    case "unconfigured":
      return (
        row.detail ??
        (row.kind === "wallet" ? "no address configured" : "no key configured")
      );
    case "unreadable":
      return row.kind === "wallet" ? "RPC unavailable" : "provider unreadable";
    case "timeout":
      return "provider did not answer in time";
    case "stale":
      return "source data is stale";
    case "burn_unmeasured":
      return "burn not measured";
    case "lease_starved":
      return "lease escrow exhausted";
    case "no_leases":
      return "no active lease";
    case "escrow_advisory":
      return "escrow running low";
    default:
      return row.grade === "UNKNOWN" ? "not measured" : undefined;
  }
}

/** Basis and cadence of the row's numbers, ≤ 4 words. */
export function basisLabel(row: MoneyPlaneRow): string | undefined {
  const divided = runway(row) !== undefined && row.burnPerDay !== null;
  if (row.nativeRate)
    return `contract rate / ${row.nativeRate.per}${divided ? " · balance ÷ burn" : ""}`;
  if (divided) return "balance ÷ burn";
  if (row.kind === "expiry" && runway(row) !== undefined)
    return "days to expiry";
  if (row.kind === "income" && row.burnPerDay !== null) return "inflow / day";
  if (row.burnPerDay !== null) return "measured / day";
  if (row.balance !== null) return "balance read";
  return undefined;
}

/** "Oct 26, 2026, 1:40 PM EDT" in the given zone, or undefined for an unparseable time. */
export function observedLabel(
  value: string | null | undefined,
  timeZone?: string
): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/** "6:40 AM" when from today in the viewer's zone, else "Oct 25, 6:40 AM". */
export function refreshedLabel(
  value: string,
  timeZone?: string,
  now: Date = new Date()
): string {
  if (!Number.isFinite(Date.parse(value))) return DASH;
  const zone = timeZone ? { timeZone } : {};
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(d);
  const at = new Date(value);
  const time = new Intl.DateTimeFormat("en-US", {
    ...zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  if (day(at) === day(now)) return time;
  const date = new Intl.DateTimeFormat("en-US", {
    ...zone,
    month: "short",
    day: "numeric",
  }).format(at);
  return `${date}, ${time}`;
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
