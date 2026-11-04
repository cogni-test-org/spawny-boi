// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/contracts`
 * Purpose: Canonical knowledge wire schema and pure knowledge/EDO capability contracts.
 * Scope: Pure schemas and types; no adapters, I/O or environment access.
 * Invariants: HTTP and tool read envelopes derive from this domain owner.
 * Side-effects: none
 * @public
 */

import { z } from "zod";

export const KnowledgeRowSchema = z.object({
	id: z.string(),
	domain: z.string(),
	entityId: z.string().nullable(),
	title: z.string(),
	content: z.string(),
	useWhen: z.string().nullable().optional(),
	entryType: z.string(),
	confidencePct: z.number().int().nullable(),
	sourceType: z.string(),
	sourceRef: z.string().nullable(),
	tags: z.array(z.string()).nullable(),
	/** ISO timestamp — a hypothesis's resolution date or a goal's `By:` deadline. */
	evaluateAt: z.string().nullable(),
	/** Namespaced resolver id on hypothesis/goal rows (`manual`, `agent`, `metric:<kpi>`). */
	resolutionStrategy: z.string().nullable(),
	createdAt: z.string().nullable(),
});
export type KnowledgeRow = z.infer<typeof KnowledgeRowSchema>;

/**
 * Confidence score defaults for knowledge entries.
 *
 * - DRAFT (30%): Agent-produced, unverified. Default for all new writes.
 * - VERIFIED (80%): Human-reviewed OR agent-confirmed with fresh sources.
 * - HARDENED (95%): Outcome-validated, statistically significant, or repeatedly confirmed.
 */
export const CONFIDENCE = {
  DRAFT: 30,
  VERIFIED: 80,
  HARDENED: 95,
} as const;

export type KnowledgeEntry = KnowledgeRow;

export interface KnowledgeSearchParams {
  domain: string;
  query: string;
  limit?: number;
}

export interface KnowledgeListParams {
  domain: string;
  tags?: string[];
  limit?: number;
}

export interface KnowledgeWriteParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  sourceType: "human" | "analysis_signal" | "external" | "derived";
  entityId?: string;
  confidencePct?: number;
  sourceRef?: string;
  tags?: string[];
}

/**
 * Knowledge capability — injected into tool implementations at runtime.
 * Backed by KnowledgeStorePort + auto-commit on writes.
 */
export interface KnowledgeCapability {
  /** Search knowledge by domain + text query */
  search(params: KnowledgeSearchParams): Promise<KnowledgeEntry[]>;
  /** List knowledge by domain, optionally filtered by tags */
  list(params: KnowledgeListParams): Promise<KnowledgeEntry[]>;
  /** Get a single knowledge entry by ID */
  get(id: string): Promise<KnowledgeEntry | null>;
  /** Write a knowledge entry + auto-commit. Returns the entry with defaults applied. */
  write(params: KnowledgeWriteParams): Promise<KnowledgeEntry>;
  /**
   * The approved DAO goals (ONE_GOAL_LIST, dao-goals-design): merged `goal-*` atoms, not deprecated.
   * Optional: a node whose store has no goal reader omits it and `core__goal_list` reports goals
   * unavailable.
   */
  listActiveGoals?(): Promise<readonly ActiveGoalInfo[]>;
}

/** One approved DAO goal as tools see it. */
export interface ActiveGoalInfo {
  readonly id: string;
  readonly title: string;
  /** The goal statement (KPI, baseline, target, by, serves-mission). */
  readonly content: string;
  /** ISO `By:` deadline, when set. */
  readonly evaluateAt: string | null;
}

/**
 * Source type for EDO writes. Mirrors the domain SourceType enum.
 */
export type EdoSourceType =
  | "human"
  | "agent"
  | "analysis_signal"
  | "external"
  | "derived";

/**
 * Inputs to `hypothesize`. Files a `hypothesis` row + N `evidence_for`
 * citations + commits.
 */
export interface HypothesizeParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  /** When the hypothesis should resolve. REQUIRED (HYPOTHESIS_HAS_EVALUATE_AT). */
  evaluateAt: Date;
  /**
   * Resolution strategy. NULL/undefined = manual (cron skips; row sits until
   * explicit `recordOutcome`). v0 non-null value: `'agent'`. Future kinds
   * (`market:<id>`, `metric:<query>`, `http:<url>`, `deadline`) add values.
   */
  resolutionStrategy?: string | null;
  /** IDs of event/observation/finding rows that motivate this prediction. */
  evidenceForIds?: string[];
  sourceType: EdoSourceType;
  sourceRef?: string;
  sourceNode?: string;
  tags?: string[];
  confidencePct?: number;
}

/**
 * Inputs to `decide`. Files a `decision` row + 1 `derives_from` citation +
 * commits. The decision MUST derive from a hypothesis or a DAO goal
 * (DECISION_CITES_HYPOTHESIS + EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE).
 */
export interface DecideParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  /** ID of the hypothesis or DAO goal being acted on. MUST refer to entry_type='hypothesis' or 'goal'. */
  derivesFromHypothesisId: string;
  sourceType: EdoSourceType;
  sourceRef?: string;
  sourceNode?: string;
  tags?: string[];
  confidencePct?: number;
}

/**
 * Inputs to `recordOutcome`. Files an `outcome` row + 1 validates/invalidates
 * citation + recomputes confidence on the hypothesis + commits.
 */
export interface RecordOutcomeParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  /** ID of the hypothesis being resolved. */
  hypothesisId: string;
  /** Did the prediction hold? */
  edge: "validates" | "invalidates";
  sourceType: EdoSourceType;
  sourceRef?: string;
  sourceNode?: string;
  tags?: string[];
  confidencePct?: number;
}

/**
 * Output of `recordOutcome` — includes the recomputed confidence on the
 * hypothesis so the agent can see the loop close.
 */
export interface RecordOutcomeResult {
  outcome: KnowledgeEntry;
  hypothesisId: string;
  resolvedConfidence: number;
  citationId: string;
  /** True if the hypothesis was already resolved; this call was a no-op. */
  alreadyResolved: boolean;
}

/**
 * Citation-DAG walk direction. `out` follows citing→cited (what this row
 * cites), `in` follows cited→citing (what cites this row), `both` follows
 * both. The default for `getChain` is `both`.
 */
export type ChainDirection = "out" | "in" | "both";

/**
 * Options for `EdoCapability.getChain`.
 */
export interface GetChainParams {
  rootId: string;
  /** Default `both`. */
  direction?: ChainDirection;
  /** Default 5; capped at 10 by the underlying port adapter. */
  maxDepth?: number;
}

/**
 * One node in a walked chain. The root has `edgeFromParent: null` and
 * `depth: 0`. Deeper nodes carry the edge that connected them to their
 * BFS parent.
 */
export interface ChainNodeEntry {
  entry: KnowledgeEntry;
  /**
   * The citation type that brought this node into the walk. Mirrors the
   * domain `CitationType` enum (`supports`, `contradicts`, `extends`,
   * `supersedes`, `evidence_for`, `derives_from`, `validates`, `invalidates`).
   * `null` only on the root.
   */
  edgeFromParent: {
    citationType: string;
    /** `out` = parent cites this; `in` = this cites parent. */
    direction: "out" | "in";
  } | null;
  /** BFS depth, 0 at the root. */
  depth: number;
}

/**
 * Output of `getChain`. Flat list, ordered by depth (root first). Cycle-safe:
 * each entry id appears at most once.
 */
export interface GetChainResult {
  root: KnowledgeEntry;
  chain: ChainNodeEntry[];
}

/**
 * EdoCapability — atomic four-beat operations on the hypothesis loop.
 *
 * Backed by `KnowledgeStorePort` + `EdoResolverPort` + auto-commit. Each call
 * is a single Doltgres commit: row + edges + (for outcomes) confidence
 * recompute.
 */
export interface EdoCapability {
  /** File a hypothesis row with evaluate_at + N evidence_for edges + commit. */
  hypothesize(params: HypothesizeParams): Promise<KnowledgeEntry>;
  /** File a decision row + 1 derives_from edge + commit. */
  decide(params: DecideParams): Promise<KnowledgeEntry>;
  /**
   * File an outcome row + 1 validates/invalidates edge + recompute confidence +
   * commit. Idempotent on already-resolved hypotheses.
   */
  recordOutcome(params: RecordOutcomeParams): Promise<RecordOutcomeResult>;
  /**
   * Walk the citation DAG from `rootId`. Read-only; surfaces the EDO chain
   * (hypothesis → decision → outcome + evidence/validates/invalidates edges)
   * for human and agent rendering. See `docs/spec/knowledge-syntropy.md` §
   * Chain Read API.
   */
  getChain(params: GetChainParams): Promise<GetChainResult>;
}
