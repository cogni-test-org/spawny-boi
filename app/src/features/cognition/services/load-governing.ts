// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@features/cognition/services/load-governing`
 * Purpose: Read the canonical local governing index and project legacy discovery pointers.
 * Scope: Feature use case with an injected read port; no framework, env or remote operator reads.
 * Invariants: Membership is decided only by the shared store query; compatibility projection keeps every row.
 * Side-effects: Local knowledge reads via the injected port.
 * Links: task.5309
 * @public
 */
import type { KnowledgeStorePort } from "@cogni/knowledge-store";
export async function loadGoverningCognition(
	port: Pick<KnowledgeStorePort, "listGoverningIndex"> | null | undefined,
) {
	const governingIndex = port ? await port.listGoverningIndex() : [];
	return {
		governingIndex,
		skillsIndex: governingIndex.map((r) => ({
			id: r.id,
			domain: r.domain,
			entryType: r.entryType,
			title: r.useWhen,
		})),
	};
}
