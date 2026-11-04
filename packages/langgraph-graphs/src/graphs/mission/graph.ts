// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/mission/graph`
 * Purpose: Compatibility entrypoint for legacy mission roles and shared-harness programs.
 * Scope: Legacy callers retain their injected ReAct prompt; declared programs delegate to the shared harness.
 * Invariants:
 *   - FACTORY_SEAM: Wraps createReactAgent — LangChain v1 migration is a single-file change
 *   - SYSTEM_PROMPT_REQUIRED: Throws if systemPrompt not provided
 *   - Pure factory function — no side effects, no env reads
 * Side-effects: none
 * Links: agent-roles spec
 * @public
 */

import { MessagesAnnotation } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { CreateReactAgentGraphOptions } from "../types";
import {
	createPrioritizerRunHooks,
	createWorkPrioritizerGraph,
} from "../work-prioritizer/graph";

/**
 * Graph name constants for mission-engine roles.
 */
export const OPERATING_REVIEW_GRAPH_NAME = "operating-review" as const;
export const GIT_REVIEWER_GRAPH_NAME = "git-reviewer" as const;

/**
 * Create a mission-engine graph with a catalog-driven system prompt.
 *
 * This is the factory seam for all mission-engine roles. It wraps createReactAgent
 * so the LangChain v1 migration (createAgent replaces createReactAgent) is
 * a single-file change here.
 *
 * @param opts - Options with LLM, tools, and systemPrompt (required)
 * @returns Compiled LangGraph ready for invoke()
 * @throws Error if systemPrompt is not provided
 */
export function createMissionGraph(opts: CreateReactAgentGraphOptions) {
	if (opts.program) return createWorkPrioritizerGraph(opts);

	if (!opts.systemPrompt) {
		throw new Error(
			"createMissionGraph requires systemPrompt — mission graphs are prompt-driven via catalog",
		);
	}

	// Use 'prompt' (not deprecated 'messageModifier') — LangGraph converts string to SystemMessage
	return createReactAgent({
		llm: opts.llm,
		tools: [...opts.tools],
		prompt: opts.systemPrompt,
		stateSchema: MessagesAnnotation,
	});
}

createMissionGraph.createRunHooks = (
	context: Parameters<typeof createPrioritizerRunHooks>[0],
) => (context.program ? createPrioritizerRunHooks(context) : {});
createMissionGraph.tierModelIds = createWorkPrioritizerGraph.tierModelIds;
