// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** The reusable cogni core; models, capabilities and host identity are injected. */
import { isAiExecutionError } from "@cogni/ai-core";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { Command, StateSchema } from "@langchain/langgraph";
import {
	type CompiledSubAgent,
	CompositeBackend,
	createDeepAgent,
	createSubAgentMiddleware,
	createSummarizationMiddleware,
	StateBackend,
	StoreBackend,
	skillsMetadataValue,
} from "deepagents";
import {
	createMiddleware,
	MiddlewareError,
	modelRetryMiddleware,
	todoListMiddleware,
	toolCallLimitMiddleware,
} from "langchain";
import { InvalidCompletionError } from "../../runtime/cogni/completion-adapter";
import type { CreateReactAgentGraphOptions } from "../types";
import { composeCogniPrompt, hostClockPrompt } from "./prompts";
import { HubSkillBackend } from "./skill-backend";

export interface AgentProfile {
	readonly id: string;
	readonly instructions: string;
	readonly modelTier: string;
	readonly skillIds: readonly string[];
	readonly toolIds: readonly string[];
	readonly allowedChildProfiles: readonly string[];
	readonly limits: { readonly maxTaskCalls: number; readonly maxDepth: number };
}

export function cogniProfile(
	input: Pick<
		AgentProfile,
		"id" | "instructions" | "modelTier" | "toolIds" | "allowedChildProfiles"
	> &
		Partial<Pick<AgentProfile, "skillIds">>,
): AgentProfile {
	return {
		...input,
		skillIds: input.skillIds ?? [],
		limits: { maxTaskCalls: 4, maxDepth: 1 },
	};
}

/** Construct the shared core with a host-selected prompt and an explicit child registry. */
export function createCogniProgram(
	opts: CreateReactAgentGraphOptions & {
		readonly children?: readonly {
			readonly profile: AgentProfile;
			readonly description: string;
		}[];
		readonly disableCheckpointer?: boolean;
		readonly guardedTools?: readonly StructuredTool[];
		readonly profile?: AgentProfile;
	},
) {
	if (opts.disableCheckpointer && opts.guardedTools?.length)
		throw new Error("cogni_child_guarded_write_forbidden");
	const model = opts.profile
		? (opts.tierModels?.[opts.profile.modelTier] ??
			(!opts.tierModels ? opts.llm : undefined))
		: opts.llm;
	if (!(model instanceof BaseLanguageModel)) {
		throw new Error("cogni_requires_base_language_model");
	}
	const allowedTools = new Set(
		opts.profile?.toolIds ?? opts.tools.map((tool) => tool.name),
	);
	const readTools = new Set(
		opts.readToolIds ?? opts.tools.map((tool) => tool.name),
	);
	const tools = opts.tools
		.filter((tool) => allowedTools.has(tool.name))
		.map((tool) => {
			if (!(tool instanceof StructuredTool))
				throw new Error(`unsupported_tool:${tool.name}`);
			return tool;
		});
	if (
		opts.children?.some(
			(child) =>
				!opts.profile?.allowedChildProfiles.includes(child.profile?.id),
		)
	)
		throw new Error("cogni_child_profile_not_allowed");
	if (
		opts.children?.length &&
		(opts.disableCheckpointer || (opts.profile?.limits.maxDepth ?? 1) < 1)
	)
		throw new Error("cogni_child_depth_exceeded");
	const children: CompiledSubAgent[] = (opts.children ?? []).map((child) => {
		if (
			!child.profile ||
			Object.keys(child).some(
				(key) => key !== "profile" && key !== "description",
			) ||
			child.profile.allowedChildProfiles.length
		)
			throw new Error("cogni_child_must_be_leaf");
		const profile = {
			...child.profile,
			toolIds: child.profile.toolIds.filter(
				(id) => allowedTools.has(id) && readTools.has(id),
			),
			skillIds: child.profile.skillIds.filter((id) =>
				opts.profile?.skillIds.includes(id),
			),
			allowedChildProfiles: [],
		};
		return {
			name: profile.id,
			description: child.description,
			mode: "isolated" as const,
			runnable: createCogniProgram({
				...opts,
				profile,
				children: [],
				guardedTools: [],
				disableCheckpointer: true,
			}).withConfig({ recursionLimit: 30 }),
		};
	});
	const routes: Record<string, StoreBackend | HubSkillBackend> = {};
	if (opts.memoryNamespace && opts.store)
		routes["/memories/"] = new StoreBackend({
			store: opts.store,
			namespace: [...opts.memoryNamespace],
		});
	const index = (opts.sourceContext?.governingIndex ?? []).filter(
		(entry) =>
			allowedTools.has("core__knowledge_read") &&
			readTools.has("core__knowledge_read") &&
			(opts.profile?.skillIds.includes(entry.id) ?? true) &&
			/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id),
	);
	routes["/skills/"] = new HubSkillBackend(
		index.map((entry) => entry.id),
		opts.readSkill ??
			(async () => {
				throw new Error("skill_source_unavailable");
			}),
		() => {
			opts.onSkillReadFailure?.();
		},
	);
	const backend = new CompositeBackend(new StateBackend(), routes);
	const guidanceIndex = JSON.stringify(index);
	if (
		index.length > 50 ||
		new TextEncoder().encode(guidanceIndex).length > 16_384
	)
		throw new Error("cogni_guidance_index_exceeds_limit");
	return createDeepAgent({
		name: "cogni",
		model,
		tools: [...tools, ...(opts.guardedTools ?? [])],
		systemPrompt: composeCogniPrompt(
			opts.profile?.instructions ?? opts.systemPrompt,
			opts.sourceContext?.mission,
		),
		subagents: children,
		skills: ["/skills/"],
		...(opts.disableCheckpointer
			? { checkpointer: false }
			: opts.checkpointer
				? { checkpointer: opts.checkpointer }
				: {}),
		...(opts.store ? { store: opts.store } : {}),
		backend,
		middleware: [
			createMiddleware({
				name: "CogniAuthorizedSkills",
				stateSchema: new StateSchema({ skillsMetadata: skillsMetadataValue }),
				beforeAgent: () => ({
					skillsMetadata: index.map((entry) => ({
						name: entry.id,
						description: entry.useWhen,
						path: `/skills/${entry.id}/SKILL.md`,
					})),
				}),
			}),
			modelRetryMiddleware({
				maxRetries: 2,
				retryOn: (error) => {
					// LangChain wraps errors at each middleware boundary.
					let current: unknown = error;
					while (MiddlewareError.isInstance(current) && "cause" in current)
						current = current.cause;
					return (
						current instanceof InvalidCompletionError ||
						(isAiExecutionError(current) &&
							(current.code === "timeout" || current.code === "rate_limit"))
					);
				},
				initialDelayMs: 250,
				maxDelayMs: 1000,
				onFailure: "error",
			}),
			createMiddleware({
				name: "CogniSourceContext",
				beforeAgent: () => {
					if (
						opts.program &&
						(!opts.sourceContext?.nodeId ||
							!opts.sourceContext.origin ||
							!opts.sourceContext.mission?.content.trim())
					) {
						throw new Error("node_source_identity_unavailable");
					}
				},
			}),
			...(opts.program
				? [
						createMiddleware({
							name: "CogniHostClock",
							wrapModelCall: (request, handler) =>
								handler({
									...request,
									systemMessage: request.systemMessage.concat(
										new SystemMessage({
											content: hostClockPrompt(new Date().toISOString()),
										}),
									),
								}),
						}),
					]
				: []),
			...(!children.length
				? [
						createMiddleware({
							name: "CogniLeafTools",
							wrapModelCall: (request, handler) =>
								handler({
									...request,
									tools: request.tools.filter(
										(tool) => !("name" in tool) || tool.name !== "task",
									),
								}),
						}),
					]
				: []),
			toolCallLimitMiddleware({
				toolName: "task",
				runLimit: children.length
					? Math.min(4, opts.profile?.limits.maxTaskCalls ?? 4)
					: 0,
				exitBehavior: "error",
			}),
			createMiddleware({
				name: "CogniChildOutputLimit",
				wrapToolCall: async (request, handler) => {
					const result = await handler(request);
					if (request.toolCall.name === "task") {
						const update =
							result instanceof Command ? result.update : undefined;
						const messages =
							update && !Array.isArray(update) ? update.messages : undefined;
						const outputs =
							result instanceof ToolMessage
								? [result]
								: Array.isArray(messages)
									? messages
									: [];
						if (
							outputs.some(
								(message) =>
									message instanceof ToolMessage &&
									new TextEncoder().encode(JSON.stringify(message.content))
										.length > 16_384,
							)
						)
							throw new Error("cogni_child_output_exceeds_limit");
					}
					return result;
				},
			}),
			todoListMiddleware(),
			createSubAgentMiddleware({
				defaultModel: model,
				defaultTools: [],
				generalPurposeAgent: false,
				subagents: children,
			}),
			createSummarizationMiddleware({
				model,
				backend,
				trigger: { type: "tokens", value: 24_000 },
				keep: { type: "messages", value: 12 },
			}),
		],
	});
}

export const createCogniGraph = createCogniProgram;
