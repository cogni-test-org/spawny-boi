// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/types`
 * Purpose: Domain types for work item management — WorkItem, SubjectRef, ExternalRef, WorkRelation, WorkItemStatus.
 * Scope: Pure types and one boundary constructor. Does not perform I/O or depend on frameworks.
 * Invariants:
 * - STATUS_COMMAND_MAP: All 9 statuses from development-lifecycle.md
 * - ACTOR_KINDS_ALIGNED: SubjectRef kinds match identity-model.md actor kinds
 * - CANONICAL_RELATIONS: Only canonical directions (blocks, parent_of, relates_to, duplicates)
 * Side-effects: none
 * Links: docs/spec/development-lifecycle.md, docs/spec/identity-model.md
 * @public
 */

import type { Tagged } from "type-fest";
import type { WorkItemDto } from "./contracts.js";
import type { WorkItemSortBy, WorkItemSortDirection } from "./query-order.js";
import { rankScore } from "./scores.js";

// ── Identity ──────────────────────────────────────────

/** Branded work item ID, e.g. "task.0149", "bug.0150", "proj.agentic-project-management". */
export type WorkItemId = Tagged<string, "WorkItemId">;

/** Adapter-specific revision token for optimistic concurrency (SHA-256 for markdown, row version for DB). */
export type Revision = string;

// ── Work item type ────────────────────────────────────

export type WorkItemType = "task" | "bug" | "story" | "spike" | "subtask";

// ── Actor eligibility ────────────────────────────────
// Routing hint for work selection: "safe for autonomous AI handling" (ai),
// "requires human judgement" (human), or "either can handle" (either).
// This is NOT provenance, ownership, or assignment — use `assignees` for that.

export type ActorKind = "human" | "ai" | "either";

// ── Status ────────────────────────────────────────────
// From docs/spec/development-lifecycle.md — 9 statuses, each needs_* maps to one /command.

export type WorkItemStatus =
  | "needs_triage"
  | "needs_research"
  | "needs_design"
  | "needs_implement"
  | "needs_closeout"
  | "needs_merge"
  | "done"
  | "blocked"
  | "cancelled";

// ── Subject reference (assignment) ───────────────────
// Aligned with docs/spec/identity-model.md actor kinds: user | agent | system.
// "org" kind omitted — not applicable to work item assignment.

export type SubjectRef = Readonly<WorkItemDto["assignees"][number]>;

// ── External references ───────────────────────────────
// Backend-agnostic: works with GitHub, GitLab, Plane, OpenProject.

export type ExternalRef = Readonly<WorkItemDto["externalRefs"][number]>;

// ── Relations ─────────────────────────────────────────
// Canonical direction only — store "blocks", derive "blocked_by" at query time.

export type RelationType = "blocks" | "parent_of" | "relates_to" | "duplicates";

export type WorkRelation = {
  readonly fromId: WorkItemId;
  readonly toId: WorkItemId;
  readonly type: RelationType;
};

// ── Evaluation scores (story.5111) ─────────────────────
// Axis ids are config (hub entry `work-item-scores-design`), never a closed enum:
// adding or renaming an axis must not need a code change or a migration.

/** One axis score: an integer 0–5, optionally backed by a Justification URL. */
export type WorkItemScore = {
  readonly v: number;
  readonly ev?: string | undefined;
};

/** Axis id (e.g. `goal`, `time`, `unblocks`, `ease`, `confidence`, `agent`) → score. */
export type WorkItemScores = Readonly<Record<string, WorkItemScore>>;

// ── Work item ─────────────────────────────────────────

export type WorkItem = Readonly<
  Omit<
    WorkItemDto,
    | "id"
    | "type"
    | "status"
    | "rankScore"
    | "scores"
    | "projectId"
    | "parentId"
    | "blockedBy"
    | "node"
    | "assignees"
    | "externalRefs"
    | "actor"
    | "labels"
    | "specRefs"
  >
> & {
  readonly id: WorkItemId;
  readonly type: WorkItemType;
  readonly status: WorkItemStatus;
  readonly scores?: WorkItemScores;
  readonly projectId?: WorkItemId;
  readonly parentId?: WorkItemId;
  readonly blockedBy?: WorkItemId;
  readonly node: string;
  readonly assignees: readonly SubjectRef[];
  readonly externalRefs: readonly ExternalRef[];
  readonly actor: ActorKind;
  readonly labels: readonly string[];
  readonly specRefs: readonly string[];
};

// ── Query ─────────────────────────────────────────────

export type WorkQuery = {
  readonly sortBy?: WorkItemSortBy;
  readonly sortDirection?: WorkItemSortDirection;
  readonly ids?: readonly WorkItemId[];
  readonly types?: readonly WorkItemType[];
  readonly statuses?: readonly WorkItemStatus[];
  readonly assignee?: SubjectRef;
  readonly projectId?: WorkItemId;
  readonly projectIds?: readonly WorkItemId[];
  readonly rankMin?: number;
  readonly rankMax?: number;
  readonly relatedTo?: WorkItemId;
  readonly text?: string;
  readonly actor?: ActorKind;
  readonly node?: string | readonly string[];
  /** Any-of label match: keep items carrying at least one of these labels. */
  readonly labels?: readonly string[];
  /** Keep items with at least one label whose text starts with this prefix. */
  readonly labelPrefix?: string;
  /**
   * Filter on evaluation completeness (bug.5552): `true` keeps only items with a
   * complete 6-axis score (`rankScore` defined), `false` keeps only the unscored.
   * Scores are Doltgres-only, so on the markdown adapter every item is unscored.
   */
  readonly scored?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
};

// ── Constructor helpers (boundary conversion) ─────────

/** Brand a raw string as WorkItemId. Call at system boundaries only. */
export function toWorkItemId(raw: string): WorkItemId {
  return raw as WorkItemId;
}

export function toWorkItemDto(item: WorkItem): WorkItemDto {
  const { actor, ...fields } = item;
  return {
    ...fields,
    ...(actor !== "either" && { actor }),
    rankScore: rankScore(item.scores),
    assignees: item.assignees.map((a) => ({ ...a })),
    externalRefs: item.externalRefs.map((r) => ({ ...r })),
    labels: [...item.labels],
    specRefs: [...item.specRefs],
  };
}
