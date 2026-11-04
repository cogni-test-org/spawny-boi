// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/knowledge-base-seeds`
 * Purpose: Guard the universal, node-neutral knowledge bootstrap.
 * Scope: Static seed values only; no database writes or network calls.
 * Invariants: UNIVERSAL_DOMAINS_ONLY, SOVEREIGN_ORIENTATION_HANDOFF, SHARED_AGENT_CONTRACT.
 * Side-effects: none
 * @public
 */

import {
	GOALS_BOOTSTRAP_INSTRUCTION,
	selectGoverningIndex,
} from "@cogni/knowledge-store";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	renderBundleMarkdown,
	SESSION_BOOTSTRAP_INVARIANTS,
} from "@/app/api/v1/cognition/_bundle";
import { BASE_KNOWLEDGE_SEEDS } from "../../../packages/knowledge-base/src/seeds/base";
import { BASE_DOMAIN_SEEDS } from "../../../packages/knowledge-base/src/seeds/domains";

describe("knowledge base seeds", () => {
	it("ships only the universal domain baseline", () => {
		const domainIds = BASE_DOMAIN_SEEDS.map(({ id }) => id);
		expect(domainIds).toEqual(["meta", "mission", "strategy"]);
		expect(domainIds).not.toEqual(
			expect.arrayContaining([
				"prediction-market",
				"infrastructure",
				"governance",
				"reservations",
			]),
		);
		expect(
			BASE_KNOWLEDGE_SEEDS.every(({ domain }) => domainIds.includes(domain)),
		).toBe(true);
	});

	it("hands the generic starter to one sovereign node", () => {
		const orientation = BASE_KNOWLEDGE_SEEDS.find(
			({ id }) => id === "cogni-agent-orientation",
		);
		expect(orientation?.domain).toBe("meta");
		expect(orientation?.entryType).toBe("guide");
		expect(orientation?.content).toContain(
			"Align once with this node's human CEO",
		);
		expect(orientation?.content).toContain(
			"Persist the CEO-approved strings byte-for-byte",
		);
		expect(orientation?.content).toContain("`<slug>-agent-orientation`");
		expect(orientation?.content).toContain("this node's own Dolt hub");
		expect(orientation?.content).toContain(
			"`https://<node-slug>.cognidao.org/work/items/{id}`",
		);
		expect(orientation?.content).toContain(
			"operator node alone uses the apex `https://cognidao.org/work/items/{id}`",
		);
		expect(orientation?.content).toContain(
			"Never copy another node's mission or node-specific contract",
		);
	});

	it("preserves the shared process and status contracts", () => {
		const content = BASE_KNOWLEDGE_SEEDS.find(
			({ id }) => id === "cogni-agent-orientation",
		)?.content;
		expect(content).toContain(
			'<agent-contract rule="How you work plus how you communicate.',
		);
		expect(content).toContain("<process-contract rule=");
		expect(content).toContain("<status-contract rule=");
		expect(content).toContain("| 🎯 **Goal** |");
		expect(content).toContain("| **Done when** |");
		expect(content).toContain("| **Followed** |");
		expect(content).toContain("Only three legal stop states");
		expect(content).toContain("</agent-contract>");

		const terminal =
			"| technical anything | never | research → compare → record → act |";
		const start = content?.indexOf("## The agent-contract") ?? -1;
		const terminalStart = content?.indexOf(terminal) ?? -1;
		expect(start).toBeGreaterThanOrEqual(0);
		expect(terminalStart).toBeGreaterThan(start);
		const sharedContract = `${content?.slice(
			start,
			terminalStart + terminal.length,
		)}\n`;
		const nodeWorkItemUrl = "https://<node-slug>.cognidao.org/work/items/{id}";
		const operatorWorkItemUrl = "https://cognidao.org/work/items/{id}";
		expect(sharedContract.split(nodeWorkItemUrl)).toHaveLength(2);
		expect(sharedContract).not.toContain(operatorWorkItemUrl);
		const operatorNormalizedContract = sharedContract.replace(
			nodeWorkItemUrl,
			operatorWorkItemUrl,
		);
		expect(
			createHash("sha256").update(operatorNormalizedContract).digest("hex"),
		).toBe("5b31d2166c819002120bb1c3b88ab1c9fd299510c5a160b1bf7fa3a20a91a914");
	});

	it("preserves complete starter orientation and contract beside canonical governing discovery", () => {
		const orientation = BASE_KNOWLEDGE_SEEDS.find(
			({ id }) => id === "cogni-agent-orientation",
		);
		expect(orientation).toBeDefined();
		const markdown = renderBundleMarkdown({
			node: "00000000-0000-0000-0000-000000000000",
			name: "new-node",
			mission: "A newly formed sovereign Cogni node.",
			generatedAt: "2026-10-05T00:00:00.000Z",
			origin: "https://new-node.cognidao.org",
			buildSha: "0".repeat(40),
			toolingInvariants: SESSION_BOOTSTRAP_INVARIANTS,
			skillsIndex: [],
			governingIndex: selectGoverningIndex(BASE_KNOWLEDGE_SEEDS, []),
			domainPointers: BASE_DOMAIN_SEEDS.map((domain) => ({
				domain: domain.id,
				entryCount: 0,
				description: domain.description ?? "",
			})),
			orientation: {
				id: orientation?.id ?? "cogni-agent-orientation",
				content: orientation?.content ?? "",
			},
			// NODES_BOOT_EMPTY: a fresh node has no approved goals.
			goals: { status: "ok", goals: [] },
		});
		// A fresh node's bundle carries the zero-goal bootstrap instruction (story.5101).
		expect(markdown).toContain(`## Goals\n\n${GOALS_BOOTSTRAP_INSTRUCTION}`);
		// Both SessionStart channels are uncapped (story.5070), so the starter
		// orientation must render WHOLE — never clipped to a byte ceiling.
		expect(markdown).toContain(orientation?.content ?? "");
		expect(markdown).toContain("</agent-contract>");
	});
});
