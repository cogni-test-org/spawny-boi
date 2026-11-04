// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/finance-preview/fixture`
 * Purpose: Explicitly synthetic Financials preview scenarios shaped like this node's real composition.
 * Scope: Static data only; no config, secrets, adapters or provider reads. Rows are projected to USD and summarized
 *   through the same package functions the server helper uses.
 * Invariants: Rows carry the same planes, labels, rails and reason codes the server composition produces.
 * Side-effects: none
 * Links: admin/payments/money-plane.server.ts, @cogni/money-plane/react
 * @internal
 */
import {
	type MoneyPlaneRow,
	type PayAction,
	type Rail,
	summarize,
	toUsd,
} from "@cogni/money-plane";

import type { NodeFinanceSnapshot } from "@/app/(admin)/admin/payments/money-plane.server";

export const PREVIEW_SCENARIOS = ["live-shaped", "sparse"] as const;
export type PreviewScenario = (typeof PREVIEW_SCENARIOS)[number];

const takenAt = "2026-10-26T19:42:00.000Z";
const observedAt = "2026-10-26T19:41:58.000Z";
/** The same actions and rails the server composition attaches (ONE_ROW_MODEL). */
const FUND_STEWARD: PayAction = { kind: "fund-steward" };
const OPENROUTER_CHECKOUT: PayAction = {
	kind: "steward-checkout",
	vendor: "openrouter",
	checkoutUrl: "https://openrouter.ai/settings/credits",
};
const STEWARD_RAIL: Rail = { kind: "steward-manual", status: "supported" };
const NO_RAIL: Rail = { kind: "none", status: "unsupported" };
const DAO_VOTE: Rail = { kind: "dao-vote", status: "planned", guide: "governance" };
const OPERATOR_FUNDED: Rail = { kind: "none", status: "planned", guide: "Operator-funded" };
const SPLIT: Rail = { kind: "split-inflow", status: "supported" };
const MONEY_CHAIN = "User payments → operator wallet → steward wallet → OpenRouter";

const PREVIEW_WALLETS: Record<string, string> = {
	"base:dao-treasury": `0x${"1".repeat(40)}`,
	"base:operator-wallet": `0x${"2".repeat(40)}`,
	"base:steward-wallet": `0x${"3".repeat(40)}`,
};
function walletIdentity(plane: string) {
	const address = PREVIEW_WALLETS[plane];
	return address ? { wallet: { address, network: "Base", explorerUrl: `https://basescan.org/address/${address}` } } : {};
}

function wallet(
	plane: string,
	label: string,
	balance: number,
	eth: string,
	rail: Rail,
	extra: Partial<MoneyPlaneRow> = {},
): MoneyPlaneRow {
	return {
		plane,
		label,
		kind: "wallet",
		...walletIdentity(plane),
		balance,
		currency: "USDC",
		burnPerDay: null,
		runwayDays: null,
		grade: "INFO",
		observedAt,
		source: "Base JSON-RPC",
		sourceObservedAt: observedAt,
		freshness: "current",
		detail: eth,
		rail,
		...extra,
	};
}
function unreadableWallet(
	plane: string,
	label: string,
	rail: Rail,
	extra: Partial<MoneyPlaneRow> = {},
): MoneyPlaneRow {
	return {
		plane,
		label,
		kind: "wallet",
		...walletIdentity(plane),
		balance: null,
		currency: null,
		burnPerDay: null,
		runwayDays: null,
		grade: "UNKNOWN",
		observedAt,
		freshness: "unknown",
		sourceObservedAt: null,
		reasonCode: "unreadable",
		detail: "eth_call HTTP 503",
		rail,
		...extra,
	};
}
function operatorCovered(plane: string, label: string, detail: string): MoneyPlaneRow {
	return {
		plane,
		label,
		kind: "usage",
		balance: null,
		currency: null,
		burnPerDay: null,
		runwayDays: null,
		grade: "UNKNOWN",
		observedAt,
		source: "Operator sponsorship",
		sourceObservedAt: null,
		freshness: "unknown",
		payer: "Operator",
		beneficiary: "This node",
		coverage: "operator-covered",
		reasonCode: "unconfigured",
		detail,
		rail: OPERATOR_FUNDED,
	};
}
function income(perDay: number, purchases: number, totalUsd: number): MoneyPlaneRow {
	return {
		plane: "income:credit-purchases",
		label: "Credit purchases",
		kind: "income",
		balance: null,
		currency: "USD",
		burnPerDay: perDay,
		runwayDays: null,
		grade: "INFO",
		observedAt,
		source: "payment_events · CREDITED · trailing 30 days",
		sourceObservedAt: observedAt,
		freshness: "current",
		detail: `${purchases} purchases · ${totalUsd.toFixed(2)} USD in 30d`,
		rail: SPLIT,
	};
}
const nodeServices: MoneyPlaneRow = {
	plane: "income:node-services",
	label: "Node services",
	kind: "income",
	balance: null,
	currency: null,
	burnPerDay: null,
	runwayDays: null,
	grade: "UNKNOWN",
	observedAt,
	sourceObservedAt: null,
	freshness: "unknown",
	reasonCode: "unconfigured",
	detail: "no USDC service income yet",
	rail: { kind: "x402-auto", status: "planned", guide: "node-service-usdc-northstar" },
};
/** OpenRouter /credits needs a management key; the inference key never reads it (task.5361). */
const openRouterUnknown: MoneyPlaneRow = {
	plane: "openrouter:account",
	label: "OpenRouter credit",
	kind: "prepaid",
	balance: null,
	currency: null,
	burnPerDay: null,
	runwayDays: null,
	grade: "UNKNOWN",
	observedAt,
	freshness: "unknown",
	sourceObservedAt: null,
	reasonCode: "unconfigured",
	detail: "needs a management key · task.5361",
	payAction: OPENROUTER_CHECKOUT,
	rail: STEWARD_RAIL,
};
const hosting = operatorCovered("hosting:operator-covered", "Hosting", "Funded by operator · cost not yet shared");
const ai = operatorCovered("ai:operator-covered", "AI", "Funded by operator · usage not yet shared");

function model(rows: MoneyPlaneRow[], worst: MoneyPlaneRow["grade"]): NodeFinanceSnapshot {
	const projected = rows.map((row) => toUsd(row, []));
	return {
		takenAt,
		worst,
		treasuryPlane: "base:dao-treasury",
		rows: projected,
		summary: summarize({ rows: projected }, { treasuryPlane: "base:dao-treasury", windowDays: 30 }),
		stewardWalletUrl: "https://basescan.org/address/0x3333333333333333333333333333333333333333",
	};
}

/** Every reader answered: no purchases yet, three wallets, OpenRouter unknown (management key), operator-funded lines. */
export const liveShapedPreview: NodeFinanceSnapshot = model(
	[
		income(0, 0, 0),
		nodeServices,
		wallet("base:dao-treasury", "DAO treasury", 74.52, "0.0021 ETH", DAO_VOTE),
		wallet("base:operator-wallet", "Operator wallet", 10.77, "0.0008 ETH", STEWARD_RAIL, {
			payAction: FUND_STEWARD,
			note: MONEY_CHAIN,
		}),
		wallet("base:steward-wallet", "Steward wallet", 7.07, "0.0003 ETH", NO_RAIL, {
			note: "Human-custodied; pays OpenRouter in USDC",
		}),
		openRouterUnknown,
		hosting,
		ai,
	],
	"UNKNOWN",
);

/** Wallets configured but the RPC is down, no OpenRouter key, and no ledger in this environment. */
export const sparsePreview: NodeFinanceSnapshot = model(
	[
		{
			...income(0, 0, 0),
			balance: null,
			currency: null,
			burnPerDay: null,
			grade: "UNKNOWN",
			reasonCode: "unreadable",
			detail: "ledger unavailable",
			sourceObservedAt: null,
			freshness: "unknown",
		},
		nodeServices,
		unreadableWallet("base:dao-treasury", "DAO treasury", DAO_VOTE),
		unreadableWallet("base:operator-wallet", "Operator wallet", STEWARD_RAIL, {
			payAction: FUND_STEWARD,
			note: MONEY_CHAIN,
		}),
		unreadableWallet("base:steward-wallet", "Steward wallet", NO_RAIL),
		{
			plane: "openrouter:account",
			label: "OpenRouter credit",
			kind: "prepaid",
			balance: null,
			currency: null,
			burnPerDay: null,
			runwayDays: null,
			grade: "UNKNOWN",
			observedAt,
			freshness: "unknown",
			sourceObservedAt: null,
			reasonCode: "unconfigured",
			detail: "needs a management key · task.5361",
			payAction: OPENROUTER_CHECKOUT,
			rail: STEWARD_RAIL,
		},
		hosting,
		ai,
	],
	"UNKNOWN",
);

export function previewFor(scenario: string | undefined): {
	scenario: PreviewScenario;
	report: NodeFinanceSnapshot;
} {
	return scenario === "sparse"
		? { scenario: "sparse", report: sparsePreview }
		: { scenario: "live-shaped", report: liveShapedPreview };
}
