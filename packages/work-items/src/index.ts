// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items`
 * Purpose: Work item port interfaces, domain types, evaluation validation/ranking, and status transitions.
 * Scope: Public barrel export. Does not contain I/O or adapter code.
 * Invariants: Domain types and injected-port composition; no runtime configuration.
 * Side-effects: none
 * Links: docs/spec/development-lifecycle.md, docs/spec/identity-model.md
 * @public
 */

export type { WorkItemsContentPort, WorkItemsPort } from "./content.js";
export {
  WorkItemRevisionConflictError,
  WorkItemScoresInvalidError,
  WorkItemsCapacityError,
  WorkItemWriteOutcomeUnknownError
} from "./errors.js";

export type {
  WorkItemLease,
  WorkItemLeaseOwner,
  WorkItemLeasePort
} from "./leases.js";
export type { WorkItemCommandPort, WorkItemQueryPort } from "./ports.js";
export type {
  WorkItemScoresIssue,
  WorkItemScoresIssueCode,
  WorkItemScoresParseResult
} from "./scores.js";
export {
  EASE_ITERATIONS,
  parseWorkItemScores,
  rankScore,
  WORK_ITEM_SCORE_AXIS_ID,
  WORK_ITEM_SCORE_EV_MAX_CHARS,
  WORK_ITEM_SCORE_EVIDENCE_FROM,
  WORK_ITEM_SCORE_MAX,
  WORK_ITEM_SCORE_MIN,
  WORK_ITEM_SCORES_MAX_AXES,
  WORK_ITEM_SCORES_MAX_BYTES
} from "./scores.js";
export { isValidTransition, VALID_TRANSITIONS } from "./transitions.js";
export type {
  ActorKind,
  ExternalRef,
  RelationType,
  Revision,
  SubjectRef,
  WorkItem,
  WorkItemId,
  WorkItemScore,
  WorkItemScores,
  WorkItemStatus,
  WorkItemType,
  WorkQuery,
  WorkRelation
} from "./types.js";
export { toWorkItemId } from "./types.js";
export { withWorkItemLeases } from "./with-leases.js";

export {
  WORK_ITEM_SORT_FIELDS,
  WORK_ITEM_SORT_DIRECTIONS,
  normalizeWorkItemOrder,
  compareWorkItems
} from "./query-order.js";
export type {
  WorkItemSortBy,
  WorkItemSortDirection,
  WorkItemOrder
} from "./query-order.js";

export { toWorkItemDto } from "./types.js";

export * from "./contracts.js";
