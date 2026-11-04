// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@cogni-dao/knowledge-base/tests/cognition-navigation`
 * Purpose: Verify the immutable, credential-free operator navigation data surface.
 * Scope: Pure subpath import; no schema root, database, env or network.
 * Invariants: No guide bodies, seeds or acquired credential values.
 * Side-effects: none
 * Links: task.5309
 * @internal
 */
import { expect, it, vi } from "vitest";
vi.mock("drizzle-orm", () => {
  throw new Error("navigation must not import schema runtime");
});
import {
  OPERATOR_GUIDANCE_POINTERS,
  OPERATOR_KNOWLEDGE_ORIGIN,
  OPERATOR_KNOWLEDGE_SHELVES,
  COGNITION_CREDENTIAL_NAMES,
} from "../src/cognition-navigation.js";
it("exports only immutable canonical pointers and credential variable names", () => {
  expect(OPERATOR_KNOWLEDGE_ORIGIN).toBe("https://cognidao.org");
  expect(OPERATOR_GUIDANCE_POINTERS.map((p) => [p.id, p.domain])).toEqual([
    ["node-ai-traces-read", "use-operate"],
    ["agent-evaluation-loop", "build-agents"],
    ["langfuse-eval-expert", "build-health"],
  ]);
  expect(Object.isFrozen(OPERATOR_GUIDANCE_POINTERS)).toBe(true);
  for (const pointer of OPERATOR_GUIDANCE_POINTERS) {
    expect(Object.isFrozen(pointer)).toBe(true);
    expect(Object.keys(pointer).sort()).toEqual(["domain", "id", "intent"]);
  }
  expect(Object.isFrozen(OPERATOR_KNOWLEDGE_SHELVES)).toBe(true);
  expect(COGNITION_CREDENTIAL_NAMES.operator).toBe(
    "COGNI_OPERATOR_NODE_API_KEY"
  );
});
