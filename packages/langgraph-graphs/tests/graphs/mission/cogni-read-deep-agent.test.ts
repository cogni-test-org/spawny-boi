// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/mission/cogni-read-deep-agent`
 * Purpose: Deterministic public-runner regression that a READ request ("what's our top priority?") runs the smallest deep-agent trajectory on the cogni engine: explicit plan → delegated Flash subagent reads goals + work items → synthesized source-backed answer → ZERO writes.
 * Scope: No semantic proof: one run through the real in-proc runner + real CogniCompletionAdapter with a scripted fake CompletionFn and fake tool results. Does not call a real LLM, hub or network.
 * Invariants:
 *   - PLAN_IS_EXPLICIT: the parent model's first call carries write_todos and its plan lands in the run
 *   - SUBAGENT_DELEGATION: goals + work items are read by the subagent, on the Flash model id, with an isolated transcript
 *   - READ_MODE_FILES_NOTHING: core__edo_decide is never bound to any model and never executed, even though its contract is offered to the runner
 *   - BILLED_PATH_ONLY: every model call (parent and Flash subagent) arrives through the injected CompletionFn
 * Side-effects: none
 * Links: src/graphs/mission/cogni-read.ts · https://cognidao.org/work/items/task.5377
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import {
  EDO_DECIDE_NAME,
  edoDecideContract,
  GOAL_LIST_NAME,
  goalListContract,
  WORK_ITEM_QUERY_NAME,
  workItemQueryContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import {
  COGNI_READ_TOOL_IDS,
  FLASH_SUBAGENT_MODEL,
} from "../../../src/graphs/mission/cogni-read";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../../src/inproc/types";

// node-template's ai-tools has no work_item_read contract/constant (operator's does); the READ
// allowlist still names it by literal id, so a host that registers the tool gets it bound.
const WORK_ITEM_READ_NAME = "core__work_item_read";
const PARENT_MODEL = "parent-model";
const QUESTION = "what's our top priority?";

const GOALS = {
  goals: [
    {
      id: "goal-ai-work-converges",
      title: "AI work converges faster than it sprawls",
      evaluateAt: "2026-12-16",
      content: "CR >= 1.00 with guardrail held.",
    },
    {
      id: "goal-prod-deploys-land",
      title: "Production deploys land reliably",
      evaluateAt: "2026-12-02",
      content: ">= 90% weekly prod deploy success.",
    },
  ],
};
const ITEMS = {
  count: 3,
  items: [
    wi("bug.9001", "Fix flaky prod promote verify", "needs_implement", 0),
    wi("task.9002", "Close stale validated PRs", "needs_closeout", 1),
    wi("story.9003", "Landing page refresh", "needs_design", 3),
  ],
};
function wi(id: string, title: string, status: string, priority: number) {
  return {
    id,
    type: "task",
    title,
    status,
    priority,
    labels: [],
    assignees: [],
    updatedAt: "2026-10-28",
  };
}

type Seen = {
  model: string;
  tools: string[];
  roles: string[];
  messages: string;
};

function script(seen: Seen[]): CompletionFn {
  let parentTurn = 0;
  let childTurn = 0;
  return (req) => {
    const tools = (req.tools ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    seen.push({
      model: req.model,
      tools,
      roles: req.messages.map((m) => m.role),
      messages: JSON.stringify(req.messages),
    });
    const done = (r: Record<string, unknown>) => ({
      stream: (async function* () {})(),
      final: Promise.resolve({ ok: true as const, finishReason: "stop", ...r }),
    });
    const call = (id: string, name: string, args: unknown) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    });

    if (req.model === FLASH_SUBAGENT_MODEL) {
      if (childTurn++ === 0)
        return done({
          toolCalls: [
            call("s1", GOAL_LIST_NAME, {}),
            call("s2", WORK_ITEM_QUERY_NAME, {}),
          ],
        });
      return done({
        content:
          "GOALS: goal-prod-deploys-land. ITEMS: bug.9001 needs_implement p0 serves goal-prod-deploys-land.",
      });
    }
    if (parentTurn++ === 0)
      return done({
        toolCalls: [
          call("p1", "write_todos", {
            todos: [{ content: "Read goals and work", status: "in_progress" }],
          }),
        ],
      });
    if (parentTurn === 2)
      return done({
        toolCalls: [
          call("p2", "task", {
            subagent_type: "ledger-reader",
            description: "Read goals and work items and summarize evidence.",
          }),
        ],
      });

    // 3. SYNTHESIZE — parent model, no tools: the answer.
    return done({
      content:
        "Top priority: bug.9001 (fix flaky prod promote verify) - it serves goal-prod-deploys-land, due 2026-12-02. Next: task.9002 for goal-ai-work-converges.",
    });
  };
}

describe("cogni READ-mode deep agent (task.5377)", () => {
  it("plans, delegates the goal/work-item read to a Flash subagent, answers from evidence, and files nothing", async () => {
    const seen: Seen[] = [];
    const executed: string[] = [];
    const createToolExecFn =
      (_emit: (e: AiEvent) => void): ToolExecFn =>
      async (name) => {
        executed.push(name);
        if (name === GOAL_LIST_NAME) return { ok: true, value: GOALS };
        if (name === WORK_ITEM_QUERY_NAME) return { ok: true, value: ITEMS };
        if (name === WORK_ITEM_READ_NAME)
          return { ok: true, value: ITEMS.items[0] };
        return { ok: true, value: {} };
      };

    const { stream, final } = createInProcGraphRunner({
      program: "cogni-chat",
      sourceContext: {
        nodeId: "test-node",
        origin: "https://test.example",
        mission: {
          content: "Test mission.",
          sourceRef: "test:mission",
          buildSha: null,
        },
      },
      createGraph: createMissionGraph,
      completionFn: script(seen),
      createToolExecFn,
      // The write contract is OFFERED to the runner (as in prod); READ mode must still never bind it.
      toolContracts: [
        goalListContract,
        workItemQueryContract,
        edoDecideContract,
      ],
      request: {
        runId: "read-1",
        messages: [{ role: "user", content: QUESTION }],
        configurable: {
          model: PARENT_MODEL,
          toolIds: [...COGNI_READ_TOOL_IDS],
        },
      },
    });
    const events: AiEvent[] = [];
    for await (const e of stream) events.push(e);
    const result = await final;

    expect(result.ok).toBe(true);

    // (1) explicit plan: first model call is the parent's, with write_todos bound.
    expect(seen[0]?.model).toBe(PARENT_MODEL);
    expect(seen[0]?.tools).toContain("write_todos");

    // (2) delegated subagent read, on the Flash model id, via the billed CompletionFn.
    const sub = seen.filter((s) => s.model === FLASH_SUBAGENT_MODEL);
    expect(sub.length).toBeGreaterThanOrEqual(2); // tool-call turn + digest turn
    expect(sub[0]?.tools).toEqual(
      expect.arrayContaining([GOAL_LIST_NAME, WORK_ITEM_QUERY_NAME]),
    );
    // isolation: the subagent's first turn sees a system prompt + only its task, not the parent transcript.
    expect(sub[0]?.roles).toEqual(expect.arrayContaining(["system", "user"]));
    expect(sub[0]?.messages).not.toContain(QUESTION);
    expect(executed).toEqual(
      expect.arrayContaining([GOAL_LIST_NAME, WORK_ITEM_QUERY_NAME]),
    );

    // (3) synthesized, source-backed natural-language answer from the parent model.
    const synth = seen.at(-1);
    expect(synth?.model).toBe(PARENT_MODEL);
    expect(synth?.tools).not.toContain(EDO_DECIDE_NAME);
    expect(result.ok && result.content).toContain("bug.9001");
    expect(result.ok && result.content).toContain("goal-prod-deploys-land");

    // (4) ZERO writes: edo_decide never bound to any model, never executed.
    expect(seen.flatMap((s) => s.tools)).not.toContain(EDO_DECIDE_NAME);
    expect(executed).not.toContain(EDO_DECIDE_NAME);
    expect(
      events.filter(
        (e) => e.type === "tool_call_start" && e.toolName === EDO_DECIDE_NAME,
      ),
    ).toHaveLength(0);
    // Only read tools ran.
    expect(
      executed.every((n) =>
        (COGNI_READ_TOOL_IDS as readonly string[]).includes(n),
      ),
    ).toBe(true);
  });
});
