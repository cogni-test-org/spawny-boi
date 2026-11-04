// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/fx`
 * Purpose: The one FX seam: fetch an ECB daily reference rate (keyless, frankfurter.dev) and project a row into USD.
 * Scope: Pure helpers plus one injected-fetch read. Does not sum, grade, or render.
 * Invariants: USD_IS_DERIVED — native fields stay exact; `usd` is a projection. USD and USDC are 1:1 by convention.
 *   An unknown currency gets no `usd`. `fetchEcbRate` never throws: null when unreadable.
 * Side-effects: IO (HTTPS GET via injected fetch) in fetchEcbRate only
 * Links: https://frankfurter.dev, https://cognidao.org/knowledge/finances-expert
 * @public
 */

import type { FetchLike, MoneyPlaneRow, UsdRate } from "./types";

export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";
const DOLLAR = new Set(["USD", "USDC"]);

/** ECB reference rate for `pair` (default EURUSD) as published by frankfurter.dev; null on any failure. */
export async function fetchEcbRate(
  fetch: FetchLike,
  pair = "EURUSD",
  signal?: AbortSignal
): Promise<UsdRate | null> {
  const base = pair.slice(0, 3);
  const quote = pair.slice(3);
  if (pair.length !== 6 || quote !== "USD") return null;
  try {
    const res = await fetch(
      `${FRANKFURTER_URL}?base=${base}&symbols=${quote}`,
      signal ? { signal } : {}
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      date?: unknown;
      rates?: Record<string, unknown>;
    } | null;
    const value = Number(body?.rates?.[quote]);
    const date = String(body?.date ?? "");
    if (!Number.isFinite(value) || value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return null;
    return { pair, value, source: "ECB", date };
  } catch {
    return null;
  }
}

/** The rate that converts `currency` to USD, or undefined when none applies. */
export function rateFor(
  currency: string | null,
  rates: readonly UsdRate[]
): UsdRate | undefined {
  if (!currency || DOLLAR.has(currency)) return undefined;
  return rates.find((rate) => rate.pair === `${currency}USD`);
}

/** Project one row (and its children) into USD. Dollar rows get `usd` with no rate; others need a matching rate. */
export function toUsd(
  row: MoneyPlaneRow,
  rates: readonly UsdRate[]
): MoneyPlaneRow {
  const children = row.children?.map((child) => toUsd(child, rates));
  const withChildren = children ? { ...row, children } : { ...row };
  if (!row.currency) return withChildren;
  if (DOLLAR.has(row.currency)) {
    return { ...withChildren, usd: { amount: row.balance ?? 0 } };
  }
  const rate = rateFor(row.currency, rates);
  if (!rate) return withChildren;
  return {
    ...withChildren,
    usd: { amount: (row.balance ?? 0) * rate.value, rate },
  };
}

/** Balance in USD, or undefined when the row has no balance or no USD projection. */
export function usdBalance(row: MoneyPlaneRow): number | undefined {
  return row.usd && row.balance !== null && Number.isFinite(row.usd.amount)
    ? row.usd.amount
    : undefined;
}

/** Burn (or income) per day in USD, or undefined when unmeasured or not projectable. */
export function usdBurn(row: MoneyPlaneRow): number | undefined {
  if (row.burnPerDay === null || !Number.isFinite(row.burnPerDay) || row.burnPerDay < 0 || !row.currency) return undefined;
  if (DOLLAR.has(row.currency)) return row.burnPerDay;
  const rate = row.usd?.rate;
  if (!rate || rate.pair !== `${row.currency}USD` || !Number.isFinite(rate.value) || rate.value <= 0) return undefined;
  const value = row.burnPerDay * rate.value;
  return Number.isFinite(value) ? value : undefined;
}
