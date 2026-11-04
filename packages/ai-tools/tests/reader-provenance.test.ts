// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/reader-provenance`
 * Purpose: Reader content carries node-configured canonical URLs and package-derived ranks for evaluation.
 * Scope: Pure reader/capability fixtures; does not call a store, model, or network.
 * Invariants: ORIGIN_IS_INJECTED, HTTPS_PROVENANCE, NO_MODEL_SELECTED_HOST, RANK_IS_DERIVED.
 * Side-effects: none
 * Links: task.5318, src/source-url.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCapability } from "../src/capabilities/knowledge";
import type { WorkItemCapability } from "../src/capabilities/work-item";
import { readSourceUrl } from "../src/source-url";
import {
  createGoalListImplementation,
  GoalListOutputSchema,
} from "../src/tools/goal-list";
import {
  createKnowledgeSearchImplementation,
  KnowledgeSearchOutputSchema,
} from "../src/tools/knowledge-search";
import {
  createWorkItemQueryImplementation,
  WorkItemQueryOutputSchema,
} from "../src/tools/work-item-query";
import { workItemTransitionContract } from "../src/tools/work-item-transition";
import { toToolSpec } from "../src/schema";

const origin = "https://template-test.example";
const entry = {
  id: "goal-evaluation-proof",
  title: "Approved goal",
  content: "A verified supporting observation.",
  domain: "strategy",
  entityId: null,
  entryType: "goal",
  evaluateAt: null,
  resolutionStrategy: null,
  createdAt: null,
  confidencePct: null,
  sourceType: "agent",
  sourceRef: null,
  tags: null,
};
const knowledge: KnowledgeCapability = {
  search: vi
    .fn()
    .mockResolvedValue([
      { ...entry, sourceUrl: "https://untrusted.example/wrong" },
    ]),
  list: vi.fn(),
  get: vi.fn(),
  write: vi.fn(),
  listActiveGoals: vi.fn().mockResolvedValue([{ ...entry, evaluateAt: null }]),
};

describe("evaluation reader provenance", () => {
  it("returns canonical goal and knowledge URLs with the actual content read", async () => {
    const goals = await createGoalListImplementation({
      knowledgeCapability: knowledge,
      nodePublicOrigin: origin,
    }).execute({});
    expect(GoalListOutputSchema.parse(goals).goals[0]).toMatchObject({
      content: entry.content,
      sourceUrl: `${origin}/knowledge/${entry.id}`,
    });
    const hits = await createKnowledgeSearchImplementation({
      knowledgeCapability: knowledge,
      nodePublicOrigin: origin,
    }).execute({ domain: "strategy", query: "proof" });
    expect(KnowledgeSearchOutputSchema.parse(hits).results[0]).toMatchObject({
      content: entry.content,
      sourceUrl: `${origin}/knowledge/${entry.id}`,
    });
  });

  it("returns the canonical work-item URL, stored scores/revision, and already-derived rank unchanged", async () => {
    const scores = { goal: { v: 5, ev: `${origin}/knowledge/${entry.id}` } };
    const work: WorkItemCapability = {
      query: vi.fn().mockResolvedValue([
        {
          id: "task.5001",
          type: "task",
          title: "Scored task",
          status: "needs_implement",
          labels: [],
          assignees: [],
  externalRefs: [],
  specRefs: [],
          updatedAt: "2026-10-23T00:00:00Z",
          createdAt: "2026-10-22T00:00:00Z",
          deployVerified: false,
          revision: 7,
          scores,
          rankScore: 6.4,
          sourceUrl: "https://untrusted.example/wrong",
        },
      ]),
      patch: vi.fn(),
      transitionStatus: vi.fn(),
    };
    const out = await createWorkItemQueryImplementation({
      workItemCapability: work,
      nodePublicOrigin: origin,
    }).execute({ ids: ["task.5001"] });
    expect(WorkItemQueryOutputSchema.parse(out).items[0]).toMatchObject({
      sourceUrl: `${origin}/work/items/task.5001`,
      scores,
      revision: 7,
      rankScore: 6.4,
    });
  });

  it("does not manufacture a source URL without trusted HTTPS configuration", () => {
    for (const configured of [
      undefined,
      "bad origin",
      "http://localhost:3200",
      "https://user:password@example.com",
    ]) {
      expect(readSourceUrl(configured, "knowledge", entry.id)).toBeUndefined();
    }
    expect(
      readSourceUrl(
        "https://another-node.example/a/path",
        "knowledge",
        entry.id
      )
    ).toBe(`https://another-node.example/knowledge/${entry.id}`);
  });

  it("makes missing canonical provenance explicit without inventing a host", async () => {
    const out = await createGoalListImplementation({
      knowledgeCapability: knowledge,
    }).execute({});
    expect(GoalListOutputSchema.parse(out).goals[0]).toMatchObject({
      sourceUrlUnavailable: true,
    });
    expect(out.goals[0]).not.toHaveProperty("sourceUrl");
  });

  it("retains a flat provider tool schema after score-patch input refinements", () => {
    expect(
      toToolSpec(workItemTransitionContract).spec.inputSchema
    ).toMatchObject({
      type: "object",
    });
  });
});
