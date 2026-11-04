// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/types`
 * Purpose: The one row model every money-plane reader returns and every node renders, plus the reader port.
 * Scope: Types only. Does not read, grade, or render anything.
 * Invariants: ONE_ROW_MODEL — a per-row Pay button is added by setting `payAction`, never by reshaping the row; how a line gets paid is a `rail` value. PACKAGE_LEAF_NO_ENV — fetch is injected through FetchLike. USD_IS_DERIVED — `usd` is a normalized projection for columns and sums; native amounts stay exact.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

/** UNKNOWN = could not be measured (never GREEN). INFO = holdings with no runway semantics (wallets). */
export type Grade = "GREEN" | "YELLOW" | "RED" | "UNKNOWN" | "INFO";

/** income: money in · prepaid: balance ÷ burn = runway · usage: billed after the fact · fixed: declared fee · expiry: dated · wallet: holdings. */
export type PlaneKind =
  | "income"
  | "prepaid"
  | "usage"
  | "fixed"
  | "expiry"
  | "wallet";

/** A daily reference rate used to project a native currency into USD. */
export interface UsdRate {
  /** e.g. "EURUSD": one unit of the first currency in USD. */
  pair: string;
  value: number;
  source: "ECB";
  /** Reference date of the rate, YYYY-MM-DD. */
  date: string;
}

/** Normalized USD view of a row: `amount` is the balance in USD (0 when the row has no balance; check `balance`), `rate` converts burn too. */
export interface UsdAmount {
  amount: number;
  rate?: UsdRate;
}

export type RailKind =
  | "steward-manual"
  | "card-manual"
  | "dao-vote"
  | "split-inflow"
  | "x402-auto"
  | "none";
export type RailStatus = "supported" | "planned" | "unsupported";

/** How a line gets paid. `supported` renders a live control; `planned`/`unsupported` render a greyed label whose dialog names the gap. */
export interface Rail {
  kind: RailKind;
  status: RailStatus;
  /** Hub guide id or short title explaining the rail, never a URL. */
  guide?: string;
}

/** One named exact component of a balance (e.g. Console credit and escrow in uact) for the row dialog. */
export interface NativePart extends NativeAmount {
  label: string;
}

export type ReasonCode =
  | "unconfigured"
  | "unreadable"
  | "timeout"
  | "stale"
  | "burn_unmeasured"
  | "lease_starved"
  | "no_leases"
  | "escrow_advisory";

export type PayAction =
  /** The node's existing amount-only steward withdrawal (POST /api/v1/payments/steward-withdrawal). */
  | { kind: "fund-steward" }
  | {
      kind: "steward-checkout";
      vendor: "cherry" | "openrouter";
      checkoutUrl: string;
    }
  | { kind: "external"; url: string; label: string };

/** Exact source-native decimal text for reporting; no conversion or settlement arithmetic. */
export interface NativeAmount {
  amount: string;
  currency: string;
}

export interface NativeRate extends NativeAmount {
  per: "day" | "month" | "block";
}

/** Public account identity only; never an RPC endpoint or credential. */
export interface WalletIdentity {
  address: string;
  network: string;
  /** Public HTTPS explorer address page, without URL credentials. */
  explorerUrl: string;
}

export interface MoneyPlaneRow {
  /** Stable id, e.g. "openrouter:account", "base:steward-wallet". */
  plane: string;
  label: string;
  kind: PlaneKind;
  /** Configured public account, retained even when its balance is unreadable. */
  wallet?: WalletIdentity;
  /** Display-only native units (USD, USDC, ACT, EUR …); null when unread. Never settlement arithmetic. */
  balance: number | null;
  currency: string | null;
  /** Native units per day; usage-billed planes report their spend rate. */
  burnPerDay: number | null;
  /** prepaid: balance ÷ burn; expiry: days left; usage and wallet: null. */
  runwayDays: number | null;
  grade: Grade;
  /** ISO read-at time; not a persisted source observation timestamp. */
  observedAt: string;
  /** Safe human source label, never a URL or credential. */
  source?: string;
  sourceObservedAt?: string | null;
  freshness?: "current" | "stale" | "unknown";
  /** Economic payer and beneficiary; wallet custody alone proves neither. */
  payer?: string;
  beneficiary?: string;
  coverage?: "direct" | "operator-covered" | "unknown";
  nativeRate?: NativeRate;
  /** Aggregate vendor-transfer evidence, not an individual payment timeline. */
  cumulativeVendorTransfer?: NativeAmount;
  reasonCode?: ReasonCode;
  /** ≤60 chars; never carries a URL, key or address. */
  detail?: string;
  /** Cumulative spend counter (e.g. OpenRouter total_usage) a scheduler can difference into burn. */
  usageTotal?: number;
  payAction?: PayAction;
  /** Normalized USD projection set by `toUsd`; columns and sums read this, dialogs read native fields. */
  usd?: UsdAmount;
  rail?: Rail;
  /** One level of sub-rows, e.g. Akash per node or Grafana per product. A parent carrying burn is the rollup; children are detail. */
  children?: MoneyPlaneRow[];
  /** Exact named parts of the balance for the dialog. */
  parts?: NativePart[];
  /** One short dialog line of context (≤80 chars, no URL), e.g. how money moves through a wallet. */
  note?: string;
}

/** The subset of `fetch` the readers use; the global `fetch` satisfies it. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export interface PlaneReader {
  readonly plane: string;
  /** Used for the fallback row when the reader throws or times out. */
  readonly label?: string;
  readonly kind?: PlaneKind;
  /** Carried onto the fallback row so an action stays reachable while its plane is unreadable. */
  readonly payAction?: PayAction;
  /** Carried onto the fallback row so the Action cell still says how the line gets paid. */
  readonly rail?: Rail;
  /** Configured public identity carried onto unreadable/timeout fallback rows. */
  readonly wallet?: WalletIdentity;
  read(signal: AbortSignal): Promise<MoneyPlaneRow>;
}

export interface MoneyPlaneSnapshot {
  takenAt: string;
  rows: MoneyPlaneRow[];
  worst: Grade;
}
