// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `tests/unit/app/admin/finance-preview`
 * Purpose: Prove preview-only query isolation, production route denial, and that both fixture scenarios
 *   are shaped like the real node composition (planes, rails, USD projection, summary).
 * Scope: Real QueryObserver/client and server page guard; no network or database.
 * Invariants: Stale/invalidation never reads live money; no fixture cache reuse.
 * Side-effects: local test query cache
 * Links: app/dev/finance-preview/{FixtureBoundary,fixture,page}.tsx
 * @internal
 */
import { QueryObserver } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: vi.fn(),
	report: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error("NOT_FOUND");
	}),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/shared/env", () => ({ getEnv: mocks.env }));
vi.mock("@/app/(admin)/AdminShell", () => ({
	AdminShell: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/app/dev/finance-preview/FinancePreviewClient.client", () => ({
	FinancePreviewClient: mocks.report,
}));
vi.mock("@/components", async () => {
	const { createElement } = await import("react");
	const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
	return { HintText: box, Button: box, PageContainer: box };
});

import { createFinancePreviewQueryClient } from "@/app/dev/finance-preview/FixtureBoundary";
import { liveShapedPreview, previewFor, sparsePreview } from "@/app/dev/finance-preview/fixture";
import FinancePreviewPage from "@/app/dev/finance-preview/page";

const PLANES = [
	"income:credit-purchases",
	"income:node-services",
	"base:dao-treasury",
	"base:operator-wallet",
	"base:steward-wallet",
	"openrouter:account",
	"hosting:operator-covered",
	"ai:operator-covered",
];

describe("fixture shell treasury isolation", () => {
	it("never fetches an unseeded or stale fixture treasury, even after invalidation", async () => {
		const fetch = vi.fn(async () => {
			throw new Error("LIVE_READ");
		});
		const fixture = {
			treasuryAddress: "0x1111111111111111111111111111111111111111",
			chainId: 8453,
			blockNumber: "0",
			balances: [
				{
					token: "USDC",
					tokenAddress: null,
					balanceWei: "7071234",
					balanceFormatted: "7.071234",
					decimals: 6,
				},
			],
			timestamp: 0,
		};
		for (const snapshot of [undefined, fixture]) {
			const client = createFinancePreviewQueryClient(snapshot);
			const observer = new QueryObserver(client, {
				queryKey: ["treasury", "snapshot"],
				queryFn: fetch,
				staleTime: 0,
				retry: 1,
				refetchInterval: false,
				refetchOnWindowFocus: false,
			});
			const unsubscribe = observer.subscribe(() => {});
			await client.invalidateQueries({ queryKey: ["treasury", "snapshot"] });
			await client.refetchQueries({ queryKey: ["treasury", "snapshot"] });
			expect(fetch).not.toHaveBeenCalled();
			expect(observer.getCurrentResult().data).toEqual(snapshot);
			expect(observer.getCurrentResult().isLoading).toBe(false);
			unsubscribe();
			client.clear();
		}
		expect(createFinancePreviewQueryClient().getQueryData(["treasury", "snapshot"])).toBeUndefined();
	});

	it.each(["production", "test"])("returns 404 in %s before evaluating fixture selection", async (env) => {
		mocks.env.mockReturnValue(env);
		const then = vi.fn();
		await expect(
			FinancePreviewPage({
				searchParams: { then } as unknown as Promise<{ scenario?: string }>,
			}),
		).rejects.toThrow("NOT_FOUND");
		expect(then).not.toHaveBeenCalled();
	});
});

describe("fixture scenarios", () => {
	it("live-shaped carries every node plane with the design's balances, rails and the one summary", () => {
		expect(liveShapedPreview.rows.map((r) => r.plane)).toEqual(PLANES);
		expect(liveShapedPreview.treasuryPlane).toBe("base:dao-treasury");
		const by = Object.fromEntries(liveShapedPreview.rows.map((r) => [r.plane, r]));
		expect(by["income:credit-purchases"]).toMatchObject({
			kind: "income",
			burnPerDay: 0,
			grade: "INFO",
			rail: { kind: "split-inflow", status: "supported" },
		});
		expect(by["income:node-services"]).toMatchObject({
			kind: "income",
			grade: "UNKNOWN",
			rail: { kind: "x402-auto", status: "planned" },
		});
		expect(by["base:dao-treasury"]).toMatchObject({
			balance: 74.52,
			currency: "USDC",
			grade: "INFO",
			usd: { amount: 74.52 },
			rail: { kind: "dao-vote", status: "planned" },
		});
		expect(by["base:operator-wallet"]).toMatchObject({
			label: "Operator wallet",
			balance: 10.77,
			payAction: { kind: "fund-steward" },
			rail: { kind: "steward-manual", status: "supported" },
			note: "User payments → operator wallet → steward wallet → OpenRouter",
		});
		expect(by["base:steward-wallet"]).toMatchObject({ label: "Steward wallet", balance: 7.07, rail: { kind: "none" } });
		expect(by["base:steward-wallet"]).not.toHaveProperty("payAction");
		expect(by["openrouter:account"]).toMatchObject({
			balance: null,
			grade: "UNKNOWN",
			reasonCode: "unconfigured",
			detail: "needs a management key · task.5361",
			rail: { kind: "steward-manual", status: "supported" },
			payAction: {
				kind: "steward-checkout",
				vendor: "openrouter",
				checkoutUrl: "https://openrouter.ai/settings/credits",
			},
		});
		for (const plane of ["hosting:operator-covered", "ai:operator-covered"])
			expect(by[plane]).toMatchObject({
				balance: null,
				burnPerDay: null,
				coverage: "operator-covered",
				payer: "Operator",
				rail: { kind: "none", status: "planned", guide: "Operator-funded" },
			});
		expect(liveShapedPreview.summary).toMatchObject({
			treasuryUsd: 74.52,
			incomePerDay: 0,
			burnPerDay: null,
			runwayDays: null,
			nextDeadline: null,
			windowDays: 30,
			ratesUsed: [],
		});
		expect(liveShapedPreview.stewardWalletUrl).toContain("basescan.org/address/");
	});

	it("sparse keeps every plane but reads nothing: RPC unavailable, no OpenRouter read, no ledger", () => {
		expect(sparsePreview.rows.map((r) => r.plane)).toEqual(PLANES);
		expect(sparsePreview.rows.every((r) => r.balance === null)).toBe(true);
		expect(
			sparsePreview.rows.filter((r) => r.kind === "wallet").every((r) => r.reasonCode === "unreadable"),
		).toBe(true);
		expect(sparsePreview.rows.find((r) => r.plane === "openrouter:account")).toMatchObject({
			reasonCode: "unconfigured",
			payAction: { kind: "steward-checkout" },
		});
		// Actions stay reachable while a plane is unreadable.
		expect(sparsePreview.rows.find((r) => r.plane === "base:operator-wallet")).toMatchObject({
			payAction: { kind: "fund-steward" },
		});
		expect(sparsePreview.summary).toMatchObject({ treasuryUsd: null, incomePerDay: null, burnPerDay: null });
	});

	it("selects sparse by query and defaults to live-shaped", () => {
		expect(previewFor("sparse")).toEqual({ scenario: "sparse", report: sparsePreview });
		expect(previewFor(undefined).scenario).toBe("live-shaped");
		expect(previewFor("rich").scenario).toBe("live-shaped");
	});

	it("renders the package report binding with the selected fixture in development", async () => {
		mocks.env.mockReturnValue("development");
		renderToStaticMarkup(
			await FinancePreviewPage({
				searchParams: Promise.resolve({ scenario: "sparse" }),
			}),
		);
		expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ report: sparsePreview }), undefined);
	});
});
