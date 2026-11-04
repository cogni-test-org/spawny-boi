// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/tests/readers`
 * Purpose: Prove the OpenRouter and Base wallet readers parse vendor responses, grade honestly, and never throw.
 * Scope: Readers driven by a fake injected fetch; no network.
 * Invariants: READERS_NEVER_THROW, UNREADABLE_IS_UNKNOWN, PACKAGE_LEAF_NO_ENV
 * Side-effects: none
 * Links: src/readers/openrouter.ts, src/readers/base-wallet.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  BASE_USDC_ADDRESS,
  baseWalletReader,
  type FetchLike,
  openRouterReader,
  takeSnapshot,
} from "../src/index";

const NOW = new Date("2026-10-24T00:00:00.000Z");
const now = () => NOW;
const signal = new AbortController().signal;

type Call = { url: string; init?: Parameters<FetchLike>[1] };

function fakeFetch(
  handler: (call: Call) => { status?: number; body: unknown }
): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = init === undefined ? { url } : { url, init };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { fetch, calls };
}

describe("openRouterReader", () => {
  const credits = (total_credits: number, total_usage: number) => ({
    body: { data: { total_credits, total_usage } },
  });

  it("reads balance = credits - usage and reports burn as unmeasured", async () => {
    const { fetch, calls } = fakeFetch(() => credits(50, 41.26));
    const r = await openRouterReader({ apiKey: "sk-or-test", fetch, now }).read(
      signal
    );
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/credits");
    expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer sk-or-test");
    expect(r.plane).toBe("openrouter:account");
    expect(r.kind).toBe("prepaid");
    expect(r.balance).toBeCloseTo(8.74, 6);
    expect(r.currency).toBe("USD");
    expect(r.usageTotal).toBe(41.26);
    expect(r.burnPerDay).toBeNull();
    expect(r.runwayDays).toBeNull();
    expect(r.grade).toBe("UNKNOWN");
    expect(r.reasonCode).toBe("burn_unmeasured");
    expect(r.observedAt).toBe(NOW.toISOString());
  });

  it("grades runway when the consumer supplies a measured burn", async () => {
    const { fetch } = fakeFetch(() => credits(100, 70));
    const r = await openRouterReader({
      apiKey: "k",
      fetch,
      now,
      burnPerDay: 2,
    }).read(signal);
    expect(r.burnPerDay).toBe(2);
    expect(r.runwayDays).toBe(15);
    expect(r.grade).toBe("YELLOW");
    expect(r.reasonCode).toBeUndefined();
  });

  it("is RED when the balance is exhausted, even with burn unmeasured", async () => {
    const { fetch } = fakeFetch(() => credits(10, 10.5));
    const r = await openRouterReader({ apiKey: "k", fetch, now }).read(signal);
    expect(r.grade).toBe("RED");
    expect(r.runwayDays).toBe(0);
  });

  it("is UNKNOWN unconfigured with no key and makes no request", async () => {
    const { fetch, calls } = fakeFetch(() => credits(1, 0));
    const r = await openRouterReader({ apiKey: undefined, fetch, now }).read(
      signal
    );
    expect(calls).toHaveLength(0);
    expect(r.grade).toBe("UNKNOWN");
    expect(r.reasonCode).toBe("unconfigured");
    expect(r.balance).toBeNull();
  });

  it("is UNKNOWN unreadable on an HTTP error or a malformed body, without throwing", async () => {
    const http = await openRouterReader({
      apiKey: "k",
      fetch: fakeFetch(() => ({ status: 401, body: {} })).fetch,
      now,
    }).read(signal);
    expect(http.grade).toBe("UNKNOWN");
    expect(http.reasonCode).toBe("unreadable");
    expect(http.detail).toBe("HTTP 401");

    const malformed = await openRouterReader({
      apiKey: "k",
      fetch: fakeFetch(() => ({ body: { data: {} } })).fetch,
      now,
    }).read(signal);
    expect(malformed.reasonCode).toBe("unreadable");

    const rejected = await openRouterReader({
      apiKey: "k",
      fetch: async () => {
        throw new Error("network down");
      },
      now,
    }).read(signal);
    expect(rejected.reasonCode).toBe("unreadable");
  });
});

describe("baseWalletReader", () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const RPC = "https://rpc.example/key-abc";

  function rpc(usdcRaw: bigint, wei: bigint) {
    return fakeFetch(({ init }) => {
      const req = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      const result =
        req.method === "eth_call"
          ? `0x${usdcRaw.toString(16)}`
          : `0x${wei.toString(16)}`;
      return { body: { jsonrpc: "2.0", id: req.id, result } };
    });
  }

  it("reads USDC via balanceOf and ETH via eth_getBalance and grades INFO", async () => {
    const { fetch, calls } = rpc(7_070_000n, 1_500_000_000_000_000_000n);
    const r = await baseWalletReader({
      name: "steward-wallet",
      label: "Steward wallet",
      address: ADDRESS,
      rpcUrl: RPC,
      fetch,
      now,
      payAction: { kind: "fund-steward" },
    }).read(signal);

    const bodies = calls.map((c) => JSON.parse(String(c.init?.body)));
    const call = bodies.find((b) => b.method === "eth_call");
    expect(call.params[0].to).toBe(BASE_USDC_ADDRESS);
    expect(call.params[0].data).toBe(
      `0x70a08231${"1".repeat(40).padStart(64, "0")}`
    );
    expect(
      bodies.some(
        (b) => b.method === "eth_getBalance" && b.params[0] === ADDRESS
      )
    ).toBe(true);
    expect(calls.every((c) => c.url === RPC && c.init?.method === "POST")).toBe(
      true
    );

    expect(r.plane).toBe("base:steward-wallet");
    expect(r.kind).toBe("wallet");
    expect(r.balance).toBeCloseTo(7.07, 6);
    expect(r.currency).toBe("USDC");
    expect(r.burnPerDay).toBeNull();
    expect(r.runwayDays).toBeNull();
    expect(r.grade).toBe("INFO");
    expect(r.detail).toBe("1.5 ETH");
    expect(r.payAction).toEqual({ kind: "fund-steward" });
    expect(r.wallet).toEqual({ address: ADDRESS, network: "Base", explorerUrl: `https://basescan.org/address/${ADDRESS}` });
  });

  it("retains exact native USDC and ETH evidence beyond floating-point precision", async () => {
    const { fetch } = rpc(9999999999999999n, 9007199254740993123456789n);
    const r = await baseWalletReader({ name: "large", label: "Large wallet", address: ADDRESS, rpcUrl: RPC, fetch, now }).read(signal);
    expect(r.parts).toEqual([
      { label: "USDC · exact", amount: "9999999999.999999", currency: "USDC" },
      { label: "Gas · exact", amount: "9007199.254740993123456789", currency: "ETH" },
    ]);
  });

  it("is UNKNOWN unconfigured with no address and keeps its payAction", async () => {
    const { fetch, calls } = rpc(0n, 0n);
    const r = await baseWalletReader({
      name: "steward-wallet",
      label: "Steward wallet",
      address: undefined,
      rpcUrl: RPC,
      fetch,
      now,
      payAction: { kind: "fund-steward" },
    }).read(signal);
    expect(calls).toHaveLength(0);
    expect(r.grade).toBe("UNKNOWN");
    expect(r.reasonCode).toBe("unconfigured");
    expect(r.payAction).toEqual({ kind: "fund-steward" });
  });

  it("is UNKNOWN unreadable when eth_call returns an empty 0x result, not a zero balance", async () => {
    const { fetch } = fakeFetch(({ init }) => {
      const req = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      const result = req.method === "eth_call" ? "0x" : "0x1";
      return { body: { jsonrpc: "2.0", id: req.id, result } };
    });
    const r = await baseWalletReader({
      name: "operator-wallet",
      label: "Operator wallet",
      address: ADDRESS,
      rpcUrl: RPC,
      fetch,
      now,
    }).read(signal);
    expect(r.grade).toBe("UNKNOWN");
    expect(r.reasonCode).toBe("unreadable");
    expect(r.balance).toBeNull();
    expect(r.detail).toBe("eth_call returned empty");
  });

  it("is UNKNOWN unreadable on a JSON-RPC error and never leaks the RPC URL", async () => {
    const { fetch } = fakeFetch(() => ({
      body: {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: `bad ${RPC}` },
      },
    }));
    const r = await baseWalletReader({
      name: "dao-treasury",
      label: "DAO treasury",
      address: ADDRESS,
      rpcUrl: RPC,
      fetch,
      now,
    }).read(signal);
    expect(r.grade).toBe("UNKNOWN");
    expect(r.reasonCode).toBe("unreadable");
    expect(r.detail ?? "").not.toContain("key-abc");
    expect(r.wallet?.address).toBe(ADDRESS);
    expect(JSON.stringify(r)).not.toContain(RPC);
  });
  it.each([undefined, "", "not-a-wallet", "https://rpc.example/key-abc"])("omits wallet identity for invalid input %s", async (address) => {
    const { fetch, calls } = rpc(0n, 0n);
    const reader = baseWalletReader({ name: "invalid", label: "Wallet", address, rpcUrl: RPC, fetch, now });
    const row = await reader.read(signal);
    expect(reader.wallet).toBeUndefined();
    expect(row.wallet).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it.each(["timeout", "throw"])("keeps configured identity on snapshot %s without inventing a balance", async (failure) => {
    const reader = baseWalletReader({ name: "steward", label: "Steward wallet", address: ADDRESS, rpcUrl: RPC, fetch: async () => new Promise(() => {}), now });
    const result = await takeSnapshot([failure === "throw" ? { ...reader, read: async () => { throw new Error(RPC); } } : reader], { timeoutMs: 1, now });
    expect(result.rows[0]).toMatchObject({ balance: null, grade: "UNKNOWN", wallet: { address: ADDRESS, network: "Base", explorerUrl: `https://basescan.org/address/${ADDRESS}` } });
    expect(result.rows[0]?.reasonCode).toBe(failure === "throw" ? "unreadable" : "timeout");
    expect(JSON.stringify(result)).not.toContain(RPC);
  });

});
