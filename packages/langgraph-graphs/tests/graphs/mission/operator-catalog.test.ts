// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/mission/operator-catalog`
 * Purpose: Validate operator catalog entries and createMissionGraph factory.
 * Scope: Catalog structure + factory validation. Does NOT invoke graphs with LLM.
 * Invariants:
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: entries exist in catalog
 *   - FACTORY_SEAM: createMissionGraph requires systemPrompt
 *   - EXISTING_FACTORIES_UNCHANGED: other entries unaffected
 * Side-effects: none
 * Links: agent-roles spec, catalog.ts
 * @internal
 */

import {
  EDO_DECIDE_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_RECORD_OUTCOME_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_WRITE_NAME,
  REPO_OPEN_NAME,
  REPO_SEARCH_NAME,
  VCS_TOOL_BUNDLE,
  WEB_SEARCH_NAME,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import {
  LANGGRAPH_CATALOG,
  LANGGRAPH_GRAPH_IDS,
  OPERATOR_LANGGRAPH_CATALOG,
  OPERATOR_LANGGRAPH_GRAPH_IDS,
} from "../../../src/catalog";
import { createAutoresearchGraph } from "../../../src/graphs/autoresearch/graph";
import { COGNI_DECIDE_TOOL_IDS } from "../../../src/graphs/mission/cogni-decide";
import { COGNI_READ_TOOL_IDS } from "../../../src/graphs/mission/cogni-read";
import { createMissionGraph } from "../../../src/graphs/mission/graph";

describe("operator catalog entries", () => {
  it("operating-review entry exists with systemPrompt and graphFactory", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["operating-review"];
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("Operating Review");
    expect(entry.systemPrompt).toBeDefined();
    expect(typeof entry.systemPrompt).toBe("string");
    expect((entry.systemPrompt ?? "").length).toBeGreaterThan(100);
    expect(entry.toolIds.length).toBeGreaterThan(0);
    expect(entry.graphFactory).toBe(createMissionGraph);
  });

  it("git-reviewer entry exists with systemPrompt and graphFactory", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["git-reviewer"];
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("Git Reviewer");
    expect(entry.systemPrompt).toBeDefined();
    expect(typeof entry.systemPrompt).toBe("string");
    expect((entry.systemPrompt ?? "").length).toBeGreaterThan(100);
    expect(entry.graphFactory).toBe(createMissionGraph);
  });

  it("pr-manager entry exists only in the operator catalog", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["pr-manager"];

    expect(entry).toBeDefined();
    expect(entry.displayName).toBe("PR Manager");
    expect(entry.systemPrompt).toBeDefined();
    expect(entry.graphFactory).toBe(createMissionGraph);
    expect(LANGGRAPH_CATALOG["pr-manager"]).toBeUndefined();
  });

  it("graph IDs include operator roles", () => {
    expect(OPERATOR_LANGGRAPH_GRAPH_IDS["operating-review"]).toBe(
      "langgraph:operating-review",
    );
    expect(OPERATOR_LANGGRAPH_GRAPH_IDS["git-reviewer"]).toBe(
      "langgraph:git-reviewer",
    );
  });

  it("work-prioritizer (mission loop) runs on every node, now bound to the common Cogni factory (reads + scores-only writer)", () => {
    const entry = LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry).toBeDefined();
    // Still in the node catalog (every node runs the mission loop), now powered by the shared
    // Cogni engine (program "work-review" via createMissionGraph), not the legacy ReAct factory.
    expect(entry?.graphFactory).toBe(createMissionGraph);
    expect(entry?.program).toBe("work-review");
    expect(entry?.systemPrompt).toBeDefined();
    expect(entry?.toolIds).toEqual(COGNI_DECIDE_TOOL_IDS);
    expect(entry?.report).toEqual({ event: "ai.work_prioritizer.cycle" });
    expect(LANGGRAPH_GRAPH_IDS["work-prioritizer"]).toBe(
      "langgraph:work-prioritizer",
    );
  });

  it("cogni-chat (READ mode) is in the node catalog, uses the read-only allowlist and binds no write tool", () => {
    // task.5377: cogni-chat moved into NODE_LANGGRAPH_CATALOG so every node (including
    // node-template) can resolve `langgraph:cogni-chat` at runtime and surface it in chat.
    const entry = LANGGRAPH_CATALOG["cogni-chat"];
    expect(entry).toBeDefined();
    expect(entry?.graphFactory).toBe(createMissionGraph);
    expect(entry?.program).toBe("cogni-chat");
    expect([...(entry?.toolIds ?? [])].sort()).toEqual(
      [...COGNI_READ_TOOL_IDS].sort(),
    );
    // Zero-write guarantee unchanged: the READ allowlist never binds the EDO decide tool.
    expect(entry?.toolIds).not.toContain(EDO_DECIDE_NAME);
    // Operator still inherits the same entry through the `...NODE_LANGGRAPH_CATALOG` spread.
    expect(OPERATOR_LANGGRAPH_CATALOG["cogni-chat"]).toBe(entry);
    expect(OPERATOR_LANGGRAPH_GRAPH_IDS["cogni-chat"]).toBe(
      "langgraph:cogni-chat",
    );
  });

  it("no node-runtime graph needs an operator-only VCS tool", () => {
    const vcs = new Set(VCS_TOOL_BUNDLE.map((t) => t.contract.name));
    for (const [name, entry] of Object.entries(LANGGRAPH_CATALOG)) {
      for (const id of entry.toolIds) {
        expect(vcs.has(id), `${name} → ${id}`).toBe(false);
      }
    }
  });

  it("node-runtime catalog does not advertise operator lifecycle graphs", () => {
    expect(LANGGRAPH_CATALOG["operating-review"]).toBeUndefined();
    expect(LANGGRAPH_CATALOG["git-reviewer"]).toBeUndefined();
    expect(LANGGRAPH_CATALOG["pr-manager"]).toBeUndefined();
    expect("operating-review" in LANGGRAPH_GRAPH_IDS).toBe(false);
    expect("git-reviewer" in LANGGRAPH_GRAPH_IDS).toBe(false);
    expect("pr-manager" in LANGGRAPH_GRAPH_IDS).toBe(false);
  });

  it("autoresearch entries exist with evidence tools and graph IDs", () => {
    const graphNames = [
      "autoresearch-single-lane",
      "autoresearch-syntropy-loop",
      "autoresearch-registry-swarm",
    ] as const;

    for (const graphName of graphNames) {
      const entry = OPERATOR_LANGGRAPH_CATALOG[graphName];
      expect(entry).toBeDefined();
      expect(entry.systemPrompt).toBeDefined();
      expect((entry.systemPrompt ?? "").length).toBeGreaterThan(1_000);
      expect(entry.graphFactory).toBe(createAutoresearchGraph);
      expect(OPERATOR_LANGGRAPH_GRAPH_IDS[graphName]).toBe(
        `langgraph:${graphName}`,
      );

      expect(entry.toolIds).toEqual(
        expect.arrayContaining([
          KNOWLEDGE_SEARCH_NAME,
          KNOWLEDGE_READ_NAME,
          KNOWLEDGE_WRITE_NAME,
          REPO_SEARCH_NAME,
          REPO_OPEN_NAME,
          WEB_SEARCH_NAME,
          EDO_HYPOTHESIZE_NAME,
          EDO_DECIDE_NAME,
          EDO_RECORD_OUTCOME_NAME,
        ]),
      );
    }
  });

  it("existing graph entries are unchanged", () => {
    // Verify original entries still exist and don't have systemPrompt
    const poet = OPERATOR_LANGGRAPH_CATALOG.poet;
    expect(poet).toBeDefined();
    expect(poet.displayName).toBe("Poet");
    expect(poet.systemPrompt).toBeUndefined();

    const brain = OPERATOR_LANGGRAPH_CATALOG.brain;
    expect(brain).toBeDefined();
    expect(brain.systemPrompt).toBeUndefined();

    const prReview = OPERATOR_LANGGRAPH_CATALOG["pr-review"];
    expect(prReview).toBeDefined();
    expect(prReview.systemPrompt).toBeUndefined();
  });
});

describe("createMissionGraph", () => {
  it("throws when systemPrompt is not provided", () => {
    const fakeOpts = {
      llm: {} as never,
      tools: [],
    };
    expect(() => createMissionGraph(fakeOpts)).toThrow(
      "createMissionGraph requires systemPrompt",
    );
  });
});
