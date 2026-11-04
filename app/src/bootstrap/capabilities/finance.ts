// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/finance`
 * Purpose: Hand the app layer this node's finance data seams without exposing adapters: the credited-purchases query
 *   behind the package income reader.
 * Scope: Composition only. The money-plane composition itself stays in the page's server helper.
 * Invariants: Service-role read (payment_attempts is RLS-protected; income is node-wide). Never throws at construction:
 *   a missing database yields null and the row reads UNKNOWN.
 * Side-effects: Opens the service database client on first use.
 * Links: src/adapters/server/finance/credit-purchase-income.query.ts, @cogni/money-plane creditPurchaseIncomeReader
 * @internal
 */
import type { CreditPurchaseTotals } from "@cogni/money-plane";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { creditedPurchasesQuery } from "@/adapters/server/finance/credit-purchase-income.query";

export type CreditPurchasesQuery = (since: Date, signal: AbortSignal) => Promise<CreditPurchaseTotals>;

/** The query the package income reader runs, or null when no service database is reachable. */
export function creditPurchasesQuery(): CreditPurchasesQuery | null {
	try {
		return creditedPurchasesQuery(getServiceDb());
	} catch {
		return null;
	}
}
