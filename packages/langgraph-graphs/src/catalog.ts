// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/catalog`
 * Purpose: Single source of truth for LangGraph graph definitions.
 * Scope: Exports the node-runtime catalog (LANGGRAPH_CATALOG) and the operator opt-in catalog. Does NOT import from src/.
 * Invariants:
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: Graph definitions live here, not in bootstrap
 *   - PACKAGES_NO_SRC_IMPORTS: No imports from src/**
 *   - Adding a graph = add entry here, not touch bootstrap
 * Side-effects: none
 * Links: GRAPH_EXECUTION.md, LANGGRAPH_AI.md
 * @public
 */

import {
  AUTORESEARCH_REGISTRY_SWARM_GRAPH_NAME,
  AUTORESEARCH_SINGLE_LANE_GRAPH_NAME,
  AUTORESEARCH_SYNTROPY_LOOP_GRAPH_NAME,
  createAutoresearchGraph,
} from "./graphs/autoresearch/graph";
import {
  AUTORESEARCH_REGISTRY_SWARM_PROMPT,
  AUTORESEARCH_SINGLE_LANE_PROMPT,
  AUTORESEARCH_SYNTROPY_LOOP_PROMPT,
} from "./graphs/autoresearch/prompts";
import { AUTORESEARCH_TOOL_IDS } from "./graphs/autoresearch/tools";
import { BRAIN_GRAPH_NAME, createBrainGraph } from "./graphs/brain/graph";
import { BRAIN_TOOL_IDS } from "./graphs/brain/tools";
import { BROWSER_GRAPH_NAME, createBrowserGraph } from "./graphs/browser/graph";
import {
  createFrontendTesterGraph,
  FRONTEND_TESTER_GRAPH_NAME,
} from "./graphs/frontend-tester/graph";
import {
  COGNI_DECIDE_PROMPT,
  COGNI_DECIDE_TOOL_IDS,
} from "./graphs/mission/cogni-decide";
import { COGNI_CHAT_PROMPT } from "./graphs/work-prioritizer/prompts";
import {
  COGNI_READ_PROMPT,
  COGNI_READ_TOOL_IDS,
} from "./graphs/mission/cogni-read";
import {
  createMissionGraph,
  GIT_REVIEWER_GRAPH_NAME,
  OPERATING_REVIEW_GRAPH_NAME,
} from "./graphs/mission/graph";
import {
  GIT_REVIEWER_PROMPT,
  OPERATING_REVIEW_PROMPT,
} from "./graphs/mission/prompts";
import {
  GIT_REVIEWER_TOOL_IDS,
  OPERATING_REVIEW_TOOL_IDS,
} from "./graphs/mission/tools";
import { createPoetGraph, POET_GRAPH_NAME } from "./graphs/poet/graph";
import { POET_TOOL_IDS } from "./graphs/poet/tools";
import {
  createPondererGraph,
  PONDERER_GRAPH_NAME,
} from "./graphs/ponderer/graph";
import { PONDERER_TOOL_IDS } from "./graphs/ponderer/tools";
import {
  PR_MANAGER_GRAPH_NAME,
  PR_MANAGER_PROMPT,
} from "./graphs/pr-manager/prompts";
import { PR_MANAGER_TOOL_IDS } from "./graphs/pr-manager/tools";
import {
  createPrReviewGraph,
  PR_REVIEW_GRAPH_NAME,
} from "./graphs/pr-review/graph";
import {
  createResearchGraph,
  RESEARCH_GRAPH_NAME,
} from "./graphs/research/graph";
import { RESEARCH_TOOL_IDS } from "./graphs/research/tools";
import { WORK_PRIORITIZER_GRAPH_NAME } from "./graphs/work-prioritizer/graph";
import type { CreateGraphFn } from "./inproc/types";

/**
 * Catalog entry shape.
 *
 * Per TOOL_CATALOG_IS_CANONICAL: graphs reference tools by ID, not by BoundTool.
 * Providers resolve tools from TOOL_CATALOG using these IDs.
 */
export interface CatalogEntry {
  /** Trusted catalog program assignment; routes mission-engine graphs to the cogni engine. */
  readonly program?: "cogni" | "work-review" | "cogni-chat" | "cogni-decide";
  readonly displayName: string;
  readonly description: string;
  /** Native tool IDs this graph may use. Providers resolve from TOOL_CATALOG. */
  readonly toolIds: readonly string[];
  /** MCP server names whose tools this graph may use. Empty = no MCP tools. */
  readonly mcpServerIds?: readonly string[];
  readonly graphFactory: CreateGraphFn;
  /** Optional system prompt for mission-engine graphs (catalog-driven, not hardcoded). */
  readonly systemPrompt?: string;
  /**
   * Graph-owned run report (PURE_GRAPH_FACTORY): the graph returns `structuredResponse.telemetry` (flat,
   * safe to log). The provider logs it as `event` (a registered event name) and echoes it onto the run
   * stream as one GRAPH_REPORT_OPEN…GRAPH_REPORT_CLOSE text delta.
   */
  readonly report?: GraphReportDecl;
}

/** CatalogEntry.report: the registered event name for the graph's telemetry. */
export interface GraphReportDecl {
  readonly event: string;
}

/** Delimiters of a catalog-declared run report on the run stream (CatalogEntry.report). */
export const GRAPH_REPORT_OPEN = "<graph_report>";
export const GRAPH_REPORT_CLOSE = "</graph_report>";

/**
 * Log lines for a catalog-declared report: one `report.event` from `structuredOutput.telemetry`. Empty when
 * the output carries none.
 * Pure: the provider owns the logger and only calls this (CATALOG_REPORT_SEAM).
 */
export function graphReportLogFields(
  report: GraphReportDecl,
  runId: string,
  structuredOutput: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const telemetry = structuredOutput?.telemetry;
  return telemetry && typeof telemetry === "object"
    ? [{ event: report.event, runId, ...telemetry }]
    : [];
}

/** The stream echo of a catalog-declared report (`<graph_report>{telemetry}</graph_report>`), or null. */
export function graphReportDelta(
  structuredOutput: Record<string, unknown> | undefined,
): string | null {
  const telemetry = structuredOutput?.telemetry;
  return telemetry && typeof telemetry === "object"
    ? `\n${GRAPH_REPORT_OPEN}${JSON.stringify(telemetry)}${GRAPH_REPORT_CLOSE}\n`
    : null;
}

const createAutoresearchCatalogEntry = (
  displayName: string,
  description: string,
  systemPrompt: string,
): CatalogEntry => ({
  displayName,
  description,
  toolIds: AUTORESEARCH_TOOL_IDS as readonly string[],
  graphFactory: createAutoresearchGraph,
  systemPrompt,
});

export type LangGraphCatalog = Readonly<Record<string, CatalogEntry>>;

/**
 * Node runtime LangGraph catalog — the graphs every sovereign node runs.
 *
 * To add a new graph:
 * 1. Create graph factory in graphs/<name>/graph.ts
 * 2. Add entry here with boundTools and graphFactory
 * 3. Bootstrap automatically picks it up (no changes needed there)
 *
 * Per CATALOG_SINGLE_SOURCE_OF_TRUTH: graphs are defined here, not in bootstrap.
 * Per RUNTIME_CATALOG_ISOLATION: operator lifecycle graphs (operating-review, pr-manager,
 * git-reviewer) are not advertised through the node-runtime catalog.
 */
export const NODE_LANGGRAPH_CATALOG = {
  [AUTORESEARCH_SINGLE_LANE_GRAPH_NAME]: createAutoresearchCatalogEntry(
    "Autoresearch Single Lane",
    "Karpathy-style single-lane experiment loop with Thinker, Flasher, Eval, and Judge",
    AUTORESEARCH_SINGLE_LANE_PROMPT,
  ),

  [AUTORESEARCH_SYNTROPY_LOOP_GRAPH_NAME]: createAutoresearchCatalogEntry(
    "Autoresearch Syntropy Loop",
    "Knowledge-syntropy autoresearch loop with Librarian, Archivist, Curator, Thinker, Flasher, and Judge",
    AUTORESEARCH_SYNTROPY_LOOP_PROMPT,
  ),

  [AUTORESEARCH_REGISTRY_SWARM_GRAPH_NAME]: createAutoresearchCatalogEntry(
    "Autoresearch Registry Swarm",
    "Registry-aware autoresearch tournament across conservative, retrieval, and topology lanes",
    AUTORESEARCH_REGISTRY_SWARM_PROMPT,
  ),

  /**
   * Brain graph - code-aware assistant with repository access.
   * Uses createReactAgent with repo search and file open tools.
   */
  [BRAIN_GRAPH_NAME]: {
    displayName: "Brain",
    description: "Code-aware assistant with repository search and file access",
    toolIds: BRAIN_TOOL_IDS,
    graphFactory: createBrainGraph,
  },

  /**
   * Poet graph - poetic AI assistant.
   * Uses the shared Cogni agent with a tool-calling loop.
   */
  [POET_GRAPH_NAME]: {
    displayName: "Poet",
    description: "Poetic AI assistant with structured verse responses",
    toolIds: POET_TOOL_IDS,
    graphFactory: createPoetGraph,
  },

  /**
   * Ponderer graph - philosophical thinker agent.
   * Same tools as poet, but with philosophical system prompt.
   */
  [PONDERER_GRAPH_NAME]: {
    displayName: "Ponderer",
    description: "Philosophical thinker with concise, profound responses",
    toolIds: PONDERER_TOOL_IDS,
    graphFactory: createPondererGraph,
  },

  /**
   * Research graph - deep research agent with web search.
   * Conducts thorough research and produces structured reports.
   */
  [RESEARCH_GRAPH_NAME]: {
    displayName: "Research",
    description: "Deep research agent with web search and report generation",
    toolIds: RESEARCH_TOOL_IDS,
    graphFactory: createResearchGraph,
  },

  /**
   * PR Review graph - single-call structured output for PR evaluation.
   * No tools — evidence is pre-fetched and passed as message content.
   */
  [PR_REVIEW_GRAPH_NAME]: {
    displayName: "PR Review",
    description:
      "Evaluates pull requests against declarative rules with structured scoring",
    toolIds: [],
    graphFactory: createPrReviewGraph,
  },

  /**
   * Browser graph - web browsing agent via Playwright MCP.
   * No native tools — all tools come from MCP servers.
   */
  [BROWSER_GRAPH_NAME]: {
    displayName: "Browser",
    description: "Web browsing agent with Playwright MCP browser access",
    toolIds: [],
    mcpServerIds: ["playwright"],
    graphFactory: createBrowserGraph,
  },

  /**
   * Frontend tester graph - QA agent that drives Playwright to verify UI behavior.
   * Navigates, interacts, screenshots, and reports pass/fail per test case.
   */
  [FRONTEND_TESTER_GRAPH_NAME]: {
    displayName: "Frontend Tester",
    description:
      "QA agent that tests web UIs via Playwright and monitors system health via Grafana",
    toolIds: [],
    mcpServerIds: ["playwright", "grafana"],
    graphFactory: createFrontendTesterGraph,
  },

  /**
   * Mission loop (story.5108 / story.5116) — every node runs it: a node schedules
   * `langgraph:work-prioritizer` in its own repo-spec, and a node with no approved goals changes
   * nothing. Its legacy program identity is "work-review"; it is being moved to the shared
   * bounded scoring profile and must not file a reflexive EDO.
   */
  [WORK_PRIORITIZER_GRAPH_NAME]: {
    displayName: "Mission Loop",
    description: "Source-grounded mission loop with bounded scores or no-op",
    toolIds: COGNI_DECIDE_TOOL_IDS,
    graphFactory: createMissionGraph,
    systemPrompt: COGNI_DECIDE_PROMPT,
    program: "work-review",
    report: { event: "ai.work_prioritizer.cycle" },
  },

  /**
   * Scheduled mission DECIDE deep agent (task.5377). A SEPARATE program that coexists with
   * `work-prioritizer`: plan -> Flash subagent reads goals + ledger -> actuate 0-5 axis SCORES via the
   * story.5108 narrow writer, or no-op when nothing materially changed. Files zero EDO: the tool list
   * omits core__edo_decide, and the graph never exposes the host transition tool to a model.
   */
  "cogni-decide": {
    displayName: "Mission Loop (decide)",
    description:
      "Scheduled deep agent: plans, delegates the goal and ledger read to a cheap subagent, then writes evidence-backed axis scores or does nothing; files zero EDO",
    toolIds: COGNI_DECIDE_TOOL_IDS as readonly string[],
    graphFactory: createMissionGraph,
    systemPrompt: COGNI_DECIDE_PROMPT,
    program: "cogni-decide",
    report: { event: "ai.cogni_decide.cycle" },
  },

  /**
   * Cogni chat, READ mode (task.5377). Same factory, trusted `program: "cogni-chat"` selects the
   * plan -> Flash-subagent -> answer topology. The read-only toolIds omit core__edo_decide, so a
   * READ request cannot file a decision. It lives in the node-runtime catalog so every node
   * (including node-template) can resolve it at runtime; chat reaches it by graph id
   * `langgraph:cogni-chat`. The operator still gets it via the `...NODE_LANGGRAPH_CATALOG` spread.
   */
  "cogni-chat": {
    displayName: "Cogni",
    description:
      "Hub-grounded read-only chat: plans, delegates goal and work-item reading to a cheap subagent, answers; files nothing",
    toolIds: COGNI_READ_TOOL_IDS as readonly string[],
    graphFactory: createMissionGraph,
    systemPrompt: COGNI_CHAT_PROMPT,
    program: "cogni-chat",
  },
  cogni: {
    displayName: "Cogni",
    description: "Node-grounded, read-only Cogni assistant",
    toolIds: COGNI_READ_TOOL_IDS as readonly string[],
    graphFactory: createMissionGraph,
    systemPrompt: COGNI_READ_PROMPT,
    program: "cogni",
  },
} as const;

/**
 * Operator runtime catalog: the node catalog plus the operator lifecycle graphs, which drive
 * the operator's VCS control plane (VCS_TOOL_BUNDLE). Only an operator runtime opts in to it.
 */
export const OPERATOR_LANGGRAPH_CATALOG = {
  ...NODE_LANGGRAPH_CATALOG,

  /**
   * Operating Review — periodic planner-of-record for backlog health.
   * Runs every 12h to triage, flag stuck items, and produce structured briefs.
   */
  [OPERATING_REVIEW_GRAPH_NAME]: {
    displayName: "Operating Review",
    description:
      "Periodic review — triages backlog, flags risks, produces structured briefs",
    toolIds: OPERATING_REVIEW_TOOL_IDS as readonly string[],
    graphFactory: createMissionGraph,
    systemPrompt: OPERATING_REVIEW_PROMPT,
  },

  /**
   * PR Manager — recurring agent that merges ready PRs and reports blockers.
   * Complements the webhook-triggered PR Review (quality) with lifecycle management.
   * v0: merge bot (auto-merge green PRs). v-next: spawns developer agents to fix CI.
   */
  [PR_MANAGER_GRAPH_NAME]: {
    displayName: "PR Manager",
    description:
      "Merge bot — auto-merges green PRs, flags blockers, tracks PR throughput",
    toolIds: PR_MANAGER_TOOL_IDS as readonly string[],
    graphFactory: createMissionGraph,
    systemPrompt: PR_MANAGER_PROMPT,
  },

  /**
   * Git Reviewer — queue observer for merge-ready items.
   * Reports status based on work item metadata (no GitHub API access).
   */
  [GIT_REVIEWER_GRAPH_NAME]: {
    displayName: "Git Reviewer",
    description:
      "Queue observer — reports merge-ready item status from metadata",
    toolIds: GIT_REVIEWER_TOOL_IDS as readonly string[],
    graphFactory: createMissionGraph,
    systemPrompt: GIT_REVIEWER_PROMPT,
  },

  // `cogni-chat` (READ mode) now lives in NODE_LANGGRAPH_CATALOG so every node can resolve it at
  // runtime; the operator inherits it through the `...NODE_LANGGRAPH_CATALOG` spread above.
} as const;

/**
 * Node-runtime catalog. Operator runtimes must opt in to OPERATOR_LANGGRAPH_CATALOG.
 */
export const LANGGRAPH_CATALOG: LangGraphCatalog = NODE_LANGGRAPH_CATALOG;

/**
 * Type helper for catalog entry lookup (short names).
 */
export type LangGraphCatalogKeys = keyof typeof NODE_LANGGRAPH_CATALOG;
export type OperatorLangGraphCatalogKeys =
  keyof typeof OPERATOR_LANGGRAPH_CATALOG;

/**
 * LangGraph provider ID for namespacing.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Fully-qualified graph IDs satisfying GraphId from @cogni/ai-core.
 * Per GRAPH_ID_NAMESPACED: format is ${providerId}:${graphName}
 */
export const NODE_LANGGRAPH_GRAPH_IDS = {
  "autoresearch-single-lane": `${LANGGRAPH_PROVIDER_ID}:${AUTORESEARCH_SINGLE_LANE_GRAPH_NAME}`,
  "autoresearch-syntropy-loop": `${LANGGRAPH_PROVIDER_ID}:${AUTORESEARCH_SYNTROPY_LOOP_GRAPH_NAME}`,
  "autoresearch-registry-swarm": `${LANGGRAPH_PROVIDER_ID}:${AUTORESEARCH_REGISTRY_SWARM_GRAPH_NAME}`,
  brain: `${LANGGRAPH_PROVIDER_ID}:${BRAIN_GRAPH_NAME}`,
  poet: `${LANGGRAPH_PROVIDER_ID}:${POET_GRAPH_NAME}`,
  cogni: `${LANGGRAPH_PROVIDER_ID}:cogni`,
  ponderer: `${LANGGRAPH_PROVIDER_ID}:${PONDERER_GRAPH_NAME}`,
  research: `${LANGGRAPH_PROVIDER_ID}:${RESEARCH_GRAPH_NAME}`,
  "pr-review": `${LANGGRAPH_PROVIDER_ID}:${PR_REVIEW_GRAPH_NAME}`,
  browser: `${LANGGRAPH_PROVIDER_ID}:${BROWSER_GRAPH_NAME}`,
  "frontend-tester": `${LANGGRAPH_PROVIDER_ID}:${FRONTEND_TESTER_GRAPH_NAME}`,
  "work-prioritizer": `${LANGGRAPH_PROVIDER_ID}:${WORK_PRIORITIZER_GRAPH_NAME}`,
  "cogni-decide": `${LANGGRAPH_PROVIDER_ID}:cogni-decide`,
  // READ deep agent — in the NODE graph-id map so the completions `graph_name`
  // path resolves it, matching its NODE_LANGGRAPH_CATALOG entry (task.5377).
  "cogni-chat": `${LANGGRAPH_PROVIDER_ID}:cogni-chat`,
} as const;

export const OPERATOR_LANGGRAPH_GRAPH_IDS = {
  ...NODE_LANGGRAPH_GRAPH_IDS,
  "operating-review": `${LANGGRAPH_PROVIDER_ID}:${OPERATING_REVIEW_GRAPH_NAME}`,
  "pr-manager": `${LANGGRAPH_PROVIDER_ID}:${PR_MANAGER_GRAPH_NAME}`,
  "git-reviewer": `${LANGGRAPH_PROVIDER_ID}:${GIT_REVIEWER_GRAPH_NAME}`,
} as const;

/**
 * Node-runtime graph IDs. Operator runtimes must opt in to OPERATOR_LANGGRAPH_GRAPH_IDS.
 */
export const LANGGRAPH_GRAPH_IDS = NODE_LANGGRAPH_GRAPH_IDS;

/**
 * Union type of all valid LangGraph graph IDs.
 */
export type LangGraphGraphId =
  (typeof LANGGRAPH_GRAPH_IDS)[keyof typeof LANGGRAPH_GRAPH_IDS];
export type OperatorLangGraphGraphId =
  (typeof OPERATOR_LANGGRAPH_GRAPH_IDS)[keyof typeof OPERATOR_LANGGRAPH_GRAPH_IDS];

/**
 * Default graph ID.
 */
export const DEFAULT_LANGGRAPH_GRAPH_ID = LANGGRAPH_GRAPH_IDS.poet;
