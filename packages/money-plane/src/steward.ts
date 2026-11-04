// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/steward`
 * Purpose: Preserve broadcast evidence and distinguish a pre-broadcast refusal from an unknown outcome.
 * Scope: Pure outcome parser, error class and name-based guard. No React: a server action or any non-React caller may throw it.
 * Invariants: A `StewardWithdrawalRejected` without valid broadcast evidence means nothing was sent (retry allowed). Every other failure after a POST is an
 *   unknown outcome and the UI must lock until a human checks the wallet. The guard also matches by `name` so two copies
 *   of this package in one tree still agree.
 * Side-effects: none
 * Links: ./react/FinanceReport.tsx (FundSteward)
 * @public
 */

export class StewardWithdrawalRejected extends Error {
  override readonly name = "StewardWithdrawalRejected";
}

/** True for a `StewardWithdrawalRejected` from this or any other copy of the package. */
export function isStewardWithdrawalRejected(error: unknown): boolean {
  return (
    error instanceof StewardWithdrawalRejected ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "StewardWithdrawalRejected")
  );
}

/** A known broadcast stays inspectable even if receipt evidence is incomplete. */
export function readStewardWithdrawal(value: unknown): {
  txHash: string;
  receiptStatus: "success" | "reverted" | "pending";
} | null {
  if (typeof value !== "object" || value === null) return null;
  const evidence = value as { txHash?: unknown; receiptStatus?: unknown };
  if (typeof evidence.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(evidence.txHash)) return null;
  return {
    txHash: evidence.txHash,
    receiptStatus: evidence.receiptStatus === "success" || evidence.receiptStatus === "reverted"
      ? evidence.receiptStatus : "pending",
  };
}
