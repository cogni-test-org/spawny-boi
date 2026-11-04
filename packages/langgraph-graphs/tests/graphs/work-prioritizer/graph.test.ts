// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Catalog authority and observed cycle-report boundary regressions; no model-quality claims. */
import { EDO_DECIDE_NAME, GET_CURRENT_TIME_NAME, GOAL_LIST_NAME, KNOWLEDGE_READ_NAME, WORK_ITEM_TRANSITION_NAME } from "@cogni/ai-tools";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { OPERATOR_LANGGRAPH_CATALOG } from "../../../src/catalog";
import { COGNI_DECIDE_TOOL_IDS } from "../../../src/graphs/mission/cogni-decide";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { cycleScores } from "../../../src/graphs/work-prioritizer/graph";

describe("work-prioritizer catalog and cycle report", () => {
  it("catalog entry binds the common Cogni factory (reads + scores-only writer) and cycle event", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry.graphFactory).toBe(createMissionGraph);
    expect(entry.toolIds).toEqual(COGNI_DECIDE_TOOL_IDS);
    expect(entry.toolIds).not.toContain(EDO_DECIDE_NAME);
    expect(entry.toolIds).toContain(GET_CURRENT_TIME_NAME);
    expect(entry.toolIds).toContain(KNOWLEDGE_READ_NAME);
    expect(entry.report).toEqual({ event: "ai.work_prioritizer.cycle" });
  });

  it("does not count missing, empty, list-only or uncorrelated guidance as canonical reads", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "k",
            name: KNOWLEDGE_READ_NAME,
            args: { id: "mission-loop-expert" },
          },
        ],
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "k",
        content: JSON.stringify({
          mode: "get",
          entries: [
            { id: "mission-loop-expert", content: "", sourceRef: null },
          ],
        }),
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "unknown",
        content: JSON.stringify({
          mode: "get",
          entries: [
            { id: "mission-loop-expert", content: "unbound", sourceRef: null },
          ],
        }),
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "k",
        content: JSON.stringify({
          mode: "list",
          entries: [
            {
              id: "mission-loop-expert",
              content: "list result",
              sourceRef: null,
            },
          ],
        }),
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "k",
        content: JSON.stringify({
          mode: "get",
          entries: [
            { id: "another-entry", content: "wrong source", sourceRef: null },
          ],
        }),
      }),
    ];
    expect(cycleScores(messages)).toMatchObject({
      knowledgeReads: 0,
      guidanceReceipts: [],
      scores: { knowledge_read: 0 },
    });
  });

  it("rejects patch-manufactured reads, late reads and placeholder actions; compares objects by value", () => {
    const tool = (name: string, id: string, value: unknown) =>
      new ToolMessage({
        name,
        tool_call_id: id,
        content: JSON.stringify(value),
      });
    const ai = (name: string, id: string, args: Record<string, unknown>) =>
      new AIMessage({ content: "", tool_calls: [{ name, id, args }] });
    const content = [
      "Top 5:",
      ...[1, 2, 3, 4, 5].map(
        (n) => `${n}. task.${n} goal:goal-a — why — next: ...`,
      ),
    ].join("\n");
    const decide = [
      ai(EDO_DECIDE_NAME, "d", { content, derivesFromHypothesisId: "goal-a" }),
      tool(EDO_DECIDE_NAME, "d", { committed: true }),
    ];
    const writes = [1, 2, 3, 4, 5].flatMap((n) => [
      ai(WORK_ITEM_TRANSITION_NAME, `p${n}`, {
        action: "patch",
        id: `task.${n}`,
        rank: n,
      }),
      tool(WORK_ITEM_TRANSITION_NAME, `p${n}`, {
        success: true,
        id: `task.${n}`,
      }),
    ]);
    expect(cycleScores([...writes, ...decide])).toMatchObject({
      itemsRead: 0,
      unknownBaselinePatches: 5,
      scores: { grounded: 0, novel_change: 0, action: 0 },
    });
    const lateReads = [
      ai(GOAL_LIST_NAME, "g", {}),
      tool(GOAL_LIST_NAME, "g", { goals: [{ id: "goal-a" }] }),
      ai("core__work_item_query", "q", {}),
      tool("core__work_item_query", "q", {
        items: [1, 2, 3, 4, 5].map((n) => ({ id: `task.${n}` })),
      }),
      ai(KNOWLEDGE_READ_NAME, "k", { id: "mission-loop-expert" }),
      tool(KNOWLEDGE_READ_NAME, "k", {
        mode: "get",
        entries: [{ id: "mission-loop-expert", content: "guidance" }],
      }),
    ];
    expect(cycleScores([...decide, ...lateReads]).scores).toMatchObject({
      knowledge_read: 0,
      evidence_read: 0,
      grounded: 0,
      goal_cited: 0,
      action: 0,
    });
    // A read in the same tool batch as a decision was not available when the decision was made.
    expect(
      cycleScores([
        lateReads[0],
        lateReads[1],
        decide[0],
        ...lateReads.slice(2),
        decide[1],
      ]).scores,
    ).toMatchObject({ knowledge_read: 0, evidence_read: 0, grounded: 0 });
    const reordered = cycleScores([
      ai("core__work_item_query", "q", {}),
      tool("core__work_item_query", "q", {
        items: [
          { id: "task.1", scores: { value: 5, evidence: { a: 1, b: 2 } } },
        ],
      }),
      ai(WORK_ITEM_TRANSITION_NAME, "p", {
        action: "patch",
        id: "task.1",
        scores: { evidence: { b: 2, a: 1 }, value: 5 },
      }),
      tool(WORK_ITEM_TRANSITION_NAME, "p", { success: true, id: "task.1" }),
    ]);
    expect(reordered).toMatchObject({
      identicalPatches: 1,
      unknownBaselinePatches: 0,
      scores: { novel_change: 0 },
    });
  });

  it("EVERY_TICK_IMPROVES: cycleScores grades hub reads, identical patches and the decision shape", () => {
    const goals = { goals: [{ id: "goal-ai-work-converges" }] };
    const items = {
      items: [
        { id: "story.1", priority: 2, rank: 0, labels: ["a"], revision: 3 },
        { id: "bug.2", priority: 3, rank: 1, labels: [], revision: 1 },
      ],
      count: 2,
    };
    const content = [
      "Since last tick: nothing new; guidance mission-loop-expert",
      "Top 5:",
      "1. story.1 goal:goal-ai-work-converges — why — next: open PR",
      "2. bug.2 goal:goal-ai-work-converges — why — next: reproduce",
      "3. task.3 goal:goal-ai-work-converges — why — next: design",
      "4. task.4 goal:goal-ai-work-converges — why",
      "5. task.5 — why — next: triage",
      "Changes: none",
      "Refine:",
      "1. task.9 goal:goal-ai-work-converges — outside the block — next: ignored",
    ].join("\n");
    const ai = (calls: Array<{ id: string; name: string; args: object }>) =>
      new AIMessage({ content: "", tool_calls: calls });
    const tool = (id: string, name: string, value: unknown) =>
      new ToolMessage({
        tool_call_id: id,
        name,
        content: JSON.stringify(value),
      });
    const messages = [
      ai([{ id: "g", name: GOAL_LIST_NAME, args: {} }]),
      tool("g", GOAL_LIST_NAME, goals),
      ai([
        {
          id: "k",
          name: "core__knowledge_search",
          args: { query: "mission loop" },
        },
      ]),
      tool("k", "core__knowledge_search", {
        results: [{ id: "mission-loop-expert" }],
      }),
      ai([{ id: "q", name: "core__work_item_query", args: {} }]),
      tool("q", "core__work_item_query", items),
      ai([
        {
          id: "p1",
          name: WORK_ITEM_TRANSITION_NAME,
          args: {
            action: "patch",
            id: "story.1",
            priority: 2,
            labels: ["a"],
            expectedRevision: 3,
          },
        },
        {
          id: "p2",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "bug.2", rank: 0, expectedRevision: 1 },
        },
        {
          id: "p3",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "bug.2", rank: 0, expectedRevision: 2 },
        },
        {
          id: "p4",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "task.7", rank: 0 },
        },
        {
          id: "p5",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "story.1", rank: 9 },
        },
      ]),
      tool("p1", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "story.1",
        revision: 4,
      }),
      tool("p2", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "bug.2",
        revision: 2,
      }),
      // p3 re-sends what p2 just wrote → identical; p4 unseen item → unknown; p5 denied → not counted
      tool("p3", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "bug.2",
        revision: 3,
      }),
      tool("p4", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "task.7",
        revision: 1,
      }),
      tool("p5", WORK_ITEM_TRANSITION_NAME, {
        success: false,
        code: "authz_denied",
        message: "authz_denied",
      }),
      ai([
        {
          id: "d",
          name: EDO_DECIDE_NAME,
          args: {
            id: "mission-loop-x",
            domain: "strategy",
            title: "t",
            content,
            derivesFromHypothesisId: "goal-ai-work-converges",
            sourceType: "agent",
          },
        },
      ]),
      tool("d", EDO_DECIDE_NAME, {
        entry: { id: "mission-loop-x" },
        committed: true,
      }),
    ];
    const s = cycleScores(messages);
    expect(s.knowledgeReads).toBe(0); // Search metadata is not a full guidance read.
    expect(s.identicalPatches).toBe(2);
    expect(s.topIds).toEqual([
      "story.1",
      "bug.2",
      "task.3",
      "task.4",
      "task.5",
    ]);
    expect(s.itemsRead).toBe(2);
    expect(s.scores).toEqual({
      knowledge_read: 0,
      evidence_read: 1,
      goal_cited: 0.8,
      novel_change: 0.25,
      grounded: 0.4, // only story.1 and bug.2 were read this run; task.3-5 are invented
      action: 0.8,
    });
    // derivesFromHypothesisId outside the listed goals → goal_cited 0; a failed knowledge search is not a read.
    const off = cycleScores([
      ai([{ id: "g", name: GOAL_LIST_NAME, args: {} }]),
      tool("g", GOAL_LIST_NAME, goals),
      ai([{ id: "k", name: "core__knowledge_search", args: {} }]),
      tool("k", "core__knowledge_search", { error: "boom" }),
      ai([
        {
          id: "d",
          name: EDO_DECIDE_NAME,
          args: { content, derivesFromHypothesisId: "goal-made-up" },
        },
      ]),
      tool("d", EDO_DECIDE_NAME, { entry: { id: "x" }, committed: true }),
    ]);
    expect(off.scores.goal_cited).toBe(0);
    expect(off.scores.knowledge_read).toBe(0);
    expect(off.scores.grounded).toBe(0);
    expect(cycleScores([]).scores).toEqual({
      knowledge_read: 0,
      evidence_read: 0,
      goal_cited: 0,
      novel_change: 1,
      grounded: 0,
      action: 0,
    });
    // Reviewer counterexample: empty search, no backlog read, one id repeated five times, blank next → fails closed.
    const fake = cycleScores([
      ai([{ id: "g", name: GOAL_LIST_NAME, args: {} }]),
      tool("g", GOAL_LIST_NAME, goals),
      ai([{ id: "k", name: "core__knowledge_search", args: {} }]),
      tool("k", "core__knowledge_search", { results: [] }),
      ai([
        {
          id: "d",
          name: EDO_DECIDE_NAME,
          args: {
            content: [
              "Top 5:",
              ...[1, 2, 3, 4, 5].map(
                (n) => `${n}. task.1 goal:goal-ai-work-converges — why — next:`,
              ),
            ].join("\n"),
            derivesFromHypothesisId: "goal-ai-work-converges",
          },
        },
      ]),
      tool("d", EDO_DECIDE_NAME, { entry: { id: "x" }, committed: true }),
    ]);
    expect(fake.scores).toEqual({
      knowledge_read: 0,
      evidence_read: 0,
      goal_cited: 1,
      novel_change: 1,
      grounded: 0,
      action: 0,
    });
  });
});
