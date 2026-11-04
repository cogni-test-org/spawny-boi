// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.completions.endpoint-parity`
 * Purpose: Verify POST /v1/chat/completions route handler produces OpenAI-compatible responses.
 * Scope: Tests the actual route handler with mocked deps to ensure responses match what an OpenAI SDK client expects. Does not test real LLM calls.
 * Invariants:
 *   - Non-streaming response matches OpenAI ChatCompletion shape (id, object, choices, usage)
 *   - Streaming response uses SSE with data: {json}\n\n format and data: [DONE]\n\n terminator
 *   - Error responses use OpenAI error format: { error: { message, type, param, code } }
 *   - All responses parseable by chatCompletionsContract schemas
 * Side-effects: none
 * Links: ai.completions.v1.contract, route.ts, OpenAI API reference
 * @public
 */

import { chatCompletionsContract } from "@cogni/node-contracts";
import { ChatErrorCode, ChatValidationError } from "@cogni/node-shared";
import {
  createCompletionRequest,
  createMockAccountServiceWithDefaults,
  FakeAiTelemetryAdapter,
  FakeClock,
  TEST_SESSION_USER_1,
} from "@tests/_fakes";
import { TEST_MODEL_ID } from "@tests/_fakes/ai/fakes";
import {
  createExecutionRequestPortMock,
  createRunStreamMock,
  createTemporalClientMock,
} from "@tests/_fixtures/ai/completion-facade-setup";
import { NextRequest } from "next/server";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "@/ports";
import { makeNoopLogger } from "@/shared/observability";

// Mock auth
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

// Mock bootstrap container (getContainer needed by wrapRouteHandlerWithLogging)
vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: vi.fn(),
  getTemporalWorkflowClient: vi.fn(),
  getContainer: vi.fn().mockReturnValue({
    config: { unhandledErrorPolicy: "throw" },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
    clock: { now: () => new Date("2025-01-15T12:00:00.000Z") },
    runStream: {
      subscribe: async function* () {
        yield {
          id: "1-0",
          event: { type: "text_delta" as const, delta: "hello" },
        };
        yield {
          id: "2-0",
          event: {
            type: "done" as const,
            usage: { promptTokens: 5, completionTokens: 10 },
            finishReason: "stop",
          },
        };
      },
    },
  }),
}));

// Mock preflight credit check
vi.mock("@/features/ai/public.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/features/ai/public.server")>();
  return {
    ...original,
    preflightCreditCheck: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/shared/config", () => ({
  getNodeId: () => "node_template",
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ AUTH_SECRET: "stable-completion-idempotency-secret" }),
}));

import { getSessionUser } from "@/app/_lib/auth/session";
import {
  getContainer,
  getTemporalWorkflowClient,
  resolveAiAdapterDeps,
} from "@/bootstrap/container";

const mockGetSessionUser = vi.mocked(getSessionUser);
const mockGetContainer = vi.mocked(getContainer);
const mockGetTemporalWorkflowClient = vi.mocked(getTemporalWorkflowClient);
const mockResolveAiAdapterDeps = vi.mocked(resolveAiAdapterDeps);

function setupMocks(
  options: {
    responseContent?: string;
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }>;
    statusEvents?: Array<{
      phase: "thinking" | "tool_use" | "compacting";
      label?: string;
    }>;
    finishReason?: string;
    errorEvent?: string;
  } = {}
) {
  const { responseContent = "Hello! How can I help you?" } = options;

  const fakeClock = new FakeClock("2025-01-15T12:00:00.000Z");
  const mockAccountService = createMockAccountServiceWithDefaults();
  const executionRequestPort = createExecutionRequestPortMock();
  const runStream = createRunStreamMock({
    responseContent,
    toolCalls: options.toolCalls,
    statusEvents: options.statusEvents,
    ...(options.errorEvent
      ? {}
      : {
          usageReport: {
            inputTokens: 15,
            outputTokens: 25,
            model: TEST_MODEL_ID,
          },
        }),
    ...(options.errorEvent ? { emitError: options.errorEvent } : {}),
  });
  const temporal = createTemporalClientMock();

  // Restore getContainer mock (reset by vi.resetAllMocks in beforeEach)
  mockGetContainer.mockReturnValue({
    config: { unhandledErrorPolicy: "throw" },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
    clock: fakeClock,
    executionRequestPort,
    runStream,
  } as never);
  mockGetTemporalWorkflowClient.mockResolvedValue(temporal as never);

  mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);

  mockResolveAiAdapterDeps.mockReturnValue({
    llmService: {} as never,
    accountService: mockAccountService,
    clock: fakeClock,
    aiTelemetry: new FakeAiTelemetryAdapter(),
    langfuse: undefined,
  });
  return { executionRequestPort, runStream, temporal };
}

function captureRequestLogs() {
  const lines: Array<Record<string, unknown>> = [];
  const log = pino({ base: { nodeId: "node-sentinel" } }, {
    write: (line: string) => { lines.push(JSON.parse(line)); },
  });
  Object.assign(mockGetContainer(), { log });
  return lines;
}

/**
 * Set up mocks where the workflow start throws a specific error.
 */
function setupMocksWithError(error: Error) {
  const fakeClock = new FakeClock("2025-01-15T12:00:00.000Z");
  const mockAccountService = createMockAccountServiceWithDefaults();

  mockGetContainer.mockReturnValue({
    config: { unhandledErrorPolicy: "throw" },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
    clock: fakeClock,
    executionRequestPort: createExecutionRequestPortMock(),
    runStream: createRunStreamMock({ responseContent: "" }),
  } as never);

  mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);

  mockResolveAiAdapterDeps.mockReturnValue({
    llmService: {} as never,
    accountService: mockAccountService,
    clock: fakeClock,
    aiTelemetry: new FakeAiTelemetryAdapter(),
    langfuse: undefined,
  });

  mockGetTemporalWorkflowClient.mockResolvedValue(
    createTemporalClientMock({
      start: vi.fn().mockRejectedValue(error),
    }) as never
  );
}

/**
 * Parse SSE stream into individual data payloads.
 */
async function parseSSE(
  response: Response
): Promise<{ chunks: unknown[]; rawLines: string[] }> {
  const text = await response.text();
  const rawLines = text.split("\n\n").filter((l) => l.startsWith("data: "));
  const chunks: unknown[] = [];

  for (const line of rawLines) {
    const data = line.replace("data: ", "");
    if (data === "[DONE]") continue;
    chunks.push(JSON.parse(data));
  }

  return { chunks, rawLines };
}

describe("OpenAI Endpoint Parity (POST /v1/chat/completions)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the prefetched raw iterator and settles final when aborted before first stream read", async () => {
    setupMocks();
    let returned = 0;
    const inputAbort = new AbortController();
    Object.assign(mockGetContainer(), { runStream: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: { id: "1", event: { type: "status", phase: "thinking" } } }),
        return: async () => { returned++; return { done: true, value: undefined }; },
      }) }),
    } });
    const { completionStream } = await import("@/app/_facades/ai/completion.server");
    const accepted = await completionStream({
      messages: [{ role: "user", content: "hello" }],
      modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
      sessionUser: TEST_SESSION_USER_1, graphName: "langgraph:default", abortSignal: inputAbort.signal,
    }, { log: makeNoopLogger(), reqId: "prefetch-race", traceId: "00000000000000000000000000000000", routeId: "chat.completions", clock: { now: () => "2025-01-01T00:00:00.000Z" } });
    inputAbort.abort();
    expect(returned).toBe(1);
    await expect(accepted.final).resolves.toMatchObject({ ok: false, error: "aborted" });
    await accepted.stream[Symbol.asyncIterator]().return?.();
    expect(returned).toBe(1);
  });

  describe("stream close evidence", () => {
    it("preserves the nonstreaming completion event", async () => {
      setupMocks();
      const lines = captureRequestLogs();
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST", body: JSON.stringify(createCompletionRequest({ stream: false })),
      }));
      expect(response.status).toBe(200);
      expect(lines.filter((line) => line.event === "ai.completion")).toHaveLength(1);
      expect(lines.filter((line) => line.event === "ai.chat_stream_closed")).toHaveLength(0);
    });

    it.each(["throw", "reject"] as const)("does not duplicate close if iterator return %ss", async (failure) => {
      setupMocks();
      const lines = captureRequestLogs();
      let count = 0;
      Object.assign(mockGetContainer(), { runStream: {
        subscribe: () => ({ [Symbol.asyncIterator]: () => ({
          next: async () => {
            const step = count++;
            return step === 0
              ? { done: false, value: { id: "1", event: { type: "status", phase: "thinking" } } }
              : step === 1
                ? { done: false, value: { id: "2", event: { type: "done", finishReason: "stop" } } }
                : { done: true, value: undefined };
          },
          return: () => { if (failure === "throw") throw new Error("private-return"); return Promise.reject(new Error("private-return")); },
        }) }),
      } });
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })),
      }));
      await response.text();
      expect(lines.filter((line) => line.event === "ai.chat_stream_closed")).toEqual([expect.objectContaining({ reason: "normal_complete" })]);
      expect(JSON.stringify(lines)).not.toContain("private-return");
    });

    it("maps malformed upstream errors to internal without logging their content", async () => {
      setupMocks();
      const lines = captureRequestLogs();
      const sentinel = "private-upstream-error-sentinel";
      Object.assign(mockGetContainer(), { runStream: {
        subscribe: async function* () {
          yield { id: "1", event: { type: "status" as const, phase: "thinking" as const } };
          yield { id: "2", event: { type: "error" as const, error: sentinel } };
        },
      } });
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })),
      }));
      const body = await response.text();
      expect(body).toContain('"code":"internal"');
      expect(body).not.toContain(sentinel);
      expect(lines.filter((line) => line.event === "ai.chat_stream_closed")).toEqual([
        expect.objectContaining({ reason: "backend_error", errorCode: "internal" }),
      ]);
      expect(JSON.stringify(lines)).not.toContain(sentinel);
    });

    it.each(["success", "backend-error", "relay-end", "relay-throw"] as const)(
      "records one private close within the real request log budget for %s", async (mode) => {
        setupMocks();
        const lines: Array<Record<string, unknown>> = [];
        const base = pino({ base: { nodeId: "node-sentinel" } }, {
          write: (line: string) => { lines.push(JSON.parse(line)); },
        });
        Object.assign(mockGetContainer(), { log: base, runStream: {
          subscribe: async function* () {
            yield { id: "1", event: { type: "status" as const, phase: "thinking" as const } };
            if (mode === "relay-throw") throw new Error("private-exception-sentinel");
            if (mode === "relay-end") return;
            if (mode === "backend-error") {
              yield { id: "2", event: { type: "error" as const, error: "timeout" as const } };
              return;
            }
            yield { id: "2", event: { type: "text_delta" as const, delta: "private-response-sentinel" } };
            yield { id: "3", event: { type: "done" as const, usage: { promptTokens: 2, completionTokens: 3 } } };
          },
        } });
        const { POST } = await import("@/app/api/v1/chat/completions/route");
        const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
          method: "POST", headers: { "x-request-id": "safe-request-id", "x-private": "private-header-sentinel" },
          body: JSON.stringify(createCompletionRequest({ stream: true, messages: [{ role: "user", content: "private-prompt-sentinel" }] })),
        }));
        const body = await response.text();
        const closes = lines.filter((line) => line.event === "ai.chat_stream_closed");
        expect(closes).toHaveLength(1);
        expect(closes[0]).toMatchObject({
          reqId: "safe-request-id", routeId: "chat.completions",
          userId: TEST_SESSION_USER_1.id, nodeId: "node-sentinel",
          reason: mode === "success" ? "normal_complete" : "backend_error",
          status: "local_closed", outcome: mode === "success" ? "success" : "error",
          ...(mode === "success" ? {} : { errorCode: mode === "backend-error" ? "timeout" : "internal" }),
        });
        expect(Object.keys(closes[0] ?? {}).sort()).toEqual([
          "durationMs", "event", "level", "method", "msg", "nodeId", "outcome",
          "reason", "reqId", "route", "routeId", "status", "time", "traceId", "userId",
          ...(mode === "success" ? [] : ["errorCode"]),
        ].sort());
        expect(closes[0]?.traceId).toEqual(expect.any(String));
        expect(closes[0]?.durationMs).toEqual(expect.any(Number));
        expect(lines.length).toBeLessThanOrEqual(4);
        expect(lines.some((line) => line.event === "ai.completion")).toBe(false);
        if (mode.startsWith("relay")) expect(lines.some((line) => line.event === "ai.relay.pump_error")).toBe(true);
        const serialized = JSON.stringify(lines);
        for (const secret of ["private-prompt-sentinel", "private-response-sentinel", "private-exception-sentinel", "private-header-sentinel"]) expect(serialized).not.toContain(secret);
        if (mode === "success") expect(body).toContain("data: [DONE]");
        else expect(body).toContain(`"code":"${mode === "backend-error" ? "timeout" : "internal"}"`);
      },
    );
  });

  describe("first-event acceptance cleanup", () => {
    it.each(["reject", "timeout", "preabort", "first-error"] as const)(
      "cleans subscriber and listener on %s", async (mode) => {
        setupMocks();
        const inputAbort = new AbortController();
        const removeListener = vi.spyOn(inputAbort.signal, "removeEventListener");
        let subscriber: AbortSignal | undefined;
        let returned = 0;
        const container = mockGetContainer();
        Object.assign(container, { runStream: {
          subscribe: (_runId: string, signal: AbortSignal) => {
            subscriber = signal;
            return { [Symbol.asyncIterator]: () => ({
              next: () => mode === "reject" ? Promise.reject(new Error("redis failure"))
                : mode === "first-error" ? Promise.resolve({ done: false, value: { id: "1", event: { type: "error", error: "internal" } } })
                : new Promise(() => {}),
              return: async () => { returned++; return { done: true, value: undefined }; },
            }) };
          },
        } });
        if (mode === "timeout") vi.useFakeTimers();
        if (mode === "preabort") inputAbort.abort();
        try {
          const { completionStream } = await import("@/app/_facades/ai/completion.server");
          const pending = completionStream({
            messages: [{ role: "user", content: "hello" }],
            modelRef: { providerKey: "platform", modelId: TEST_MODEL_ID },
            sessionUser: TEST_SESSION_USER_1, graphName: "langgraph:default", abortSignal: inputAbort.signal,
          }, { log: makeNoopLogger(), reqId: "request-accept", traceId: "00000000000000000000000000000000", routeId: "chat.completions", clock: { now: () => "2025-01-01T00:00:00.000Z" } });
          const rejected = expect(pending).rejects.toBeDefined();
          if (mode === "timeout") {
            await vi.waitFor(() => expect(subscriber).toBeDefined());
            await vi.advanceTimersByTimeAsync(20_000);
          }
          await rejected;
          expect(subscriber?.aborted).toBe(true);
          expect(returned).toBe(1);
          if (mode !== "preabort") expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
          if (mode === "timeout") expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
          removeListener.mockRestore();
        }
      },
    );
  });

  describe("non-streaming response parity", () => {
    it("should return response matching OpenAI ChatCompletion shape exactly", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              messages: [{ role: "user", content: "Hello" }],
            })
          ),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(200);

      const json = await response.json();

      // Verify against OpenAI contract schema
      expect(() => chatCompletionsContract.output.parse(json)).not.toThrow();

      // Verify exact OpenAI field presence
      expect(json).toHaveProperty("id");
      expect(json).toHaveProperty("object", "chat.completion");
      expect(json).toHaveProperty("created");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("choices");
      expect(json).toHaveProperty("usage");

      // Verify id format: chatcmpl-{id}
      expect(json.id).toMatch(/^chatcmpl-/);

      // Verify created is Unix timestamp (seconds)
      expect(typeof json.created).toBe("number");
      expect(json.created).toBeGreaterThan(1_000_000_000); // After year 2001
      expect(json.created).toBeLessThan(10_000_000_000); // Before year 2286 (seconds, not ms)

      // Verify choices structure
      expect(json.choices).toHaveLength(1);
      expect(json.choices[0]).toHaveProperty("index", 0);
      expect(json.choices[0]).toHaveProperty("message");
      expect(json.choices[0].message).toHaveProperty("role", "assistant");
      expect(json.choices[0].message).toHaveProperty("content");
      expect(typeof json.choices[0].message.content).toBe("string");
      expect(json.choices[0]).toHaveProperty("finish_reason", "stop");

      // Verify usage structure
      expect(json.usage).toHaveProperty("prompt_tokens");
      expect(json.usage).toHaveProperty("completion_tokens");
      expect(json.usage).toHaveProperty("total_tokens");
      expect(json.usage.total_tokens).toBe(
        json.usage.prompt_tokens + json.usage.completion_tokens
      );
    });

    it("should return Content-Type: application/json", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
    });

    it("should include tool_calls in response when model uses tools", async () => {
      setupMocks({
        responseContent: "",
        toolCalls: [
          {
            toolCallId: "call_abc123",
            toolName: "get_weather",
            args: { location: "NYC" },
          },
        ],
        finishReason: "tool_calls",
      });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              messages: [{ role: "user", content: "What's the weather?" }],
            })
          ),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(() => chatCompletionsContract.output.parse(json)).not.toThrow();
      expect(json.choices[0]?.finish_reason).toBe("tool_calls");
    });
  });

  describe("streaming response parity", () => {
    it("keeps facade preclaim identity distinct from original worker callback identity", async () => {
      const { executionRequestPort } = setupMocks();
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(createCompletionRequest({ stream: true })),
      }));
      await response.text();
      expect(executionRequestPort.createPendingRequest).toHaveBeenCalledOnce();
      const claim = executionRequestPort.createPendingRequest.mock.calls[0];
      if (!claim) throw new Error("missing facade preclaim");
      const [facadeKey, , runId] = claim;
      expect(facadeKey).toMatch(/^ai:/);
      // Original worker callback uses api:<runId>; no key rewrite or adoption change is implied.
      const originalWorkerKey = `api:${runId}`;
      expect(facadeKey).not.toBe(originalWorkerKey);
    });

    it("returns 409 before execution when an idempotency key is reused with changed input", async () => {
      const { temporal } = setupMocks();
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "same-caller-key",
      };

      const first = await POST(
        new NextRequest("http://localhost:3000/api/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
              messages: [{ role: "user", content: "first" }],
            })
          ),
        })
      );
      await first.text();
      const changed = await POST(
        new NextRequest("http://localhost:3000/api/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
              messages: [{ role: "user", content: "changed" }],
            })
          ),
        })
      );

      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({
        error: { code: "idempotency_conflict" },
      });
      expect(temporal.client.start).toHaveBeenCalledOnce();
    });

    it("maps a first execution error event before committing SSE headers", async () => {
      setupMocks({ responseContent: "", errorEvent: "insufficient_credits" });

      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(
        new NextRequest("http://localhost:3000/api/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        })
      );

      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({
        error: { type: "insufficient_quota" },
      });
    });

    it("emits an OpenAI error event instead of a normal stop after SSE starts", async () => {
      setupMocks({
        responseContent: "",
        statusEvents: [{ phase: "thinking" }],
        errorEvent: "provider_unavailable",
      });

      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(
        new NextRequest("http://localhost:3000/api/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        })
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('"code":"provider_unavailable"');
      expect(body).not.toContain('"finish_reason":"stop"');
      expect(body).not.toContain("data: [DONE]");
    });

    it("should return SSE with correct Content-Type and headers", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
            })
          ),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    });

    it("should emit SSE chunks in data: {json}\\n\\n format ending with data: [DONE]", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
            })
          ),
        }
      );

      const response = await POST(req);
      const text = await response.text();

      // Every data line must be "data: " prefixed
      const lines = text.split("\n\n").filter(Boolean);
      for (const line of lines) {
        expect(line).toMatch(/^data: /);
      }

      // Must end with [DONE] (OpenAI spec)
      expect(text).toContain("data: [DONE]");
    });

    it("sends keepalive comments while the subscriber is quiet and stops on cancel", async () => {
      setupMocks();
      const records = captureRequestLogs();
      const container = mockGetContainer();
      let subscriberSignal: AbortSignal | undefined;
      Object.assign(container, { runStream: {
        subscribe: async function* (_runId: string, signal: AbortSignal) {
          subscriberSignal = signal;
          yield { id: "1-0", event: { type: "status" as const, phase: "thinking" as const } };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      } });
      vi.useFakeTimers();
      try {
        const { POST } = await import("@/app/api/v1/chat/completions/route");
        const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
          method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })),
        }));
        if (!response.body) throw new Error("missing response stream");
        const reader = response.body.getReader();
        await reader.read(); // role
        await reader.read(); // initial status
        const heartbeat = reader.read();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(new TextDecoder().decode((await heartbeat).value)).toBe(": keepalive\n\n");
        await reader.cancel();
        expect(subscriberSignal?.aborted).toBe(true);
        expect(records.filter((line) => line.event === "ai.chat_stream_closed")).toEqual([expect.objectContaining({ reason: "consumer_cancel", errorCode: "aborted" })]);
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });

    it("closes on request abort and ignores a late event", async () => {
      setupMocks();
      const records = captureRequestLogs();
      const container = mockGetContainer();
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      Object.assign(container, { runStream: {
        subscribe: async function* () {
          yield { id: "1-0", event: { type: "status" as const, phase: "thinking" as const } };
          await delayed;
          yield { id: "2-0", event: { type: "text_delta" as const, delta: "late" } };
        },
      } });
      const abort = new AbortController();
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })), signal: abort.signal,
      }));
      if (!response.body) throw new Error("missing response stream");
      const reader = response.body.getReader();
      await reader.read();
      await reader.read();
      abort.abort();
      const next = await reader.read();
      expect(next.done).toBe(true);
      release();
      expect(records.filter((line) => line.event === "ai.chat_stream_closed")).toEqual([expect.objectContaining({ reason: "request_abort", errorCode: "aborted" })]);
    });

    it("closes a stream when its request aborts before stream creation", async () => {
      setupMocks();
      const records = captureRequestLogs();
      const abort = new AbortController();
      let subscriber: AbortSignal | undefined;
      Object.assign(mockGetContainer(), { runStream: {
        subscribe: async function* (_runId: string, signal: AbortSignal) {
          subscriber = signal;
          abort.abort();
          yield { id: "1", event: { type: "status" as const, phase: "thinking" as const } };
        },
      } });
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })), signal: abort.signal,
      }));
      expect(await response.text()).toBe("");
      expect(subscriber?.aborted).toBe(true);
      expect(records.filter((line) => line.event === "ai.chat_stream_closed")).toEqual([expect.objectContaining({ reason: "request_abort", errorCode: "aborted" })]);
    });

    it.each(["success", "error"] as const)("cleans the subscriber after terminal %s", async (outcome) => {
      const { runStream } = setupMocks({
        statusEvents: [{ phase: "thinking" }],
        ...(outcome === "error" ? { errorEvent: "internal" } : {}),
      });
      const original = runStream.subscribe;
      let subscriber: AbortSignal | undefined;
      Object.assign(runStream, { subscribe: (runId: string, signal: AbortSignal) => {
        subscriber = signal;
        void runId;
        return original();
      } });
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })),
      }));
      await response.text();
      expect(subscriber?.aborted).toBe(true);
    });



    it("keeps the first abort reason when consumer cancellation follows", async () => {
      setupMocks();
      const records = captureRequestLogs();
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      Object.assign(mockGetContainer(), { runStream: {
        subscribe: async function* () {
          yield { id: "1", event: { type: "status" as const, phase: "thinking" as const } };
          await delayed;
        },
      } });
      const abort = new AbortController();
      const { POST } = await import("@/app/api/v1/chat/completions/route");
      const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
        method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })), signal: abort.signal,
      }));
      if (!response.body) throw new Error("missing stream");
      const reader = response.body.getReader();
      await reader.read();
      await reader.read();
      abort.abort();
      await reader.cancel();
      release();
      expect(records.filter((line) => line.event === "ai.chat_stream_closed")).toEqual([expect.objectContaining({ reason: "request_abort", errorCode: "aborted" })]);
    });

    it("reports internal error when an initial write throws", async () => {
      setupMocks();
      const records = captureRequestLogs();
      const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue").mockImplementationOnce(() => { throw new Error("private-exception-sentinel"); });
      try {
        const { POST } = await import("@/app/api/v1/chat/completions/route");
        const response = await POST(new NextRequest("http://localhost:3000/api/v1/chat/completions", {
          method: "POST", body: JSON.stringify(createCompletionRequest({ stream: true })),
        }));
        const text = await response.text();
        expect(text).toContain('"code":"internal"');
        expect(text).not.toContain("[DONE]");
        expect(text).not.toContain('"finish_reason":"stop"');
        expect(records.filter((line) => line.event === "ai.chat_stream_closed")).toEqual([expect.objectContaining({ reason: "write_or_stream_error", errorCode: "internal" })]);
        expect(JSON.stringify(records)).not.toContain("private-exception-sentinel");
      } finally { enqueue.mockRestore(); }
    });


    it("should emit role announcement as first chunk (OpenAI convention)", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // First chunk must announce role
      const firstChunk = chunks[0] as Record<string, unknown>;
      expect(firstChunk.object).toBe("chat.completion.chunk");
      expect(() =>
        chatCompletionsContract.chunk.parse(firstChunk)
      ).not.toThrow();

      const choices = firstChunk.choices as Array<{
        delta: { role?: string };
      }>;
      expect(choices[0]?.delta.role).toBe("assistant");
    });

    it("should emit finish_reason in final content chunk", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // All chunks should pass schema validation
      for (const chunk of chunks) {
        expect(() => chatCompletionsContract.chunk.parse(chunk)).not.toThrow();
      }

      // Find chunk with finish_reason
      const finishChunks = chunks.filter((c) => {
        const choices = (c as Record<string, unknown>).choices as Array<{
          finish_reason: string | null;
        }>;
        return choices?.[0]?.finish_reason !== null;
      });
      expect(finishChunks.length).toBeGreaterThan(0);

      const finishChunk = finishChunks[0] as Record<string, unknown>;
      const choices = finishChunk.choices as Array<{
        finish_reason: string;
      }>;
      expect(choices[0]?.finish_reason).toBe("stop");
    });

    it("should include usage chunk when stream_options.include_usage is true", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
              stream_options: { include_usage: true },
            })
          ),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // Find usage chunk (empty choices, usage present)
      const usageChunks = chunks.filter((c) => {
        const obj = c as Record<string, unknown>;
        return obj.usage !== undefined && obj.usage !== null;
      });
      expect(usageChunks.length).toBe(1);

      const usageChunk = usageChunks[0] as Record<string, unknown>;
      expect(() =>
        chatCompletionsContract.chunk.parse(usageChunk)
      ).not.toThrow();

      const usage = usageChunk.usage as {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
      expect(usage.prompt_tokens).toBe(15);
      expect(usage.completion_tokens).toBe(25);
      expect(usage.total_tokens).toBe(40);
    });

    it("should stream tool_call_start events as OpenAI tool_calls delta", async () => {
      setupMocks({
        responseContent: "",
        toolCalls: [
          {
            toolCallId: "call_xyz789",
            toolName: "search",
            args: { query: "hello world" },
          },
        ],
        finishReason: "tool_calls",
      });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // Find chunk with tool_calls delta
      const toolCallChunks = chunks.filter((c) => {
        const choices = (c as Record<string, unknown>).choices as Array<{
          delta: { tool_calls?: unknown[] };
        }>;
        return choices?.[0]?.delta?.tool_calls !== undefined;
      });
      expect(toolCallChunks.length).toBeGreaterThan(0);

      // Validate tool call chunk structure matches OpenAI spec
      const tcChunk = toolCallChunks[0] as Record<string, unknown>;
      expect(() => chatCompletionsContract.chunk.parse(tcChunk)).not.toThrow();

      const choices = tcChunk.choices as Array<{
        delta: {
          tool_calls: Array<{
            index: number;
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      const tc = choices[0]?.delta.tool_calls[0];
      expect(tc).toBeDefined();
      expect(tc?.index).toBe(0);
      expect(tc?.id).toBe("call_xyz789");
      expect(tc?.type).toBe("function");
      expect(tc?.function.name).toBe("search");
      expect(tc?.function.arguments).toBe('{"query":"hello world"}');
    });
  });

  describe("error response parity", () => {
    it("should return OpenAI error format for invalid JSON body", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: "not json",
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("should return OpenAI error format for missing required fields", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify({ messages: [] }), // Missing model
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("should return 429 for LlmError with rate_limited kind", async () => {
      setupMocksWithError(
        new LlmError("Rate limit exceeded", "rate_limited", 429)
      );

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(429);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("rate_limit_error");
      expect(json.error.code).toBe("rate_limit_exceeded");
    });

    it("should return 408 for LlmError with timeout kind", async () => {
      setupMocksWithError(new LlmError("Request timed out", "timeout", 408));

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(408);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("timeout_error");
    });

    it("should return 404 for LlmError with status 404", async () => {
      setupMocksWithError(new LlmError("Model not found", "provider_4xx", 404));

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(404);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.code).toBe("model_not_found");
      expect(json.error.param).toBe("model");
    });

    it("should return 503 for LlmError with unknown kind", async () => {
      setupMocksWithError(new LlmError("Something went wrong", "unknown"));

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(503);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("server_error");
    });

    it("should return 400 for ChatValidationError", async () => {
      setupMocksWithError(
        new ChatValidationError(
          ChatErrorCode.MESSAGE_TOO_LONG,
          "Message exceeds maximum length"
        )
      );

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("invalid_request_error");
      expect(json.error.message).toContain("Message exceeds maximum length");
    });

    it("should return 401 for unauthenticated requests", async () => {
      vi.resetAllMocks();
      // Re-setup getContainer after reset
      mockGetContainer.mockReturnValue({
        config: { unhandledErrorPolicy: "throw" },
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          child: vi.fn().mockReturnThis(),
        },
        clock: { now: () => new Date() },
      } as never);
      mockGetSessionUser.mockResolvedValue(null);

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(401);
    });
  });

  describe("cogni_status streaming", () => {
    it("emits cogni_status chunks for StatusEvents during streaming", async () => {
      setupMocks({
        statusEvents: [
          { phase: "thinking" },
          { phase: "tool_use", label: "search" },
        ],
      });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      const statusChunks = chunks.filter(
        (c) => (c as Record<string, unknown>).cogni_status !== undefined
      );
      expect(statusChunks).toHaveLength(2);

      const s0 = (statusChunks[0] as Record<string, unknown>).cogni_status as {
        phase: string;
        label?: string;
      };
      expect(s0.phase).toBe("thinking");
      expect(s0.label).toBeUndefined();

      const s1 = (statusChunks[1] as Record<string, unknown>).cogni_status as {
        phase: string;
        label?: string;
      };
      expect(s1.phase).toBe("tool_use");
      expect(s1.label).toBe("search");
    });

    it("preserves standard OpenAI fields on status chunks", async () => {
      setupMocks({ statusEvents: [{ phase: "compacting" }] });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      const statusChunk = chunks.find(
        (c) => (c as Record<string, unknown>).cogni_status !== undefined
      ) as Record<string, unknown>;
      expect(statusChunk).toBeDefined();

      // Must still be a valid ChatCompletionChunk
      expect(() =>
        chatCompletionsContract.chunk.parse(statusChunk)
      ).not.toThrow();
      expect(statusChunk.id).toMatch(/^chatcmpl-/);
      expect(statusChunk.object).toBe("chat.completion.chunk");
      expect(statusChunk.model).toBe(TEST_MODEL_ID);

      const choices = statusChunk.choices as Array<{
        delta: Record<string, unknown>;
        finish_reason: string | null;
      }>;
      expect(choices[0]?.delta).toEqual({});
      expect(choices[0]?.finish_reason).toBeNull();
    });

    it("does not emit cogni_status when no StatusEvents are present", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      const statusChunks = chunks.filter(
        (c) => (c as Record<string, unknown>).cogni_status !== undefined
      );
      expect(statusChunks).toHaveLength(0);
    });

    it("does not include cogni_status in non-streaming responses", async () => {
      setupMocks({ statusEvents: [{ phase: "thinking" }] });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      const json = await response.json();
      expect(json.cogni_status).toBeUndefined();
    });
  });

  describe("field-level compatibility with OpenAI SDK expectations", () => {
    it("should never include extra non-standard fields in top-level response", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      const json = await response.json();

      // OpenAI ChatCompletion top-level fields
      const allowedKeys = new Set([
        "id",
        "object",
        "created",
        "model",
        "choices",
        "usage",
        "system_fingerprint",
        "service_tier",
      ]);
      const extraKeys = Object.keys(json).filter((k) => !allowedKeys.has(k));
      expect(extraKeys).toEqual([]);
    });

    it("should use OpenAI model echo convention (response.model matches request.model)", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({ model: TEST_MODEL_ID })
          ),
        }
      );

      const response = await POST(req);
      const json = await response.json();
      expect(json.model).toBe(TEST_MODEL_ID);
    });
  });
});
