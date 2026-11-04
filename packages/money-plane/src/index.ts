// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane`
 * Purpose: Public surface of the money-plane package: row model, grading policy, snapshot runner, and the generic wallet + OpenRouter readers.
 * Scope: Re-exports only. The alert decision, routes, DI wiring, env loading and UI stay in each consuming node.
 * Invariants: PACKAGE_LEAF_NO_ENV — no runtime dependencies, no env reads, no React; fetch is injected.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

export {
  FRANKFURTER_URL,
  fetchEcbRate,
  rateFor,
  toUsd,
  usdBalance,
  usdBurn,
} from "./fx";
export {
  ESCROW_CALIBRATED,
  ESCROW_DAYS,
  EXPIRY_DAYS,
  gradeExpiry,
  gradeRunway,
  gradeSpend,
  RUNWAY_DAYS,
  SPEND_USD_PER_MONTH,
  type Thresholds,
  worstGrade,
} from "./grade";
export {
  BASE_PUBLIC_RPC_URL,
  BASE_USDC_ADDRESS,
  type BaseWalletReaderOptions,
  baseWalletReader,
} from "./readers/base-wallet";
export {
  CREDIT_PURCHASE_INCOME_PLANE,
  type CreditPurchaseIncomeReaderOptions,
  type CreditPurchaseTotals,
  creditPurchaseIncomeReader,
} from "./readers/credit-purchase-income";
export {
  OPENROUTER_CREDITS_URL,
  OPENROUTER_PLANE,
  type OpenRouterReaderOptions,
  openRouterReader,
} from "./readers/openrouter";
export {
  type ReportSummary,
  type SummarizeOptions,
  summarize,
} from "./report";
export {
  applyGradingFloor,
  safeDetail,
  type UnknownRowInput,
  unknownRow,
} from "./row";
export { type SnapshotOptions, takeSnapshot } from "./snapshot";
export {
  isStewardWithdrawalRejected,
  readStewardWithdrawal,
  StewardWithdrawalRejected,
} from "./steward";
export type {
  FetchLike,
  FetchResponseLike,
  Grade,
  MoneyPlaneRow,
  MoneyPlaneSnapshot,
  NativeAmount,
  NativePart,
  NativeRate,
  PayAction,
  PlaneKind,
  PlaneReader,
  Rail,
  RailKind,
  RailStatus,
  ReasonCode,
  UsdAmount,
  UsdRate,
  WalletIdentity,
} from "./types";
