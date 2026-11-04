// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/inproc/runner`
 * Purpose: Contract tests for createInProcGraphRunner terminal invariants.
 * Scope: Verifies AiEvent sequence correctness (assistant_final, done, error) NOT exact token sequences.
 * Invariants:
 *   - ASSISTANT_FINAL_REQUIRED: exactly one on success; zero on error/abort
 *   - GRAPH_FINALIZATION_ONCE: exactly one done per run, always last
 *   - RESULT_REFLECTS_OUTCOME: final.ok matches stream outcome
 * Side-effects: none (all mocked)
 * Links: LANGGRAPH_AI.md, runner.ts
 * @internal
 */

import { AiExecutionError, type AiEvent, LlmError } from "@cogni/ai-core";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { MiddlewareError } from "langchain";
import { describe, expect, it } from "vitest";

import { CogniCompletionAdapter, InvalidCompletionError } from "../../src/runtime/cogni/completion-adapter";
import { runWithCogniExecContext } from "../../src/runtime/cogni/exec-context";
import { fromBaseMessage } from "../../src/runtime/core/message-converters";
import { createInProcGraphRunner } from "../../src/inproc/runner";
import type {
  CompletionFn,
  CompletionResult,
  CreateGraphFn,
  InProcGraphRequest,
  ToolExecFn,
} from "../../src/inproc/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all events from stream into array.
 */
async function collectEvents(
  stream: AsyncIterable<AiEvent>
): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/**
 * Create a fake CompletionFn that returns controlled results.
 */
function createFakeCompletionFn(options: {
  content?: string;
  shouldThrow?: boolean;
  errorMessage?: string;
}): CompletionFn {
  return () => {
    const stream = (async function* (): AsyncIterable<AiEvent> {
      if (!options.shouldThrow) {
        yield { type: "text_delta", delta: options.content ?? "test" };
      }
    })();

    const final: Promise<CompletionResult> = options.shouldThrow
      ? Promise.reject(new Error(options.errorMessage ?? "Completion failed"))
      : Promise.resolve({
          ok: true,
          content: options.content ?? "test",
          usage: { promptTokens: 10, completionTokens: 5 },
          finishReason: "stop",
        });

    return { stream, final };
  };
}

/**
 * Create a fake graph factory that returns a minimal invokable graph.
 */
function createFakeGraphFactory(options: {
  shouldThrow?: boolean;
  errorMessage?: string;
  throwAbortError?: boolean;
}): CreateGraphFn {
  return () => ({
    invoke: async (
      _input: unknown,
      invokeOptions?: { signal?: AbortSignal }
    ) => {
      // Check abort signal
      if (invokeOptions?.signal?.aborted) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        throw error;
      }

      if (options.throwAbortError) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        throw error;
      }

      if (options.shouldThrow) {
        throw new Error(options.errorMessage ?? "Graph execution failed");
      }

      // Return minimal result with assistant message
      return {
        messages: [new AIMessage({ content: "Assistant response" })],
      };
    },
  });
}

/**
 * Create minimal runner options for testing.
 */
function createTestRunnerOptions(overrides?: {
  createGraph?: CreateGraphFn;
  completionFn?: CompletionFn;
}): Parameters<typeof createInProcGraphRunner>[0] {
  const request: InProcGraphRequest = {
    runId: "test-run-id",
    messages: [{ role: "user", content: "Hello" }],
    // Per UNIFIED_INVOKE_SIGNATURE: model + toolIds in configurable
    configurable: { model: "test-model" },
  };

  return {
    createGraph: overrides?.createGraph ?? createFakeGraphFactory({}),
    completionFn: overrides?.completionFn ?? createFakeCompletionFn({}),
    createToolExecFn: (): ToolExecFn => async () => ({ ok: true, value: {} }),
    toolContracts: [],
    request,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("deadline attribution", () => {
  it.each([
    [new AiExecutionError("timeout"), "timeout"],
    [new DOMException("cancelled", "AbortError"), "aborted"],
  ])("emits matching error and final for %s", async (reason, code) => {
    const ctl = new AbortController();
    ctl.abort(reason);
    const opts = createTestRunnerOptions();
    const { stream, final } = createInProcGraphRunner({
      ...opts, request: { ...opts.request, abortSignal: ctl.signal },
    });
    expect(await collectEvents(stream)).toEqual([
      { type: "error", error: code }, { type: "done" },
    ]);
    expect(await final).toMatchObject({ ok: false, error: code });
  });

  it.each(["caller", "deadline"])('preserves first signal when %s aborts first', async (first) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const signal = AbortSignal.any([caller.signal, deadline.signal]);
    if (first === "caller") {
      caller.abort();
      deadline.abort(new AiExecutionError("timeout"));
    } else {
      deadline.abort(new AiExecutionError("timeout"));
      caller.abort();
    }
    const opts = createTestRunnerOptions();
    const { stream, final } = createInProcGraphRunner({ ...opts, request: { ...opts.request, abortSignal: signal } });
    const code = first === "caller" ? "aborted" : "timeout";
    expect(await collectEvents(stream)).toEqual([{ type: "error", error: code }, { type: "done" }]);
    expect(await final).toMatchObject({ ok: false, error: code });
  });

  it.each(["timeout", "rate_limit", "provider_unavailable"] as const)(
    "preserves wrapped %s in terminal event and final", async (code) => {
      const opts = createTestRunnerOptions({ createGraph: () => ({
        invoke: async () => { throw MiddlewareError.wrap(new AiExecutionError(code), "test"); },
      }) });
      const { stream, final } = createInProcGraphRunner(opts);
      expect(await collectEvents(stream)).toEqual([{ type: "error", error: code }, { type: "done" }]);
      expect(await final).toMatchObject({ ok: false, error: code });
    },
  );

  it("preserves a wrapped provider failure classification", async () => {
    const providerError = new LlmError("upstream failed", "provider_5xx", 503);
    const opts = createTestRunnerOptions({ createGraph: () => ({
      invoke: async () => { throw MiddlewareError.wrap(providerError, "test"); },
    }) });
    const run = createInProcGraphRunner(opts);
    expect(await collectEvents(run.stream)).toEqual([{ type: "error", error: "provider_unavailable" }, { type: "done" }]);
    expect(await run.final).toMatchObject({ ok: false, error: "provider_unavailable" });
  });

  it("does not unwrap an unrelated error cause", async () => {
    const opts = createTestRunnerOptions({ createGraph: () => ({
      invoke: async () => { throw new Error("bug", { cause: new AiExecutionError("timeout") }); },
    }) });
    const run = createInProcGraphRunner(opts);
    expect(await collectEvents(run.stream)).toEqual([{ type: "error", error: "internal" }, { type: "done" }]);
    expect(await run.final).toMatchObject({ ok: false, error: "internal" });
  });

  it("attributes wrapped causal cancellation to the deadline", async () => {
    const ctl = new AbortController();
    const reason = new AiExecutionError("timeout");
    const opts = createTestRunnerOptions({ createGraph: () => ({
      invoke: async () => { ctl.abort(reason); throw MiddlewareError.wrap(reason, "test"); },
    }) });
    const run = createInProcGraphRunner({ ...opts, request: { ...opts.request, abortSignal: ctl.signal } });
    expect(await collectEvents(run.stream)).toEqual([{ type: "error", error: "timeout" }, { type: "done" }]);
    expect(await run.final).toMatchObject({ ok: false, error: "timeout" });
  });

  it("does not mask a programming error racing an abort", async () => {
    const ctl = new AbortController();
    const opts = createTestRunnerOptions({ createGraph: () => ({
      invoke: async () => { ctl.abort(new AiExecutionError("timeout")); throw new Error("bug"); },
    }) });
    const { stream, final } = createInProcGraphRunner({
      ...opts, request: { ...opts.request, abortSignal: ctl.signal },
    });
    expect(await collectEvents(stream)).toEqual([
      { type: "error", error: "internal" }, { type: "done" },
    ]);
    expect(await final).toMatchObject({ ok: false, error: "internal" });
  });
});

describe("createInProcGraphRunner", () => {
  describe("success path", () => {
    it("emits exactly one assistant_final, done is last, final.ok is true", async () => {
      const opts = createTestRunnerOptions();
      const { stream, final } = createInProcGraphRunner(opts);

      const events = await collectEvents(stream);
      const result = await final;

      // Terminal invariants
      const assistantFinals = events.filter(
        (e) => e.type === "assistant_final"
      );
      const dones = events.filter((e) => e.type === "done");
      const errors = events.filter((e) => e.type === "error");

      expect(assistantFinals).toHaveLength(1);
      expect(dones).toHaveLength(1);
      expect(errors).toHaveLength(0);

      // done must be last
      expect(events[events.length - 1]).toEqual({ type: "done" });

      // assistant_final must precede done
      const assistantFinalIndex = events.findIndex(
        (e) => e.type === "assistant_final"
      );
      const doneIndex = events.findIndex((e) => e.type === "done");
      expect(assistantFinalIndex).toBeLessThan(doneIndex);

      // final reflects success
      expect(result.ok).toBe(true);
    });
  });

  describe("error path", () => {
    it("emits error then done, never assistant_final, final.ok is false", async () => {
      const opts = createTestRunnerOptions({
        createGraph: createFakeGraphFactory({
          shouldThrow: true,
          errorMessage: "Graph failed",
        }),
      });
      const { stream, final } = createInProcGraphRunner(opts);

      const events = await collectEvents(stream);
      const result = await final;

      // Terminal invariants
      const assistantFinals = events.filter(
        (e) => e.type === "assistant_final"
      );
      const dones = events.filter((e) => e.type === "done");
      const errors = events.filter((e) => e.type === "error");

      expect(assistantFinals).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(dones).toHaveLength(1);

      // done must be last
      expect(events[events.length - 1]).toEqual({ type: "done" });

      // error must precede done
      const errorIndex = events.findIndex((e) => e.type === "error");
      const doneIndex = events.findIndex((e) => e.type === "done");
      expect(errorIndex).toBeLessThan(doneIndex);

      // error should be normalized to 'internal'
      expect(errors[0]).toEqual({ type: "error", error: "internal" });

      // final reflects failure
      expect(result.ok).toBe(false);
      expect(result.error).toBe("internal");
    });
  });

  describe("abort path", () => {
    it("propagates abort signal, emits error=aborted then done", async () => {
      const opts = createTestRunnerOptions({
        createGraph: createFakeGraphFactory({ throwAbortError: true }),
      });
      const { stream, final } = createInProcGraphRunner(opts);

      const events = await collectEvents(stream);
      const result = await final;

      // Terminal invariants
      const assistantFinals = events.filter(
        (e) => e.type === "assistant_final"
      );
      const dones = events.filter((e) => e.type === "done");
      const errors = events.filter((e) => e.type === "error");

      expect(assistantFinals).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(dones).toHaveLength(1);

      // done must be last
      expect(events[events.length - 1]).toEqual({ type: "done" });

      // error should be 'aborted'
      expect(errors[0]).toEqual({ type: "error", error: "aborted" });

      // final reflects abort
      expect(result.ok).toBe(false);
      expect(result.error).toBe("aborted");
    });
  });

  describe("terminal integrity (REQ2)", () => {
    it("never emits more than one terminal event type", async () => {
      // Test success path - should have exactly one assistant_final, one done
      const successOpts = createTestRunnerOptions();
      const successResult = createInProcGraphRunner(successOpts);
      const successEvents = await collectEvents(successResult.stream);

      const successTerminals = successEvents.filter(
        (e) =>
          e.type === "assistant_final" ||
          e.type === "error" ||
          e.type === "done"
      );

      // Should have exactly: assistant_final + done (2 terminals)
      expect(successTerminals).toHaveLength(2);
      expect(
        successTerminals.filter((e) => e.type === "assistant_final")
      ).toHaveLength(1);
      expect(successTerminals.filter((e) => e.type === "done")).toHaveLength(1);
      expect(successTerminals.filter((e) => e.type === "error")).toHaveLength(
        0
      );

      // Test error path - should have exactly one error, one done
      const errorOpts = createTestRunnerOptions({
        createGraph: createFakeGraphFactory({ shouldThrow: true }),
      });
      const errorResult = createInProcGraphRunner(errorOpts);
      const errorEvents = await collectEvents(errorResult.stream);

      const errorTerminals = errorEvents.filter(
        (e) =>
          e.type === "assistant_final" ||
          e.type === "error" ||
          e.type === "done"
      );

      // Should have exactly: error + done (2 terminals)
      expect(errorTerminals).toHaveLength(2);
      expect(
        errorTerminals.filter((e) => e.type === "assistant_final")
      ).toHaveLength(0);
      expect(errorTerminals.filter((e) => e.type === "done")).toHaveLength(1);
      expect(errorTerminals.filter((e) => e.type === "error")).toHaveLength(1);

      // Verify mutual exclusivity: never both assistant_final AND error
      const hasAssistantFinal = successEvents.some(
        (e) => e.type === "assistant_final"
      );
      const hasError = successEvents.some((e) => e.type === "error");
      expect(hasAssistantFinal && hasError).toBe(false);
    });
  });
});

describe("billed runtime IO controls", () => {
  it("preserves text blocks and tool identity across supported roles", () => {
    const content = [{ type: "text" as const, text: "first " }, { type: "text" as const, text: "second" }];
    const messages = [
      new HumanMessage({ content }), new SystemMessage({ content }),
      new AIMessage({ content }), new ToolMessage({ content, tool_call_id: "result" }),
    ];
    expect(messages.map((message) => fromBaseMessage(message).content)).toEqual(
      ["first second", "first second", "first second", "first second"],
    );
    expect(fromBaseMessage(new ToolMessage({ content, tool_call_id: "result" }))).toMatchObject({ role: "tool", toolCallId: "result" });
  });

  it("keeps tier siblings immutable while preserving billed invocation context", async () => {
    const requests: Parameters<CompletionFn>[0][] = [];
    const signal = new AbortController().signal;
    const completionFn: CompletionFn = (request) => {
      requests.push(request);
      return { stream: (async function* () {})(), final: Promise.resolve({ ok: true, content: "answer" }) };
    };
    const parent = new CogniCompletionAdapter().bindRun("main", signal);
    const sibling = parent.withModel("flash");
    const config = { configurable: { model: "main", toolIds: ["allowed"] } };
    await runWithCogniExecContext({
      completionFn, tokenSink: { push() {} }, toolExecFn: async () => ({ ok: true, value: {} }),
    }, async () => {
      await sibling.invoke([new HumanMessage("hello")], config);
      await parent.invoke([new HumanMessage("hello")], config);
    });
    expect(requests.map((request) => request.model)).toEqual(["flash", "main"]);
    expect(requests.map((request) => request.abortSignal)).toEqual([signal, signal]);
    expect(config.configurable).toEqual({ model: "main", toolIds: ["allowed"] });
    await expect(parent.invoke([new HumanMessage("hello")], { configurable: { model: "flash" } })).rejects.toThrow("bound_model_mismatch");
  });

  it("rejects malformed provider arguments with a typed causal error", async () => {
    const model = new CogniCompletionAdapter().bindRun("main");
    const completionFn: CompletionFn = () => ({
      stream: (async function* () {})(),
      final: Promise.resolve({ ok: true, toolCalls: [{
        id: "broken", type: "function", function: { name: "lookup", arguments: '{"id":}' },
      }] }),
    });
    const invoke = runWithCogniExecContext({
      completionFn, tokenSink: { push() {} }, toolExecFn: async () => ({ ok: true, value: {} }),
    }, () => model.invoke([new HumanMessage("hello")]));
    await expect(invoke).rejects.toBeInstanceOf(InvalidCompletionError);
    await expect(invoke).rejects.toMatchObject({ message: "malformed_tool_arguments", cause: expect.any(SyntaxError) });
  });

  it("does not bill a completion after cancellation", async () => {
    const ctl = new AbortController();
    const reason = new Error("cancelled");
    ctl.abort(reason);
    let calls = 0;
    const completionFn: CompletionFn = () => { calls++; throw new Error("unexpected completion"); };
    await expect(runWithCogniExecContext({
      completionFn, tokenSink: { push() {} }, toolExecFn: async () => ({ ok: true, value: {} }),
    }, () => new CogniCompletionAdapter().bindRun("main", ctl.signal).invoke([new HumanMessage("hello")]))).rejects.toBe(reason);
    expect(calls).toBe(0);
  });
});
