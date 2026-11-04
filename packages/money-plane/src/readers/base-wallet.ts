// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/readers/base-wallet`
 * Purpose: Read a Base wallet's USDC (ERC-20 balanceOf) and ETH gas balance as an INFO money-plane row.
 * Scope: Two keyless JSON-RPC calls (eth_call, eth_getBalance) through an injected fetch. Does not sign, move funds, or depend on viem.
 * Invariants: READERS_NEVER_THROW. UNREADABLE_IS_UNKNOWN — no address ⇒ `unconfigured`, RPC failure ⇒ `unreadable`. Wallets grade INFO (holdings, no runway). The RPC URL and address never appear in `detail`. PACKAGE_LEAF_NO_ENV.
 * Side-effects: IO (JSON-RPC POST via injected fetch)
 * Links: https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

import { unknownRow } from "../row";
import type {
  FetchLike,
  MoneyPlaneRow,
  PayAction,
  PlaneReader,
  WalletIdentity,
} from "../types";

/** Native USDC on Base mainnet (6 decimals). */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Public keyless Base mainnet RPC, for consumers with no RPC of their own. */
export const BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";

const BALANCE_OF_SELECTOR = "0x70a08231";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface BaseWalletReaderOptions {
  /** Plane id suffix: the row's plane is `base:<name>`. */
  name: string;
  label: string;
  address: string | null | undefined;
  rpcUrl: string;
  fetch: FetchLike;
  usdcAddress?: string;
  payAction?: PayAction;
  now?: () => Date;
}

class RpcError extends Error {}

/** Format unsigned RPC quantities without rounding their exact source evidence. */
function exactUnits(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}
function toUnits(raw: bigint, decimals: number): number {
  return Number(exactUnits(raw, decimals));
}

function formatEth(eth: number): string {
  return `${Number(eth.toPrecision(4))} ETH`;
}

export function baseWalletReader(
  options: BaseWalletReaderOptions
): PlaneReader {
  const plane = `base:${options.name}`;
  const now = options.now ?? (() => new Date());
  const usdc = options.usdcAddress ?? BASE_USDC_ADDRESS;
  const address = options.address;
  const wallet: WalletIdentity | undefined =
    address && ADDRESS_PATTERN.test(address)
      ? {
          address,
          network: "Base",
          explorerUrl: `https://basescan.org/address/${address}`,
        }
      : undefined;
  const withWallet = wallet === undefined ? {} : { wallet };
  const withAction =
    options.payAction === undefined ? {} : { payAction: options.payAction };
  const unknown = (reasonCode: "unconfigured" | "unreadable", detail: string) => ({
    ...unknownRow({
      plane,
      label: options.label,
      kind: "wallet",
      reasonCode,
      observedAt: now().toISOString(),
      detail,
      ...withAction,
    }),
    ...withWallet,
  });

  async function rpc(
    id: number,
    method: string,
    params: unknown[],
    signal: AbortSignal
  ): Promise<bigint> {
    const res = await options.fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    if (!res.ok) throw new RpcError(`${method} HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code?: unknown };
    } | null;
    if (body?.error)
      throw new RpcError(
        `${method} rpc error${typeof body.error.code === "number" ? ` ${body.error.code}` : ""}`
      );
    if (typeof body?.result !== "string" || !body.result.startsWith("0x")) {
      throw new RpcError(`${method} returned no result`);
    }
    // "0x" is an empty return (e.g. no contract at `usdcAddress` on this chain),
    // not a zero balance — reading it as 0 would show a false empty wallet.
    if (body.result === "0x") throw new RpcError(`${method} returned empty`);
    return BigInt(body.result);
  }

  return {
    plane,
    label: options.label,
    kind: "wallet",
    ...withAction,
    ...withWallet,
    async read(signal): Promise<MoneyPlaneRow> {
      if (!address) return unknown("unconfigured", "no address in repo-spec");
      if (!ADDRESS_PATTERN.test(address))
        return unknown("unconfigured", "address is not 0x + 40 hex");
      try {
        const data = `${BALANCE_OF_SELECTOR}${address.slice(2).toLowerCase().padStart(64, "0")}`;
        const [usdcRaw, wei] = await Promise.all([
          rpc(1, "eth_call", [{ to: usdc, data }, "latest"], signal),
          rpc(2, "eth_getBalance", [address, "latest"], signal),
        ]);
        const observedAt = now().toISOString();
        return {
          plane,
          label: options.label,
          kind: "wallet",
          balance: toUnits(usdcRaw, 6),
          currency: "USDC",
          burnPerDay: null,
          runwayDays: null,
          grade: "INFO",
          observedAt,
          source: "Base JSON-RPC",
          sourceObservedAt: observedAt,
          freshness: "current",
          detail: formatEth(toUnits(wei, 18)),
          parts: [
            { label: "USDC · exact", amount: exactUnits(usdcRaw, 6), currency: "USDC" },
            { label: "Gas · exact", amount: exactUnits(wei, 18), currency: "ETH" },
          ],
          ...withAction,
          ...withWallet,
        };
      } catch (error) {
        // Only our own RpcError text is trusted verbatim; anything else may echo the RPC URL.
        const detail =
          error instanceof RpcError ? error.message : "wallet read failed";
        return unknown("unreadable", detail);
      }
    },
  };
}
