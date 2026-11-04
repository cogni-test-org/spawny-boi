// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/money-plane.server`
 * Purpose: This node's money-plane composition — income (credited purchases; node services planned), the repo-spec wallets,
 *   the OpenRouter line (balance unknown until a management-scoped read exists, Top up still reachable), and the operator-funded
 *   Hosting and AI lines — as one snapshot projected
 *   to USD (ECB rate, fetched only when a non-dollar row exists) with the one summary the package UI renders.
 * Scope: Server-only. Reads repo-spec + server env and hands them to the package readers. Does not move funds,
 *   decide alerts, or render.
 * Invariants: Repo-spec approver authorization precedes credentials and provider reads. READERS_NEVER_THROW.
 *   Unreadable is UNKNOWN, never GREEN. Treasury is identified only from configuration. Every row carries its rail.
 * Side-effects: IO (Base JSON-RPC, ledger read, at most one FX read), one terminal MONEY_PLANE_SNAPSHOT log event.
 * Links: packages/money-plane, https://cognidao.org/knowledge/finances-expert
 * @public
 */

import "server-only";

import {
	BASE_PUBLIC_RPC_URL,
	baseWalletReader,
	creditPurchaseIncomeReader,
	fetchEcbRate,
	type FetchLike,
	type MoneyPlaneRow,
	type MoneyPlaneSnapshot,
	type PayAction,
	type PlaneReader,
	type Rail,
	type ReportSummary,
	summarize,
	takeSnapshot,
	toUsd,
	type UsdRate,
	unknownRow,
} from "@cogni/money-plane";
import { redirect } from "next/navigation";

import { creditPurchasesQuery } from "@/bootstrap/capabilities/finance";
import { getServerSessionUser } from "@/lib/auth/server";
import {
	getDaoTreasuryAddress,
	getOperatorWalletConfig,
	getStewardWalletConfig,
	isLedgerApprover,
} from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";

const log = makeLogger({ route: "admin.payments" });

const SNAPSHOT_TIMEOUT_MS = 8_000;
/** The human checkout the steward wallet pays into; the row's Action opens it. */
export const OPENROUTER_CHECKOUT_URL = "https://openrouter.ai/settings/credits";
const DOLLAR = new Set(["USD", "USDC"]);
/** Trailing window for credited purchases; the Cash received card names it. */
const INCOME_WINDOW_DAYS = 30;
const STEWARD_RAIL: Rail = { kind: "steward-manual", status: "supported" };
const NO_RAIL: Rail = { kind: "none", status: "unsupported" };
/** Paid by the operator on this node's behalf until task.5354 shares the scoped cost. */
const OPERATOR_FUNDED: Rail = { kind: "none", status: "planned", guide: "Operator-funded" };
const MONEY_CHAIN = "User payments → operator wallet → steward wallet → OpenRouter";

const noStoreFetch: FetchLike = (url, init) => fetch(url, { ...init, cache: "no-store" });

export interface NodeFinanceSnapshot extends MoneyPlaneSnapshot {
	/** Plane id of the configured DAO treasury row, or null when repo-spec names none. */
	treasuryPlane: string | null;
	summary: ReportSummary;
	/** Explorer page of the steward wallet, for the "result unknown" check after a withdrawal. */
	stewardWalletUrl: string | null;
}

/**
 * OpenRouter `/credits` needs a management key; the inference key must not carry that authority, so the
 * balance stays unknown until task.5361 lands a scoped read. The Top up action stays reachable.
 */
function openRouterUnavailableReader(): PlaneReader {
	const plane = "openrouter:account";
	const label = "OpenRouter credit";
	const payAction: PayAction = {
		kind: "steward-checkout",
		vendor: "openrouter",
		checkoutUrl: OPENROUTER_CHECKOUT_URL,
	};
	return {
		plane,
		label,
		kind: "prepaid",
		payAction,
		async read(): Promise<MoneyPlaneRow> {
			return {
				...unknownRow({
					plane,
					label,
					kind: "prepaid",
					reasonCode: "unconfigured",
					observedAt: new Date().toISOString(),
					detail: "needs a management key · task.5361",
				}),
				rail: STEWARD_RAIL,
				payAction,
			};
		},
	};
}

/**
 * A cost the operator pays on this node's behalf. The node holds no credential for it,
 * so balance and burn stay null until the operator shares the scoped cost (task.5354).
 */
function operatorCoveredReader(plane: string, label: string, detail: string): PlaneReader {
	return {
		plane,
		label,
		kind: "usage",
		async read(): Promise<MoneyPlaneRow> {
			return {
				...unknownRow({
					plane,
					label,
					kind: "usage",
					reasonCode: "unconfigured",
					observedAt: new Date().toISOString(),
					detail,
				}),
				source: "Operator sponsorship",
				payer: "Operator",
				beneficiary: "This node",
				coverage: "operator-covered",
				rail: OPERATOR_FUNDED,
			};
		},
	};
}

/** Attach node metadata; expose the rail on the reader for the existing timeout fallback. */
function withRow(reader: PlaneReader, extra: Partial<MoneyPlaneRow>): PlaneReader {
	return {
		...reader,
		...(extra.rail === undefined ? {} : { rail: extra.rail }),
		read: async (signal) => ({ ...(await reader.read(signal)), ...extra }),
	};
}

function plannedIncomeReader(): PlaneReader {
	const plane = "income:node-services";
	const label = "Node services";
	return {
		plane,
		label,
		kind: "income",
		async read(): Promise<MoneyPlaneRow> {
			return {
				...unknownRow({
					plane,
					label,
					kind: "income",
					reasonCode: "unconfigured",
					observedAt: new Date().toISOString(),
					detail: "no USDC service income yet",
				}),
				rail: { kind: "x402-auto", status: "planned", guide: "node-service-usdc-northstar" },
			};
		},
	};
}

function incomeReader(): PlaneReader {
	const query = creditPurchasesQuery();
	if (query) return creditPurchaseIncomeReader({ query, windowDays: INCOME_WINDOW_DAYS });
	const plane = "income:credit-purchases";
	const label = "Credit purchases";
	return {
		plane,
		label,
		kind: "income",
		async read(): Promise<MoneyPlaneRow> {
			return {
				...unknownRow({
					plane,
					label,
					kind: "income",
					reasonCode: "unreadable",
					observedAt: new Date().toISOString(),
					detail: "ledger unavailable",
				}),
				rail: { kind: "split-inflow", status: "supported" },
			};
		},
	};
}

function readers(): { readers: PlaneReader[]; treasuryPlane: string | null; stewardWalletUrl: string | null } {
	const env = serverEnv();
	const wallet = {
		rpcUrl: env.EVM_RPC_URL ?? BASE_PUBLIC_RPC_URL,
		fetch: noStoreFetch,
		usdcAddress: USDC_TOKEN_ADDRESS,
	};
	const operator = getOperatorWalletConfig()?.address;
	const steward = getStewardWalletConfig()?.address;
	const configured: {
		name: string;
		label: string;
		address: string | null | undefined;
		payAction?: PayAction;
		rail: Rail;
		note?: string;
	}[] = [
		{
			name: "dao-treasury",
			label: "DAO treasury",
			address: getDaoTreasuryAddress(),
			rail: { kind: "dao-vote", status: "planned", guide: "governance" },
		},
		{
			name: "operator-wallet",
			label: "Operator wallet",
			address: operator,
			// Fund-steward moves operator USDC to the steward; without a steward there is nowhere to send it.
			...(steward
				? { payAction: { kind: "fund-steward" as const }, rail: STEWARD_RAIL }
				: { rail: { kind: "steward-manual" as const, status: "unsupported" as const } }),
			note: MONEY_CHAIN,
		},
		{
			name: "steward-wallet",
			label: "Steward wallet",
			address: steward,
			rail: NO_RAIL,
			note: "Human-custodied; pays OpenRouter in USDC",
		},
	];
	// One reader per distinct address: two roles on the same account are one balance, not two.
	let treasuryPlane: string | null = null;
	const accounts = new Map<string, (typeof configured)[number]>();
	for (const account of configured) {
		const address = account.address;
		const key =
			address && /^0x[0-9a-fA-F]{40}$/.test(address)
				? `base:${wallet.usdcAddress.toLowerCase()}:${address.toLowerCase()}`
				: account.name;
		const prior = accounts.get(key);
		if (account.name === "dao-treasury" && address) treasuryPlane = `base:${prior?.name ?? account.name}`;
		if (prior) {
			prior.label = `${prior.label} / ${account.label}`;
			if (prior.payAction === undefined && account.payAction !== undefined) {
				prior.payAction = account.payAction;
				prior.rail = account.rail;
			}
			if (prior.note === undefined && account.note !== undefined) prior.note = account.note;
		} else accounts.set(key, { ...account });
	}
	return {
		treasuryPlane,
		stewardWalletUrl: steward ? `https://basescan.org/address/${steward}` : null,
		readers: [
			incomeReader(),
			plannedIncomeReader(),
			...[...accounts.values()].map(({ rail, note, ...account }) =>
				withRow(baseWalletReader({ ...wallet, ...account }), { rail, ...(note ? { note } : {}) }),
			),
			openRouterUnavailableReader(),
			operatorCoveredReader("hosting:operator-covered", "Hosting", "Funded by operator · cost not yet shared"),
			operatorCoveredReader("ai:operator-covered", "AI", "Funded by operator · usage not yet shared"),
		],
	};
}

/** Authorize at the data boundary, then emit one terminal event per admitted report read. */
export async function getMoneyPlaneSnapshot(): Promise<NodeFinanceSnapshot> {
	// Layouts may render concurrently with their children; gate before credentials or IO.
	const user = await getServerSessionUser();
	if (!isLedgerApprover(user?.walletAddress ?? null)) redirect("/dashboard");

	const started = Date.now();
	try {
		const composition = readers();
		const snapshot = await takeSnapshot(composition.readers, {
			timeoutMs: SNAPSHOT_TIMEOUT_MS,
		});
		const foreign = new Set(
			snapshot.rows
				.flatMap((row) => [row, ...(row.children ?? [])])
				.map((row) => row.currency)
				.filter((c): c is string => Boolean(c) && !DOLLAR.has(c as string)),
		);
		// The FX read shares the page budget: whatever the snapshot left, never a second full budget.
		const fxSignal = AbortSignal.timeout(Math.max(SNAPSHOT_TIMEOUT_MS - (Date.now() - started), 1_000));
		const rates = (
			await Promise.all(
				[...foreign].map((currency) => fetchEcbRate(noStoreFetch, `${currency}USD`, fxSignal)),
			)
		).filter((rate): rate is UsdRate => rate !== null);
		const rows = snapshot.rows.map((row) => toUsd(row, rates));
		const summary = summarize(
			{ rows },
			{ treasuryPlane: composition.treasuryPlane, windowDays: INCOME_WINDOW_DAYS },
		);
		log.info(
			{
				event: EVENT_NAMES.MONEY_PLANE_SNAPSHOT,
				outcome: "success",
				durationMs: Date.now() - started,
				worst: snapshot.worst,
				planes: rows.map((r) => ({
					plane: r.plane,
					grade: r.grade,
					reasonCode: r.reasonCode ?? null,
				})),
			},
			EVENT_NAMES.MONEY_PLANE_SNAPSHOT,
		);
		return {
			...snapshot,
			rows,
			treasuryPlane: composition.treasuryPlane,
			summary,
			stewardWalletUrl: composition.stewardWalletUrl,
		};
	} catch (error) {
		// takeSnapshot never rejects; this is the composition failing (env or
		// repo-spec unreadable). Log the enum, never the raw message.
		log.error(
			{
				event: EVENT_NAMES.MONEY_PLANE_SNAPSHOT,
				outcome: "error",
				errorCode: "composition_failed",
				durationMs: Date.now() - started,
				worst: "UNKNOWN",
				planes: [],
			},
			EVENT_NAMES.MONEY_PLANE_SNAPSHOT,
		);
		throw error;
	}
}
