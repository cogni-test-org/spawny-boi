// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base/cognition-navigation`
 * Purpose: Canonical operator navigation for a node with an empty local hub.
 * Scope: Immutable routing data only; no schema, seed, credential acquisition or I/O.
 * Invariants: Local cognition never fetches the operator; bodies stay at their canonical owner.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-ai-traces-read; task.5309
 * @public
 */
export const OPERATOR_KNOWLEDGE_ORIGIN = "https://cognidao.org";
export const OPERATOR_GUIDANCE_POINTERS = Object.freeze([
  Object.freeze({
    id: "node-ai-traces-read",
    domain: "use-operate",
    intent:
      "Read AI prompts, replies, tools, model errors and qualified application outcomes",
  }),
  Object.freeze({
    id: "agent-evaluation-loop",
    domain: "build-agents",
    intent:
      "Develop an agent, design an eval, change a prompt or refine behavior",
  }),
  Object.freeze({
    id: "langfuse-eval-expert",
    domain: "build-health",
    intent:
      "Engineer or diagnose Langfuse attribution, custody, budgets or native contracts",
  }),
]);
export const OPERATOR_KNOWLEDGE_SHELVES = Object.freeze([
  "use-access",
  "use-ship",
  "use-operate",
  "use-govern",
  "method",
  "build-agents",
  "build-health",
]);
export const COGNITION_CREDENTIAL_NAMES = Object.freeze({
  node: "COGNI_NODE_API_KEY",
  operator: "COGNI_OPERATOR_NODE_API_KEY",
  legacyOperator: "COGNI_OPERATOR_API_KEY",
});
