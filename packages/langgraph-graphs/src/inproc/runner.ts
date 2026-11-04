// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/runner`
 * Purpose: InProc graph execution runner for Next.js server runtime.
 * Scope: Creates queue, wires dependencies, executes graph via ALS context, emits events. Does NOT import from src/.
 * Invariants:
 *   - SINGLE_QUEUE_PER_RUN: Runner creates queue, passes emit to createToolExecFn
 *   - RUNTIME_CONTEXT_VIA_ALS: Sets up ALS context (completionFn, tokenSink, toolExecFn) before graph invocation
 *   - NO_MODEL_IN_ALS (#35): Model comes from configurable.model, never ALS
 *   - ASSISTANT_FINAL_REQUIRED: Emits exactly one assistant_final event on success; none on error
 *   - NO_AWAIT_IN_TOKEN_PATH: tokenSink.push() is synchronous
 *   - RESULT_REFLECTS_OUTCOME: final.ok matches stream success/failure
 *   - ERROR_NORMALIZATION_ONCE: Catch block uses normalizeErrorToExecutionCode()
 *   - USAGE_AGGREGATION_PER_RUN: Usage aggregated from usage_report events, not LLM instance
 * Side-effects: IO (executes graph, emits events)
 * Links: LANGGRAPH_AI.md, ERROR_HANDLING_ARCHITECTURE.md, GRAPH_EXECUTION.md
 * @public
 */

import { createHash } from "node:crypto";
import {
  type AiEvent,
  isAiExecutionError,
  normalizeErrorToExecutionCode,
  type ToolSpec,
} from "@cogni/ai-core";
import type { BaseMessage } from "@langchain/core/messages";
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { MiddlewareError } from "langchain";
import { z } from "zod";

import {
  CogniCompletionAdapter,
  type CompletionFn,
  runWithCogniExecContext,
} from "../runtime/cogni";
import {
  AsyncQueue,
  type ToolExecFn,
  toBaseMessage,
  toLangChainToolsCaptured,
} from "../runtime/core";

import type { GraphResult, InProcRunnerOptions } from "./types";

/**
 * Create LangChain tool wrappers from MCP ToolSpecs.
 * These delegate to toolExecFn which routes through toolRunner (policy, billing, redaction).
 */
function mcpSpecsToLangChainTools(
  specs: readonly ToolSpec[],
  toolExecFn: ToolExecFn,
): StructuredToolInterface[] {
  return specs.map(
    (spec) =>
      new DynamicStructuredTool({
        name: spec.name,
        description: spec.description,
        // Passthrough schema — MCP tools validate internally via BoundToolRuntime
        schema: z.record(z.unknown()),
        func: async (args: Record<string, unknown>): Promise<string> => {
          const result = await toolExecFn(spec.name, args, undefined);
          if (!result.ok) {
            return JSON.stringify({
              error: result.receipt?.code ?? result.errorCode,
              message: result.safeMessage,
              ...(result.receipt
                ? { retryable: false, lookup: result.receipt.lookup }
                : {}),
            });
          }
          return typeof result.value === "string"
            ? result.value
            : JSON.stringify(result.value);
        },
      }) as StructuredToolInterface,
  );
}

/**
 * Extract text content from final assistant message.
 * LangGraph returns messages array; last message is assistant response.
 */
function extractAssistantContent(messages: BaseMessage[]): string {
  if (messages.length === 0) return "";

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return "";

  if (typeof lastMessage.content === "string") {
    return lastMessage.content;
  }

  if (Array.isArray(lastMessage.content)) {
    return lastMessage.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text",
      )
      .map((part) => part.text)
      .join("");
  }

  return "";
}

/**
 * Create InProc graph runner.
 *
 * Generic runner that accepts a graph factory from the catalog.
 * All LangChain logic is contained here — callers don't need LangChain imports.
 *
 * Per SINGLE_QUEUE_PER_RUN: Runner creates queue internally.
 * Per RUNTIME_CONTEXT_VIA_ALS: Sets up ALS before graph invocation.
 * Per ASSISTANT_FINAL_REQUIRED: Emits exactly one assistant_final event.
 *
 * @param opts - Runner options including graph factory
 * @returns { stream, final } - AsyncIterable of events and Promise of result
 */
export function createInProcGraphRunner<TTool = unknown>(
  opts: InProcRunnerOptions<TTool>,
): {
  stream: AsyncIterable<AiEvent>;
  final: Promise<GraphResult>;
} {
  const {
    createGraph,
    completionFn,
    createToolExecFn,
    toolContracts,
    mcpToolSpecs,
    request,
    responseFormat,
    systemPrompt,
    persistence,
  } = opts;

  // Host-injected persistence or fresh per-run memory; no restart guarantee.
  const checkpointer = persistence?.checkpointer ?? new MemorySaver();
  const store = persistence?.store ?? new InMemoryStore();

  // SINGLE_QUEUE_PER_RUN: Runner creates queue, all events flow here
  const queue = new AsyncQueue<AiEvent>();

  // Per-run usage aggregation (concurrency-safe: one runner per run)
  // Accumulated from usage_report events, not LLM instance
  let collectedUsage: {
    promptTokens: number;
    completionTokens: number;
  } | null = null;

  const emit = (e: AiEvent): void => {
    // Aggregate usage from usage_report events (per USAGE_AGGREGATION_PER_RUN)
    if (e.type === "usage_report" && e.fact?.inputTokens !== undefined) {
      if (collectedUsage === null) {
        collectedUsage = { promptTokens: 0, completionTokens: 0 };
      }
      collectedUsage.promptTokens += e.fact.inputTokens ?? 0;
      collectedUsage.completionTokens += e.fact.outputTokens ?? 0;
    }
    queue.push(e);
  };

  const tokenSink = {
    push: (event: AiEvent) => {
      if (
        !(opts.program || opts.trustedProgramId) ||
        event.type !== "text_delta"
      )
        emit(event);
    },
  };
  const executeTool = createToolExecFn(emit);
  const hooks = createGraph.createRunHooks?.({
    program: opts.program,
    origin: opts.sourceContext?.origin,
  });
  const toolExecFn: ToolExecFn = async (name, args, toolCallId) => {
    const result = await executeTool(name, args, toolCallId);
    hooks?.observeTool?.(name, args, result, toolCallId);
    return result;
  };
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const memoryNamespace =
    opts.sourceContext?.nodeId && opts.trustedActorId && opts.trustedProgramId
      ? [
          "cogni",
          "v1",
          hash(opts.sourceContext.nodeId),
          hash(opts.trustedActorId),
          hash(opts.trustedProgramId),
          "working",
        ]
      : undefined;
  const identityParts = [
    opts.sourceContext?.nodeId,
    opts.trustedActorId,
    opts.trustedProgramId,
    request.runId,
  ];
  if (
    opts.trustedProgramId &&
    persistence?.checkpointer &&
    identityParts.some((part) => !part)
  )
    throw new Error("cogni_trusted_identity_unavailable");
  const threadId = opts.trustedProgramId && persistence?.checkpointer
    ? `h1:${hash(identityParts.map((part) => `${Buffer.byteLength(part ?? "", "utf8")}:${part ?? ""}`).join(""))}`
    : request.configurable.graphId != null
      ? `${request.configurable.graphId}:${request.runId}`
      : request.runId;
  const readSkill = async (id: string) => {
    try {
      const result = await toolExecFn("core__knowledge_read", { id });
      if (!result.ok) throw new Error("skill_read_denied");
      const parsed = z
        .object({
          mode: z.literal("get"),
          entries: z.array(z.object({ id: z.string(), content: z.string() })),
        })
        .parse(result.value);
      const entry = parsed.entries.find((row) => row.id === id);
      if (!entry) throw new Error("skill_not_found");
      if (!entry.content.trim()) throw new Error("skill_body_empty");
      if (
        new TextEncoder().encode(entry.content).length > 65_000 ||
        entry.content.split("\n").length > 490
      )
        throw new Error("skill_body_exceeds_limit");
      return entry.content;
    } catch (error) {
      hooks?.onSkillReadFailure?.();
      throw error;
    }
  };

  // Create no-arg CogniCompletionAdapter (reads from ALS + configurable at invoke time)
  const runSignal = request.abortSignal;
  const llm = new CogniCompletionAdapter().bindRun(
    request.configurable.model,
    runSignal,
    !!opts.program,
  );

  // Use toLangChainToolsCaptured since runner provides toolExecFn directly (not from ALS)
  const contractTools = toLangChainToolsCaptured({
    contracts: toolContracts,
    toolExecFn,
  });

  // Merge MCP tool wrappers (delegate to same toolExecFn → toolRunner pipeline)
  const mcpTools =
    mcpToolSpecs && mcpToolSpecs.length > 0
      ? mcpSpecsToLangChainTools(mcpToolSpecs, toolExecFn)
      : [];
  const tools =
    mcpTools.length > 0 ? [...contractTools, ...mcpTools] : contractTools;

  // Use factory from catalog instead of hardcoded graph
  const graph = createGraph({
    ...hooks?.graphOptions,
    onSkillReadFailure: hooks?.onSkillReadFailure,
    readToolIds: toolContracts
      .filter((contract) => contract.effect === "read_only")
      .map((contract) => contract.name),
    tierModels: { main: llm,
      ...Object.fromEntries(
        Object.entries(createGraph.tierModelIds ?? {}).map(([tier, model]) => [
          tier,
          llm.withModel(model),
        ]),
      ),
    },
    ...(memoryNamespace ? { memoryNamespace } : {}),
    readSkill,
    ...(opts.sourceContext !== undefined && {
      sourceContext: opts.sourceContext,
    }),
    ...(opts.program !== undefined && { program: opts.program }),
    ...(opts.requestIntent !== undefined && {
      requestIntent: opts.requestIntent,
    }),
    llm,
    tools,
    ...(responseFormat !== undefined && { responseFormat }),
    ...(systemPrompt !== undefined && { systemPrompt }),
    // Persistence foundation: factories that support it (cogni) compile with these; others ignore.
    checkpointer,
    store,
  });

  const final = (async (): Promise<GraphResult> => {
    try {
      const messages = request.messages.map(toBaseMessage);

      // Set up ALS context and invoke graph
      // Per #35 NO_MODEL_IN_ALS: model comes from configurable, not ALS
      // Per #36 ALS_ONLY_FOR_NON_SERIALIZABLE_DEPS: ALS holds only completionFn, tokenSink, toolExecFn
      const invoke = async () => {
        if (opts.trustedProgramId && persistence?.checkpointer) {
          const existing = await checkpointer.get({
            configurable: { thread_id: threadId },
          });
          if (existing) throw new Error("checkpoint_recovery_required");
        }
        if (opts.program || opts.trustedProgramId) {
          runSignal?.throwIfAborted();
          emit({ type: "status", phase: "thinking" });
        }
        return runWithCogniExecContext(
          {
            completionFn: completionFn as CompletionFn<unknown>,
            tokenSink,
            toolExecFn,
          },
          () =>
            graph.invoke(
              { messages },
              {
                signal: runSignal,
                metadata: { cogniRunId: request.runId },
                // STABLE_THREAD_ID: a checkpointer-compiled graph requires a thread_id. One run = one
                // thread; same-run checkpoints require explicit recovery. Cross-run working
                // memory lives in the Store, not the checkpointer.
                configurable: {
                  ...request.configurable,
                  thread_id: threadId,
                },
                // A BACKSTOP against an infinite graph, never the real work bound — each
                // graph self-limits (e.g. cogni's MAX_INVESTIGATE_STEPS). Must exceed any
                // graph's budget: a gather round is 2 node visits, so this clears 2×the
                // largest step cap with margin. Raise it with the caps, never below them.
                recursionLimit: 100,
              },
            ),
        );
      };
      const result = await invoke();

      const assistantContent = extractAssistantContent(result.messages);

      // Extract structured response if present (from responseFormat graphs)
      const structuredOutput =
        hooks?.projectOutput?.(assistantContent) ??
        (result.structuredResponse !== undefined
          ? (result.structuredResponse as Record<string, unknown>)
          : undefined);

      // Harness model calls include internal child and summary text; only emit the final answer.
      if ((opts.program || opts.trustedProgramId) && assistantContent)
        emit({ type: "text_delta", delta: assistantContent });
      // ASSISTANT_FINAL_REQUIRED: exactly one per run
      emit({ type: "assistant_final", content: assistantContent });
      emit({ type: "done" });

      // Omit usage when null (never default to zeros)
      // Per USAGE_AGGREGATION_PER_RUN: usage aggregated from usage_report events
      return {
        ok: true,
        finishReason: "stop",
        content: assistantContent,
        ...(collectedUsage !== null && { usage: collectedUsage }),
        ...(structuredOutput !== undefined && { structuredOutput }),
      };
    } catch (error) {
      // Normalize error using duck-typed LlmError detection (kind/status properties)
      // Per ERROR_NORMALIZATION_ONCE: normalize at catch boundary
      // LangChain 1.4.4 brands the class statically; retain instanceof for local wrappers.
      // Only middleware wrappers may be unwrapped, never arbitrary application causes.
      let cause: unknown = error;
      while (
        (MiddlewareError.isInstance(cause) || cause instanceof MiddlewareError) &&
        "cause" in cause &&
        cause.cause !== undefined &&
        cause.cause !== cause
      ) {
        cause = cause.cause;
      }
      const signal = request.abortSignal;
      const cancelled =
        cause === signal?.reason ||
        (cause instanceof Error && cause.name === "AbortError") ||
        (isAiExecutionError(cause) && cause.code === "aborted");
      const code =
        signal?.aborted && cancelled
          ? isAiExecutionError(signal.reason) && signal.reason.code === "timeout"
            ? "timeout"
            : "aborted"
          : normalizeErrorToExecutionCode(cause);

      // Capture error message for logging at adapter boundary (not sent to clients)
      const errorMessage =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);

      // Per ERROR_NORMALIZATION: emit code only, not message
      emit({ type: "error", error: code });
      // Per GRAPH_FINALIZATION_ONCE: always emit done as final event
      emit({ type: "done" });

      return { ok: false, error: code, errorMessage };
    } finally {
      queue.close();
    }
  })();

  return { stream: queue, final };
}
