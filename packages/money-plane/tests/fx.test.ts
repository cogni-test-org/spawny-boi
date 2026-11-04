// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";

import { fetchEcbRate, type MoneyPlaneRow, toUsd, usdBalance, usdBurn } from "../src/index";

const NOW = "2026-10-26T13:40:00.000Z";
const eur: MoneyPlaneRow = {
  plane: "cherry:team",
  label: "Cherry credit",
  kind: "prepaid",
  balance: 12.4,
  currency: "EUR",
  burnPerDay: 0.3432,
  runwayDays: 36,
  grade: "GREEN",
  observedAt: NOW,
  sourceObservedAt: NOW,
  freshness: "current",
};
const RATE = { pair: "EURUSD", value: 1.1188, source: "ECB" as const, date: "2026-10-26" };

describe("fetchEcbRate", () => {
  it("reads the frankfurter latest rate for EURUSD and never throws", async () => {
    const urls: string[] = [];
    const rate = await fetchEcbRate(async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ amount: 1, base: "EUR", date: "2026-10-26", rates: { USD: 1.1188 } }),
      };
    });
    expect(urls).toEqual(["https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD"]);
    expect(rate).toEqual(RATE);
    expect(
      await fetchEcbRate(async () => {
        throw new Error("down");
      })
    ).toBeNull();
    expect(
      await fetchEcbRate(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    ).toBeNull();
    expect(await fetchEcbRate(async () => ({ ok: true, status: 200, json: async () => ({}) }))).toBeNull();
    expect(await fetchEcbRate(async () => ({ ok: true, status: 200, json: async () => ({}) }), "EURGBP")).toBeNull();
  });
  it("passes the caller's signal to fetch and resolves null when it aborts instead of hanging", async () => {
    const controller = new AbortController();
    const hanging = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    const pending = fetchEcbRate(hanging, "EURUSD", controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
  });
});

describe("toUsd", () => {
  it("projects EUR balance and burn with the rate, dollars 1:1, and leaves unknown currencies alone", () => {
    const projected = toUsd(eur, [RATE]);
    expect(projected.usd).toEqual({ amount: 12.4 * 1.1188, rate: RATE });
    expect(usdBalance(projected)).toBeCloseTo(13.873, 3);
    expect(usdBurn(projected)).toBeCloseTo(0.384, 3);
    expect(projected.balance).toBe(12.4);
    expect(projected.currency).toBe("EUR");
    const usdc = toUsd({ ...eur, currency: "USDC", balance: 10, burnPerDay: null }, []);
    expect(usdc.usd).toEqual({ amount: 10 });
    expect(usdBurn(usdc)).toBeUndefined();
    const nothing = toUsd(eur, []);
    expect(nothing.usd).toBeUndefined();
    expect(usdBalance(nothing)).toBeUndefined();
    expect(usdBurn(nothing)).toBeUndefined();
    expect(toUsd({ ...eur, currency: "uact", balance: null }, [RATE]).usd).toBeUndefined();
  });
  it("projects children one level down", () => {
    const parent = toUsd(
      { ...eur, currency: "USD", children: [{ ...eur, plane: "child" }] },
      [RATE]
    );
    expect(parent.children?.[0]?.usd?.rate).toEqual(RATE);
  });
});
