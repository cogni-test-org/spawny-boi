// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/read-envelopes`
 * Purpose: Bind shared domain serializers to the node's public HTTP output validation.
 * Scope: Pure read serialization; no backend selection, auth or write policy.
 * Invariants: canonical read fields survive serialization and output parsing.
 * Side-effects: none
 * @internal
 */
import { KnowledgeRowSchema, WorkItemDtoSchema } from "@cogni/node-contracts";
import { type Knowledge, toKnowledgeRow } from "@cogni/knowledge-store";
import { toWorkItemDto, type WorkItem } from "@cogni/work-items";

export function toHttpWorkItem(item: WorkItem) {
	return WorkItemDtoSchema.parse(toWorkItemDto(item));
}

export function toHttpKnowledgeRow(entry: Knowledge) {
	return KnowledgeRowSchema.parse(toKnowledgeRow(entry));
}
