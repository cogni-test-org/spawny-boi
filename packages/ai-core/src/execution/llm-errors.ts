// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/execution/llm-errors`
 * Purpose: LLM adapter error types for cross-process error propagation.
 * Scope: Defines LlmError class and helpers. Does not implement normalization (see error-codes.ts).
 * Invariants:
 *   - LlmError captures kind + optional HTTP status at throw site (adapter boundary)
 *   - classifyLlmErrorFromStatus maps HTTP codes to LlmErrorKind
 *   - isLlmError type guard for instanceof checks
 * Side-effects: none
 * Links: ERROR_HANDLING_ARCHITECTURE.md, error-codes.ts (normalizeErrorToExecutionCode)
 * @public
 */

/**
 * Error classification kinds for LLM failures.
 * Derived from HTTP status codes at adapter boundary.
 */
export type LlmErrorKind =
  | "timeout"
  | "rate_limited"
  | "provider_4xx"
  | "provider_5xx"
  | "aborted"
  | "unknown";

/**
 * Typed error for LLM adapter failures.
 * Thrown by adapters on HTTP/stream errors.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;

  constructor(message: string, kind: LlmErrorKind, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Type guard for LlmError.
 *
 * CROSS_COPY_SAFE: a node's LLM adapter throws LlmError from its own vendored ai-core, while a
 * published package (e.g. the bundled runner in @cogni-dao/langgraph-graphs) normalizes it with a
 * different copy of this class. An identity-only check would turn a provider 402 into `internal`
 * (bug.5056). Match by name + a string `kind` as well as by identity.
 */
export function isLlmError(error: unknown): error is LlmError {
  return (
    error instanceof LlmError ||
    (error instanceof Error &&
      error.name === "LlmError" &&
      typeof (error as { kind?: unknown }).kind === "string")
  );
}

/**
 * Classify LlmError kind from HTTP status code.
 */
export function classifyLlmErrorFromStatus(status: number): LlmErrorKind {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "provider_4xx";
  if (status >= 500 && status < 600) return "provider_5xx";
  return "unknown";
}
