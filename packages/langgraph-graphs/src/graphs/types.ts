// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/types`
 * Purpose: Shared graph type definitions for all LangGraph agents.
 * Scope: Type firewall for LangGraph generics. Does NOT implement graph logic.
 * Invariants:
 *   - SINGLE_INVOKABLE_INTERFACE: All graphs implement InvokableGraph<I,O>
 *   - LANGCHAIN_ALIGNED: Uses RunnableConfig/RunnableInterface from @langchain/core
 * Side-effects: none
 * Links: LANGGRAPH_AI.md, AGENT_DEVELOPMENT_GUIDE.md
 * @public
 */

import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  RunnableConfig,
  RunnableInterface,
} from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";

/**
 * Options for graph invocation.
 * Alias to Partial<RunnableConfig> matching RunnableInterface.invoke() signature.
 *
 * Includes: signal, configurable, metadata, tags, callbacks, runId, timeout, etc.
 */
export type GraphInvokeOptions = Partial<RunnableConfig>;

/**
 * Generic invokable graph interface.
 * Type firewall: exposes only invoke() from RunnableInterface.
 *
 * @typeParam I - Input type (e.g., { messages: BaseMessage[] })
 * @typeParam O - Output type (e.g., { messages: BaseMessage[] })
 */
export type InvokableGraph<I, O> = Pick<RunnableInterface<I, O>, "invoke">;

/**
 * Standard input/output types for message-based graphs.
 * NOTE: Mutable arrays to align with LangGraph's UpdateType expectations.
 * Immutability should be enforced at runtime after validation, not in boundary types.
 */
export type MessageGraphInput = { messages: BaseMessage[] };
export type MessageGraphOutput = { messages: BaseMessage[] };

/**
 * Base options for React agent graph factories.
 * Extend per-graph when additional dependencies are needed.
 */
export interface CreateReactAgentGraphOptions {
  /** Current-run observations created only from successful host tool executions. */
  readonly programState?: unknown;
  readonly onSkillReadFailure?: () => void;
  /** Trusted host graph selection, never model-configurable. */
  readonly requestIntent?: "answer" | "decide";
  readonly memoryNamespace?: readonly string[];
  readonly readSkill?: (id: string) => Promise<string>;
  readonly tierModels?: Readonly<Record<string, LanguageModelLike>>;
  /** Read-only tool ids classified by the trusted host's contracts. */
  readonly readToolIds?: readonly string[];
  /** Host-bound source provenance, never accepted from model/tool arguments. */
  readonly sourceContext?: {
    readonly nodeId: string;
    readonly origin?: string;
    readonly mission?: {
      readonly content: string;
      readonly sourceRef: string;
      readonly buildSha: string | null;
    };
    /**
     * Host-owned governing index (same `listGoverningIndex` the cognition bundle renders):
     * id · domain · entryType · useWhen metadata held in context so an agent selects its
     * guidance and reads each body on demand (guidance-routing-design progressive disclosure).
     */
    readonly governingIndex?: ReadonlyArray<{
      readonly id: string;
      readonly domain: string;
      readonly entryType: string;
      readonly useWhen: string;
    }>;
  };
  /** Trusted catalog assignment; never supplied by model/tool content. */
  readonly program?: "cogni" | "work-review" | "cogni-chat" | "cogni-decide";
  /** LLM instance - LanguageModelLike to match createReactAgent expectation */
  readonly llm: LanguageModelLike;
  /** Tools wrapped via toLangChainTools() */
  readonly tools: ReadonlyArray<StructuredToolInterface>;
  /** Optional structured output format. When set, graph returns `structuredResponse`. */
  readonly responseFormat?: {
    readonly prompt?: string;
    readonly schema: unknown;
  };
  /** Optional system prompt override. Used by mission-engine graphs that are configured via catalog. */
  readonly systemPrompt?: string;
  /** Host-owned saver and store. In-memory data is process-lifetime only; a checkpoint does not imply safe automatic resume or side-effect replay. */
  readonly checkpointer?: BaseCheckpointSaver;
  readonly store?: BaseStore;
}
