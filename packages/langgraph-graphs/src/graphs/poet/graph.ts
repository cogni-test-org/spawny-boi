// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/poet/graph`
 * Purpose: Poetic AI assistant graph factory.
 * Scope: Configures the shared native deep-agent harness with injected LLM and tools. Does NOT execute graphs or read env.
 * Invariants:
 *   - Pure factory function — no side effects, no env reads
 *   - LLM and tools are injected, not instantiated
 *   - TYPE_TRANSPARENT_RETURN: No explicit return type annotation to preserve CompiledStateGraph for CLI schema extraction
 * Side-effects: none
 * Links: LANGGRAPH_AI.md, AGENT_DEVELOPMENT_GUIDE.md
 * @public
 */

import { cogniProfile, createCogniProgram } from "../cogni/graph";
import { POET_TOOL_IDS } from "./tools";
import type { CreateReactAgentGraphOptions } from "../types";
import { POET_CHILD_DESCRIPTION, POET_CHILD_PROMPT, POET_SYSTEM_PROMPT } from "./prompts";

/**
 * Graph name constant for routing.
 */
export const POET_GRAPH_NAME = "poet" as const;

/** Poet and its isolated creative child share the native Cogni harness. */
export function createPoetGraph(opts: CreateReactAgentGraphOptions) {
	return createCogniProgram({
		...opts,
		profile: cogniProfile({
			id: "poet",
			instructions: POET_SYSTEM_PROMPT,
			modelTier: "main",
			toolIds: POET_TOOL_IDS,
			skillIds: (opts.sourceContext?.governingIndex ?? []).map(
				(entry) => entry.id,
			),
			allowedChildProfiles: ["general-purpose"],
		}),
		children: [
			{
				description: POET_CHILD_DESCRIPTION,
				profile: cogniProfile({
					id: "general-purpose",
					instructions: POET_CHILD_PROMPT,
					modelTier: "flash",
					toolIds: POET_TOOL_IDS,
					skillIds: (opts.sourceContext?.governingIndex ?? []).map(
						(entry) => entry.id,
					),
					allowedChildProfiles: [],
				}),
			},
		],
	});
}

createPoetGraph.tierModelIds = { flash: "deepseek-v4-flash" };
