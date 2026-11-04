// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/tests/snapshot`
 * Purpose: Prove takeSnapshot settles every reader, never throws, and applies the grading floor.
 * Scope: takeSnapshot with in-memory readers; no network.
 * Invariants: READERS_NEVER_THROW, UNREADABLE_IS_UNKNOWN, ONE_ROW_MODEL
 * Side-effects: none
 * Links: src/snapshot.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  baseWalletReader,
  type MoneyPlaneRow,
  openRouterReader,
  type PlaneReader,
  takeSnapshot,
} from "../src/index";

const NOW = new Date("2026-10-24T00:00:00.000Z");
const now = () => NOW;

function row(
  over: Partial<MoneyPlaneRow> & Pick<MoneyPlaneRow, "plane">
): MoneyPlaneRow {
  return {
    label: over.plane,
    kind: "prepaid",
    balance: 100,
    currency: "USD",
    burnPerDay: 1,
    runwayDays: 100,
    grade: "GREEN",
    observedAt: NOW.toISOString(),
    freshness: "current",
    sourceObservedAt: NOW.toISOString(),
    ...over,
  };
}

function reader(plane: string, read: PlaneReader["read"]): PlaneReader {
  return { plane, label: `label ${plane}`, kind: "prepaid", read };
}

describe("takeSnapshot", () => {
  it("returns rows in reader order with the worst grade", async () => {
    const snap = await takeSnapshot(
      [
        reader("a", async () => row({ plane: "a" })),
        reader("b", async () =>
          row({ plane: "b", runwayDays: 3, grade: "RED" })
        ),
      ],
      { timeoutMs: 1000, now }
    );
    expect(snap.rows.map((r) => r.plane)).toEqual(["a", "b"]);
    expect(snap.worst).toBe("RED");
    expect(snap.takenAt).toBe(NOW.toISOString());
  });

  it("turns a throwing reader into an UNKNOWN unreadable row instead of throwing", async () => {
    const snap = await takeSnapshot(
      [
        reader("boom", async () => {
          throw new Error(
            "fetch failed for https://rpc.example/secret-key-123"
          );
        }),
      ],
      { timeoutMs: 1000, now }
    );
    const [r] = snap.rows;
    expect(r?.grade).toBe("UNKNOWN");
    expect(r?.reasonCode).toBe("unreadable");
    expect(r?.label).toBe("label boom");
    expect(r?.balance).toBeNull();
    expect(r?.detail).not.toContain("secret-key-123");
    expect(r?.detail?.length ?? 0).toBeLessThanOrEqual(60);
    expect(snap.worst).toBe("UNKNOWN");
  });

  it("turns a reader that outlives the timeout into UNKNOWN timeout and aborts its signal", async () => {
    let aborted = false;
    const snap = await takeSnapshot(
      [
        reader(
          "slow",
          (signal) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => {
                aborted = true;
              });
              setTimeout(() => resolve(row({ plane: "slow" })), 500);
            })
        ),
        reader("fast", async () => row({ plane: "fast" })),
      ],
      { timeoutMs: 20, now }
    );
    expect(snap.rows[0]?.grade).toBe("UNKNOWN");
    expect(snap.rows[0]?.reasonCode).toBe("timeout");
    expect(snap.rows[1]?.grade).toBe("GREEN");
    expect(aborted).toBe(true);
  });

  it("never lets a prepaid plane with unmeasured burn grade GREEN", async () => {
    const snap = await takeSnapshot(
      [
        reader("p", async () =>
          row({
            plane: "p",
            burnPerDay: null,
            runwayDays: null,
            grade: "GREEN",
          })
        ),
      ],
      { timeoutMs: 1000, now }
    );
    expect(snap.rows[0]?.grade).toBe("UNKNOWN");
    expect(snap.rows[0]?.reasonCode).toBe("burn_unmeasured");
  });

  it("never lets a row carrying a failure reason grade GREEN", async () => {
    for (const reasonCode of [
      "unconfigured",
      "unreadable",
      "timeout",
      "stale",
    ] as const) {
      const snap = await takeSnapshot(
        [
          reader("x", async () =>
            row({ plane: "x", grade: "GREEN", reasonCode })
          ),
        ],
        { timeoutMs: 1000, now }
      );
      expect(snap.rows[0]?.grade).toBe("UNKNOWN");
    }
  });

  it("carries the reader's rail and payAction onto timeout and throw fallback rows", async () => {
    const rail = { kind: "steward-manual" as const, status: "supported" as const };
    const payAction = { kind: "fund-steward" as const };
    const snap = await takeSnapshot(
      [
        { plane: "slow", label: "Slow", kind: "prepaid", rail, payAction, read: () => new Promise<never>(() => {}) },
        {
          plane: "boom",
          label: "Boom",
          kind: "prepaid",
          rail,
          async read() {
            throw new Error("boom");
          },
        },
      ],
      { timeoutMs: 10, now }
    );
    expect(snap.rows[0]).toMatchObject({ grade: "UNKNOWN", reasonCode: "timeout", rail, payAction });
    expect(snap.rows[1]).toMatchObject({ grade: "UNKNOWN", reasonCode: "unreadable", rail });
  });

  it("demotes INFO to UNKNOWN on any plane that is not a wallet", async () => {
    const snap = await takeSnapshot(
      [
        reader("usage", async () =>
          row({ plane: "usage", kind: "usage", grade: "INFO" })
        ),
        reader("w", async () =>
          row({ plane: "w", kind: "wallet", burnPerDay: null, grade: "INFO" })
        ),
      ],
      { timeoutMs: 1000, now }
    );
    expect(snap.rows[0]?.grade).toBe("UNKNOWN");
    expect(snap.rows[1]?.grade).toBe("INFO");
  });

  it("keeps a RED prepaid row RED even when burn is unmeasured", async () => {
    const snap = await takeSnapshot(
      [
        reader("dry", async () =>
          row({
            plane: "dry",
            balance: 0,
            burnPerDay: null,
            runwayDays: 0,
            grade: "RED",
          })
        ),
      ],
      { timeoutMs: 1000, now }
    );
    expect(snap.rows[0]?.grade).toBe("RED");
  });

  it("rejects healthy claims without current dated evidence and preserves exact native facts", async () => {
    for (const evidence of [
      { freshness: "unknown" as const, sourceObservedAt: null },
      { freshness: "stale" as const, sourceObservedAt: NOW.toISOString() },
      { freshness: "current" as const, sourceObservedAt: "invalid" },
    ]) {
      const nativeRate = {
        amount: "0.000000000123456789",
        currency: "AKT",
        per: "block" as const,
      };
      const cumulativeVendorTransfer = {
        amount: "123.456789",
        currency: "AKT",
      };
      const snap = await takeSnapshot(
        [
          reader("fixed", async () =>
            row({
              plane: "fixed",
              kind: "fixed",
              ...evidence,
              nativeRate,
              cumulativeVendorTransfer,
              payer: "Operator",
              coverage: "operator-covered",
            })
          ),
          reader("red", async () =>
            row({ plane: "red", ...evidence, grade: "RED" })
          ),
        ],
        { timeoutMs: 1000, now }
      );
      expect(snap.rows[0]?.grade).toBe("UNKNOWN");
      expect(snap.rows[0]?.nativeRate).toEqual(nativeRate);
      expect(snap.rows[0]?.cumulativeVendorTransfer).toEqual(
        cumulativeVendorTransfer
      );
      expect(snap.rows[1]?.grade).toBe("RED");
    }
  });

  it("does not echo arbitrary thrown secrets or show unreadable holdings as INFO", async () => {
    const snap = await takeSnapshot(
      [
        reader("secret", async () => {
          throw new Error("Authorization: private-token-no-url");
        }),
        reader("wallet", async () =>
          row({ plane: "wallet", kind: "wallet", balance: null, grade: "INFO" })
        ),
      ],
      { timeoutMs: 1000, now }
    );
    expect(snap.rows[0]?.detail).toBe("reader failed");
    expect(snap.rows[1]?.grade).toBe("UNKNOWN");
  });

  it("aborts a wallet's unfinished RPC when its sibling fails before the deadline", async () => {
    let hangingRequestAborted = false;
    const wallet = baseWalletReader({
      name: "partial-failure",
      label: "Wallet",
      address: "0x1111111111111111111111111111111111111111",
      rpcUrl: "https://rpc.example",
      now,
      fetch: async (_url, init) => {
        const request = JSON.parse(init?.body ?? "{}");
        if (request.method === "eth_call") {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              hangingRequestAborted = true;
              reject(new Error("aborted"));
            },
            { once: true }
          );
        });
      },
    });
    const snapshot = await takeSnapshot([wallet], { timeoutMs: 1000, now });
    expect(snapshot.rows[0]?.grade).toBe("UNKNOWN");
    expect(snapshot.rows[0]?.reasonCode).toBe("unreadable");
    expect(hangingRequestAborted).toBe(true);
  });

  it("does not derive runway from invalid burn but keeps independently exhausted credit RED", async () => {
    for (const burnPerDay of [Infinity, -Infinity, NaN, -1]) {
      for (const totalUsage of [10, 100]) {
        const snapshot = await takeSnapshot(
          [
            openRouterReader({
              apiKey: "test-key",
              burnPerDay,
              now,
              fetch: async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                  data: { total_credits: 100, total_usage: totalUsage },
                }),
              }),
            }),
          ],
          { timeoutMs: 1000, now }
        );
        expect(snapshot.rows[0]?.burnPerDay).toBeNull();
        expect(snapshot.rows[0]?.grade).toBe(
          totalUsage === 100 ? "RED" : "UNKNOWN"
        );
        expect(snapshot.rows[0]?.runwayDays).toBe(
          totalUsage === 100 ? 0 : null
        );
      }
    }
  });

  it("normalizes invalid measurements from arbitrary injected readers at the shared boundary", async () => {
    for (const invalid of [NaN, Infinity, -Infinity, -1]) {
      const snapshot = await takeSnapshot(
        [
          reader("prepaid", async () =>
            row({ plane: "prepaid", burnPerDay: invalid })
          ),
          reader("wallet", async () =>
            row({
              plane: "wallet",
              kind: "wallet",
              balance: invalid,
              grade: "INFO",
            })
          ),
          reader("proven-red", async () =>
            row({
              plane: "proven-red",
              balance: 0,
              burnPerDay: invalid,
              runwayDays: 0,
              grade: "RED",
            })
          ),
          reader("red-unknown-forecast", async () =>
            row({
              plane: "red-unknown-forecast",
              burnPerDay: invalid,
              grade: "RED",
            })
          ),
        ],
        { timeoutMs: 1000, now }
      );
      expect(snapshot.rows[0]).toMatchObject({
        grade: "UNKNOWN",
        burnPerDay: null,
        runwayDays: null,
        reasonCode: "burn_unmeasured",
      });
      expect(snapshot.rows[1]).toMatchObject({
        grade: "UNKNOWN",
        balance: null,
        runwayDays: null,
      });
      expect(snapshot.rows[2]).toMatchObject({
        grade: "RED",
        burnPerDay: null,
        runwayDays: 0,
      });
      expect(snapshot.rows[3]).toMatchObject({
        grade: "RED",
        burnPerDay: null,
        runwayDays: null,
      });
    }
    const zero = await takeSnapshot(
      [
        reader("zero", async () =>
          row({
            plane: "zero",
            burnPerDay: 0,
            runwayDays: null,
            grade: "UNKNOWN",
          })
        ),
      ],
      { timeoutMs: 1000, now }
    );
    expect(zero.rows[0]?.burnPerDay).toBe(0);
    const snapshot = await takeSnapshot(
      [
        reader("bad-balance", async () =>
          row({ plane: "bad-balance", balance: NaN })
        ),
        reader("bad-runway", async () =>
          row({ plane: "bad-runway", runwayDays: Infinity })
        ),
      ],
      { timeoutMs: 1000, now }
    );
    expect(
      snapshot.rows.every((r) => r.grade === "UNKNOWN" && r.runwayDays === null)
    ).toBe(true);
    expect(snapshot.rows[0]?.balance).toBeNull();
  });

  it("is UNKNOWN overall when given no readers", async () => {
    const snap = await takeSnapshot([], { timeoutMs: 1000, now });
    expect(snap.rows).toEqual([]);
    expect(snap.worst).toBe("UNKNOWN");
  });
});


it.each([
  ["stale", { freshness: "stale" as const }],
  ["invalid burn", { burnPerDay: Number.NaN }],
  ["unreadable", { reasonCode: "unreadable" as const }],
])("normalizes nested %s children and includes their grade in snapshot worst", async (_label, evidence) => {
  const snap = await takeSnapshot([reader("parent", async () => row({ plane: "parent", children: [row({ plane: "child", children: [row({ plane: "grandchild", ...evidence })] })] }))], { timeoutMs: 1000, now });
  const child = snap.rows[0]?.children?.[0]?.children?.[0];
  expect(child?.grade).toBe("UNKNOWN");
  expect(snap.worst).toBe("UNKNOWN");
  expect(JSON.stringify(snap)).not.toContain('"burnPerDay":null,"runwayDays":100');
});
it("includes a red descendant in snapshot worst without replacing its parent total", async () => {
  const snap = await takeSnapshot([reader("parent", async () => row({ plane: "parent", children: [row({ plane: "empty", grade: "RED", balance: 0, runwayDays: 0 })] }))], { timeoutMs: 1000, now });
  expect(snap.worst).toBe("RED");
  expect(snap.rows[0]?.burnPerDay).toBe(1);
});

it.each(["wallet", "income", "usage", "fixed"] as const)("demotes stale or failed INFO %s descendants", async (kind) => {
  for (const evidence of [{ freshness: "stale" as const }, { reasonCode: "unreadable" as const }, { sourceObservedAt: null }]) {
    const snap = await takeSnapshot([reader("parent", async () => row({ plane: "parent", children: [row({ plane: "child", kind, grade: "INFO", balance: kind === "wallet" ? 5 : null, ...evidence })] }))], { timeoutMs: 1000, now });
    expect(snap.rows[0]?.children?.[0]?.grade).toBe("UNKNOWN");
    expect(snap.worst).toBe("UNKNOWN");
  }
});


it.each([0, 96])("preserves verified zero-burn prepaid INFO with balance %s", async (balance) => {
  const snap = await takeSnapshot([reader("idle", async () => row({ plane: "idle", grade: "INFO", balance, burnPerDay: 0, runwayDays: null, reasonCode: "no_leases" }))], { timeoutMs: 100, now });
  expect(snap.rows[0]).toMatchObject({ grade: "INFO", burnPerDay: 0, runwayDays: null, balance });
  expect(snap.worst).toBe("INFO");
});
it.each([
  { freshness: "stale" as const },
  { sourceObservedAt: null },
  { reasonCode: "unreadable" as const },
  { balance: null },
  { balance: Number.NaN },
  { balance: -1 },
  { burnPerDay: null },
  { burnPerDay: Number.NaN },
  { runwayDays: Infinity },
])("does not preserve idle prepaid INFO without valid evidence: %j", async (evidence) => {
  const snap = await takeSnapshot([reader("idle", async () => row({ plane: "idle", grade: "INFO", balance: 96, burnPerDay: 0, runwayDays: null, reasonCode: "no_leases", ...evidence }))], { timeoutMs: 100, now });
  expect(snap.rows[0]?.grade).toBe("UNKNOWN");
});
