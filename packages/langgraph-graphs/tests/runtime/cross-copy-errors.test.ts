// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/runtime/cross-copy-errors`
 * Purpose: The ai-core error guards this package bundles classify errors thrown by a node's OWN ai-core copy.
 * Scope: Guard behavior over foreign-class errors. Does not run a graph.
 * Invariants: CROSS_COPY_SAFE — a node adapter's LlmError(402) normalizes to provider_unavailable, never
 *   `internal` (bug.5056), even though the bundled runner's LlmError class is a different copy.
 * Side-effects: none
 * Links: packages/ai-core/src/execution/{llm-errors,error-codes}.ts, tsup.config.ts (noExternal ai-core)
 * @internal
 */

import {
  isAiExecutionError,
  isLlmError,
  normalizeErrorToExecutionCode,
} from "@cogni/ai-core";
import { describe, expect, it } from "vitest";

/** Same shape as ai-core's LlmError, different class identity (a node's vendored copy). */
class ForeignLlmError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "LlmError";
  }
}

class ForeignAiExecutionError extends Error {
  constructor(readonly code: string) {
    super(`AI execution failed: ${code}`);
    this.name = "AiExecutionError";
  }
}

describe("CROSS_COPY_SAFE error guards", () => {
  it("classifies a foreign-copy LlmError by status and kind", () => {
    expect(isLlmError(new ForeignLlmError("unfunded", "provider_4xx", 402))).toBe(true);
    expect(
      normalizeErrorToExecutionCode(new ForeignLlmError("unfunded", "provider_4xx", 402))
    ).toBe("provider_unavailable");
    expect(
      normalizeErrorToExecutionCode(new ForeignLlmError("slow down", "rate_limited", 429))
    ).toBe("rate_limit");
    expect(normalizeErrorToExecutionCode(new ForeignLlmError("gone", "provider_5xx"))).toBe(
      "provider_unavailable"
    );
  });

  it("recognizes a foreign-copy AiExecutionError only with a known code", () => {
    expect(isAiExecutionError(new ForeignAiExecutionError("insufficient_credits"))).toBe(true);
    expect(isAiExecutionError(new ForeignAiExecutionError("not_a_code"))).toBe(false);
  });

  it("does not match plain errors that merely share a name", () => {
    const named = new Error("x");
    named.name = "LlmError";
    expect(isLlmError(named)).toBe(false);
    expect(normalizeErrorToExecutionCode(named)).toBe("internal");
  });
});
