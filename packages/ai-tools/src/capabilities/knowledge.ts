// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/knowledge`
 * Purpose: Preserve the public capability API from its domain owner.
 * Scope: Compatibility re-exports only; no I/O or implementations.
 * Invariants: Knowledge-store owns these contracts.
 * Side-effects: none
 * @public
 */
export { CONFIDENCE, type KnowledgeEntry, type KnowledgeSearchParams, type KnowledgeListParams, type KnowledgeWriteParams, type KnowledgeCapability, type ActiveGoalInfo } from "@cogni-dao/knowledge-store/contracts";
