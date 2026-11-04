// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Doltgres runtime authority for deployed work items. */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  acquireDoltWriterLocks,
  DoltWriterAdmissionError,
  type DoltWriterLock,
  reconcileAbandonedDoltOperation,
} from "@cogni-dao/doltgres-admission";
import type { ReservedSql, Sql } from "postgres";
import {
  WorkItemDeletionRetiredError,
  WorkItemRevisionConflictError,
  WorkItemScoresInvalidError,
  WorkItemsBusyError,
  WorkItemsCapacityError,
  WorkItemWriteOutcomeUnknownError,
} from "../../errors.js";
import type {
  ActorKind,
  ExternalRef,
  SubjectRef,
  WorkItem,
  WorkItemId,
  WorkItemQueryPort,
  WorkItemScore,
  WorkItemScores,
  WorkItemStatus,
  WorkItemType,
  WorkQuery,
  WorkRelation,
} from "../../index.js";
import { toWorkItemId } from "../../index.js";

export {
  WorkItemLeaseConflictError,
  WorkItemRevisionConflictError,
  WorkItemsBusyError,
  WorkItemsCapacityError,
} from "../../errors.js";

import { parseWorkItemScores } from "../../scores.js";
import { normalizeWorkItemOrder } from "../../query-order.js";
import { rankScoreSql } from "../../rank-policy.js";

import { decodeCursor, encodeCursor, InvalidCursorError, queryIdentity, type WorkItemCursor } from "./cursor.js";
import type {
  WorkItemsContentPort,
  WorkItemsCreateInput,
  WorkItemsPatchInput,
  WorkItemsPatchSet,
} from "./ports.js";

export const OPERATOR_ID_FLOOR = 5000;
const AUTO_ID_RETRIES = 5;
const COMMIT_TAG = "work-items";
const OP_BRANCH_PREFIX = "work-item-op/";
/**
 * Where an unprovable operation branch is parked. Renaming out of
 * `OP_BRANCH_PREFIX` is what lets writes recover: the sweep only enumerates the
 * op namespace, so a quarantined ref stops blocking every future write while
 * its commits stay byte-for-byte intact and inspectable.
 */
const QUARANTINE_BRANCH_PREFIX = "work-item-quarantine/";
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 50;
const OPERATION_QUEUE_WAIT_MS = 30_000;
const QUERY_TIMEOUT_MS = 5_000;
/**
 * Budget for REF HOUSEKEEPING — `dolt_branch` create/delete/rename. Six times
 * the DML budget, because these are not DML and they do not share its failure
 * mode.
 *
 * Measured on operator production 2026-10-09: with one budget for everything,
 * `dolt_branch` exceeded 5s under load, `terminateClient` destroyed the pool,
 * and the PATCH 500'd AFTER its merge had already landed on `main`. Worse, the
 * same 5s applied to the quarantine rename, so the one operation whose job is
 * to clear a stuck branch was itself killed by the timeout — writes stayed
 * down with the fix deployed.
 *
 * A longer budget here is strictly safer than a shorter one: a rename or a
 * delete of an operation ref mutates no rows, so the only thing a timeout buys
 * is a destroyed connection and an orphaned ref.
 */
const BRANCH_TIMEOUT_MS = 30_000;
/**
 * Stages that move REFS or SESSION STATE and write no rows — see
 * BRANCH_TIMEOUT_MS. `branch.create` is `dolt_checkout('-b', …)` and
 * `main.checkout` is `dolt_checkout('main')`; neither touches
 * `public.work_items`, so neither has a half-written row for a timeout to
 * protect. `merge.apply` and every `dml.*` stage deliberately stay on the DML
 * budget, because those DO write rows and a runaway one must be cut off.
 *
 * `branch.create` belongs here for a measured reason: Doltgres ref operations
 * get slower as refs accumulate, and the quarantine lane ADDS a ref each time
 * it parks an unprovable branch. On operator production that closed a loop —
 * `dolt_checkout -b` blew the 5s budget, the pool was destroyed, the orphaned
 * branch became unprovable residue, the next attempt quarantined it and added
 * another ref, and the following attempt was slower still. Writes to one item
 * failed six consecutive times while a freshly created item patched fine,
 * because the pile only has to be big enough to cross the budget.
 */
const BRANCH_HOUSEKEEPING_STAGES = new Set([
  "branch.create",
  "branch.delete",
  "main.checkout",
]);
const RESERVE_TIMEOUT_MS = 5_000;

/** Only content commands own a branch session and reconcile interrupted writes. */
type BranchReconciliation = "required" | "skipped";

export interface WorkItemLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
export interface DoltgresWorkItemAdapterOptions {
  readonly idFloor?: number;
  readonly logger?: WorkItemLogger;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  /** Database mode requires proof that no legacy writer serves this database. */
  readonly writerLockProtocol?: "bridge" | "database";
  readonly queueWaitMs?: number;
  readonly queryTimeoutMs?: number;
  /**
   * Budget for `dolt_branch` ref housekeeping. Defaults to 6× `queryTimeoutMs`'s
   * default; see BRANCH_TIMEOUT_MS for why it is separate.
   */
  readonly branchTimeoutMs?: number;
  readonly reserveTimeoutMs?: number;
  readonly recreateClient?: () => Sql;
  /** Rebuilds the dedicated QUERY pool after a terminal connection failure. */
  readonly recreateReadClient?: () => Sql;
  /** Maximum reader connections across the live and draining generations. Caller budgets two pool widths. */
  readonly readConnectionBudget?: number;
  /**
   * Dedicated pool for the QUERY port. Reads run on it instead of the write
   * lane — see `readOnCleanMain`.
   *
   * Omitting it does NOT opt out of the read lane. When `recreateClient` is
   * set, the adapter derives its own read pool from that factory on first
   * read, because 0.1.5 shipped the read lane as an option every node had to
   * hand-wire and not one of them did: the whole fleet kept serializing reads
   * behind the write queue while the fix sat in the package, inert. A lane
   * that only works when six repositories each remember to pass an argument
   * is not a fix, so the package owns it. Pass this explicitly only to give
   * reads a WIDER pool than the write factory builds.
   */
  readonly readClient?: Sql;
}

interface OperationContext {
  readonly operationId: string;
  readonly operation: string;
  branch?: string;
  abandoned?: Error;
  rejectCaller?: (error: Error) => void;
  nativeUnknown?: boolean;
  mutationState?: PendingBranchState<unknown>;
  admitting?: boolean;
  laneMutated?: boolean;
  acknowledged?: boolean;
  acknowledge?: (value: unknown) => void;
}

interface ReadWaiter {
  readonly deadline: number;
  start(): void;
  reject(error: Error): void;
}

interface WorkItemConnection {
  readonly context: OperationContext;
  readonly pool: Sql;
  unsafe(query: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

type MutationVerb =
  | "create"
  | "patch"
  | "delete"
  | "claim"
  | "heartbeat"
  | "release";

interface MutationProof {
  readonly verb: MutationVerb;
  readonly principal: string;
  itemId?: string;
  beforeRow?: Record<string, unknown>;
  afterRow?: Record<string, unknown>;
  readonly patchValues?: Readonly<Record<string, unknown>>;
  readonly runId?: string;
  readonly command?: string;
  readonly commandProvided?: boolean;
  /** `patch` only: the revision the compare-and-set was conditioned on. */
  readonly expectedRevision?: number;
}

interface MutationOptions<T> {
  readonly proof: MutationProof;
  readonly preflight?: (
    conn: WorkItemConnection,
    proof: MutationProof
  ) => Promise<void>;
  readonly shouldCommit?: (result: T) => boolean;
}

interface PendingBranchState<T> {
  readonly operationId: string;
  commitAttempted?: boolean;
  creationProven?: boolean;
  mergeAttempted?: boolean;
  outcomeSafelyAbsent?: boolean;
  readonly branch: string;
  readonly baseHash: string;
  readonly proof: MutationProof;
  result?: T;
  branchCommit?: string;
  requiresFreshOutcomeProof?: boolean;
}

interface ValidatedBranchTransition {
  readonly branch: string;
  readonly baseHash: string;
  readonly tip: string;
  readonly proof: MutationProof;
  readonly before: RowSnapshot;
  readonly after: RowSnapshot;
  readonly commitAt: number;
}

class PendingBranchRecoveryError<T = unknown> extends Error {
  constructor(
    readonly state: PendingBranchState<T>,
    readonly originalError: unknown
  ) {
    super("Work-item operation branch requires fresh-session recovery");
    this.name = "PendingBranchRecoveryError";
  }
}

const noopLogger: WorkItemLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class WorkItemAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`work item id '${id}' already exists`);
    this.name = "WorkItemAlreadyExistsError";
  }
}

export class WorkItemAuthorizationError extends Error {
  constructor(public readonly id: string) {
    super(`Not authorized to mutate work item: ${id}`);
    this.name = "WorkItemAuthorizationError";
  }
}

export class DoltCommitFailedError extends Error {
  constructor() {
    super("Dolt work-item commit did not return a commit hash");
    this.name = "DoltCommitFailedError";
  }
}

export class DoltOperationFailedError extends Error {
  constructor(operation: string) {
    super(`${operation} did not report success`);
    this.name = "DoltOperationFailedError";
  }
}

export class DirtyWorkItemsMainError extends Error {
  constructor() {
    super("main has uncommitted work_items changes; refusing access");
    this.name = "DirtyWorkItemsMainError";
  }
}

export class ForeignMergeInProgressError extends Error {
  constructor() {
    super("main has a merge in progress not owned by the work-item adapter");
    this.name = "ForeignMergeInProgressError";
  }
}

export class WorkItemMergeConflictError extends Error {
  constructor() {
    super("work_items operation branch conflicted while merging to main");
    this.name = "WorkItemMergeConflictError";
  }
}

/**
 * The branch is STRUCTURALLY verified — linear history, frozen base intact,
 * exactly one `public.work_items` row diff, authoritative commit time — and
 * fails only `validateTransitionMatrix`. That distinction is what makes
 * quarantine safe: we know the ref holds at most one work-item row change, so
 * parking it loses nothing, whereas a branch whose tip or reachability could
 * not be established has proven nothing and must keep failing closed.
 */
class UnprovableTransitionError extends WorkItemsBusyError {
  constructor(message: string) {
    super(message);
    this.name = "UnprovableTransitionError";
  }
}

class DoltMergeOutcomeUnknownError extends WorkItemsBusyError {
  constructor() {
    super(
      "Work-item merge outcome is unknown; adapter requires reconciliation"
    );
    this.name = "DoltMergeOutcomeUnknownError";
  }
}

function escapeValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value) || typeof value === "object") {
    return `'${JSON.stringify(value).replace(/\0/g, "").replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/\0/g, "").replace(/'/g, "''")}'`;
}

/**
 * Creator-binding constrains rows that HAVE a recorded creator. A row whose
 * `created_by_principal_id` is NULL predates the column and is unowned, so every
 * authenticated principal may mutate it — which is exactly the behaviour those
 * rows had before the column existed.
 *
 * Getting this wrong is a silent fleet-wide lockout, not a 403 on one row:
 * `String(null) !== principal` is always true, so the moment a node applies the
 * lease-column migration its entire pre-existing corpus becomes immutable while
 * reads keep returning 200. Observed on operator production 2026-10-08 — every
 * item created before the migration rejected every PATCH, every newly created
 * item was fine, so the failure looked like an auth problem rather than a
 * migration one.
 */
/**
 * Does `creator` (a `created_by_principal_id` rendered as a string, `""` for
 * NULL) permit `principal` to mutate the row?
 *
 * This is the SAME rule `mayMutate` applies to the row it reads, and the two
 * must agree or a write is admitted and then refused. An UNADOPTED row — one
 * created before `created_by_principal_id` existed, so NULL — is mutable by
 * anyone: that is deliberate, because the alternative is that every work item
 * predating the column is frozen forever with no path to adopt it.
 *
 * bug.5358: the transition matrix did NOT share this rule. It demanded
 * `creator === principal` outright, so a NULL-creator row passed `mayMutate`,
 * had its UPDATE committed to the operation branch, then failed its own
 * transition proof — a 500, every time, with the branch left behind as
 * unprovable residue for the next sweep to quarantine. Measured on operator
 * production: every item created on or before 2026-10-08 returned 500 on
 * PATCH while every item created after returned 200, because only the latter
 * carry a creator.
 */
function creatorPermits(creator: string, principal: string): boolean {
  return creator === "" || creator === principal;
}

function mayMutate(row: Record<string, unknown>, principal: string): boolean {
  const creator = row.created_by_principal_id;
  if (creator === null || creator === undefined || creator === "") return true;
  return String(creator) === principal;
}

/**
 * `expectedRevision` is optional: omitted means an unconditioned patch, exactly
 * as before. When present it must be the row's integer version.
 */
function parseExpectedRevision(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed =
    typeof value === "string"
      ? /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN
      : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `patch: expectedRevision must be a non-negative integer (got ${String(value)})`
    );
  }
  return parsed;
}

function requirePrincipal(principalId: string): string {
  const value = principalId.trim();
  if (!value) throw new WorkItemAuthorizationError("unknown");
  return value;
}

/**
 * SCORES_BOUNDS_IN_PACKAGE (story.5111): every adapter write runs the package
 * validator, so a caller that skips the HTTP contract cannot store an
 * unbounded or unevidenced `scores` blob. Throws before any write.
 */
function validScores(value: unknown): WorkItemScores | null {
  const result = parseWorkItemScores(value);
  if (!result.ok) throw new WorkItemScoresInvalidError(result.issues);
  return result.value;
}

function actorOf(value: unknown): ActorKind {
  return value === "human" || value === "ai" ? value : "either";
}

function jsonArrayOf<T>(value: unknown): readonly T[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `scores` (story.5111) is a jsonb object keyed by axis id. Axis ids are config,
 * so any key is kept; only the shape of each entry is checked. A non-object
 * value reads as absent rather than failing the whole row.
 */
function optionalScores(value: unknown): WorkItemScores | undefined {
  if (value === null || value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const scores: Record<string, WorkItemScore> = {};
  for (const [axis, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object") continue;
    const { v, ev } = entry as { v?: unknown; ev?: unknown };
    // Never coerce: a null/boolean/string/fractional `v` is not a score, and a
    // missing axis must read as absent, not zero.
    if (typeof v !== "number" || !Number.isInteger(v)) continue;
    scores[axis] = typeof ev === "string" ? { v, ev } : { v };
  }
  return scores;
}

/**
 * Key-order-insensitive JSON for comparing persisted values. jsonb does not
 * preserve object key order, so a `scores` object read back from the row can
 * legitimately differ in key order from the value that was written.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : inner
  );
}

function optionalWorkItemId(value: unknown): WorkItemId | undefined {
  return value ? toWorkItemId(String(value)) : undefined;
}

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
  const item: Record<string, unknown> = {
    id: toWorkItemId(String(row.id)),
    type: String(row.type) as WorkItemType,
    title: String(row.title),
    status: String(row.status) as WorkItemStatus,
    node: String(row.node ?? "shared"),
    actor: actorOf(row.actor),
    assignees: jsonArrayOf<SubjectRef>(row.assignees),
    externalRefs: jsonArrayOf<ExternalRef>(row.external_refs),
    labels: jsonArrayOf<string>(row.labels),
    specRefs: jsonArrayOf<string>(row.spec_refs),
    revision: Number(row.revision ?? 0),
    deployVerified: Boolean(row.deploy_verified ?? false),
    createdAt: row.created_at ? String(row.created_at) : "",
    updatedAt: row.updated_at ? String(row.updated_at) : "",
  };

  const optional = {
    priority: optionalNumber(row.priority),
    rank: optionalNumber(row.rank),
    estimate: optionalNumber(row.estimate),
    scores: optionalScores(row.scores),
    summary: optionalString(row.summary),
    outcome: optionalString(row.outcome),
    projectId: optionalWorkItemId(row.project_id),
    parentId: optionalWorkItemId(row.parent_id),
    branch: optionalString(row.branch),
    pr: optionalString(row.pr),
    reviewer: optionalString(row.reviewer),
    blockedBy: optionalWorkItemId(row.blocked_by),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) item[key] = value;
  }
  return item as WorkItem;
}

function parseSuffix(id: string, type: WorkItemType): number | null {
  const prefix = `${type}.`;
  if (!id.startsWith(prefix)) return null;
  const tail = id.slice(prefix.length);
  return /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : null;
}

function isDuplicateError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === "23505" ||
    /duplicate|unique|already exists/i.test(candidate.message ?? "")
  );
}

function doltCommitHash(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new DoltCommitFailedError();
  const value = (rows[0] as Record<string, unknown>).dolt_commit;
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? "")
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim();
  if (!normalized || normalized === "undefined" || normalized === "null") {
    throw new DoltCommitFailedError();
  }
  return normalized;
}

function assertDoltStatus(
  rows: unknown,
  field: "dolt_add" | "dolt_checkout" | "dolt_branch"
): void {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DoltOperationFailedError(field);
  }
  const value = (rows[0] as Record<string, unknown>)[field];
  const raw = Array.isArray(value) ? value[0] : value;
  const statusMatch = String(raw ?? "").match(/^[({]?\s*(-?\d+)/);
  if (!statusMatch || Number(statusMatch[1]) !== 0) {
    throw new DoltOperationFailedError(field);
  }
}

function doltScalar(rows: unknown, field: string): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DoltOperationFailedError(field);
  }
  const value = (rows[0] as Record<string, unknown>)[field];
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? "")
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim();
  if (!normalized || normalized === "undefined" || normalized === "null") {
    throw new DoltOperationFailedError(field);
  }
  return normalized;
}

const PATCH_COLUMNS: Record<keyof WorkItemsPatchSet, string> = {
  title: "title",
  summary: "summary",
  outcome: "outcome",
  status: "status",
  priority: "priority",
  rank: "rank",
  estimate: "estimate",
  scores: "scores",
  labels: "labels",
  specRefs: "spec_refs",
  branch: "branch",
  pr: "pr",
  reviewer: "reviewer",
  node: "node",
  deployVerified: "deploy_verified",
  projectId: "project_id",
  parentId: "parent_id",
  blockedBy: "blocked_by",
};

const PERSISTED_WORK_ITEM_COLUMNS = [
  "id",
  "type",
  "title",
  "status",
  "node",
  "project_id",
  "parent_id",
  "priority",
  "rank",
  "estimate",
  "scores",
  "summary",
  "outcome",
  "branch",
  "pr",
  "reviewer",
  "revision",
  "blocked_by",
  "deploy_verified",
  "claimed_by_run",
  "claimed_at",
  "last_command",
  "assignees",
  "external_refs",
  "labels",
  "spec_refs",
  "created_at",
  "updated_at",
  "created_by_principal_id",
  "claim_owner_principal_id",
  "claim_expires_at",
] as const;

type PersistedColumn = (typeof PERSISTED_WORK_ITEM_COLUMNS)[number];
type RowSnapshot = Record<PersistedColumn, unknown>;

const PATCH_DB_COLUMNS = new Set<string>(Object.values(PATCH_COLUMNS));
/**
 * COLLABORATOR_TRIAGE (story.5096): the only fields any authenticated principal
 * may patch on an item it did not create. A `set` naming ANY other field stays
 * creator-bound as a whole. `scores` (story.5111) is ranking input, written by
 * the prioritizer on items it did not create, so it is a triage field too.
 */
const TRIAGE_PATCH_KEYS = new Set<keyof WorkItemsPatchSet>([
  "priority",
  "rank",
  "labels",
  "scores",
]);
/** The full row-diff surface a non-creator patch may prove. */
const TRIAGE_COLUMNS = new Set<string>([
  "priority",
  "rank",
  "labels",
  "scores",
  "revision",
  "updated_at",
]);
const IMMUTABLE_COLUMNS = new Set<string>([
  "id",
  "type",
  "created_at",
  "created_by_principal_id",
]);
const CLAIM_COLUMNS = new Set<string>([
  "claimed_by_run",
  "claim_owner_principal_id",
  "claimed_at",
  "claim_expires_at",
  "last_command",
  "revision",
  "updated_at",
]);
const HEARTBEAT_COLUMNS = new Set<string>([
  "claim_expires_at",
  "last_command",
  "revision",
  "updated_at",
]);
const RELEASE_COLUMNS = new Set<string>([
  "claimed_by_run",
  "claim_owner_principal_id",
  "claimed_at",
  "claim_expires_at",
  "revision",
  "updated_at",
]);

function normalizedPersistedValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return value;
      }
    }
  }
  return value ?? null;
}

function snapshotRow(row: Record<string, unknown>, prefix = ""): RowSnapshot {
  return Object.fromEntries(
    PERSISTED_WORK_ITEM_COLUMNS.map((column) => [
      column,
      normalizedPersistedValue(row[`${prefix}${column}`]),
    ])
  ) as RowSnapshot;
}

function snapshotsEqual(left: RowSnapshot, right: RowSnapshot): boolean {
  return PERSISTED_WORK_ITEM_COLUMNS.every(
    (column) => canonicalJson(left[column]) === canonicalJson(right[column])
  );
}

function changedColumns(before: RowSnapshot, after: RowSnapshot): Set<string> {
  return new Set(
    PERSISTED_WORK_ITEM_COLUMNS.filter(
      (column) => canonicalJson(before[column]) !== canonicalJson(after[column])
    )
  );
}

function onlyAllowedChanges(
  changed: ReadonlySet<string>,
  allowed: ReadonlySet<string>
): boolean {
  return [...changed].every((column) => allowed.has(column));
}

function asEpoch(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const epoch = new Date(String(value)).getTime();
  return Number.isFinite(epoch) ? epoch : undefined;
}

function asRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isInteger(revision) ? revision : undefined;
}

function isNullSnapshot(snapshot: RowSnapshot): boolean {
  return PERSISTED_WORK_ITEM_COLUMNS.every(
    (column) => snapshot[column] === null
  );
}

function legacyProofFromMessage(
  message: string,
  before: RowSnapshot,
  after: RowSnapshot
): MutationProof | undefined {
  const match =
    /^work-items: (create work item|(?:patch|delete|claim|heartbeat|release) ([^ ]+)) by actor:([^ ]+)$/.exec(
      message
    );
  if (!match) return undefined;
  const operation = match[1];
  const explicitId = match[2];
  const principal = match[3];
  if (!operation || !principal) return undefined;
  const verb =
    operation === "create work item" ? "create" : operation.split(" ")[0];
  if (
    verb !== "create" &&
    verb !== "patch" &&
    verb !== "delete" &&
    verb !== "claim" &&
    verb !== "heartbeat" &&
    verb !== "release"
  ) {
    return undefined;
  }
  const diffId = String(
    verb === "delete" ? (before.id ?? "") : (after.id ?? "")
  );
  if (!diffId || (explicitId && explicitId !== diffId)) return undefined;
  return {
    verb,
    principal,
    itemId: diffId,
    beforeRow: before,
    afterRow: after,
  };
}

function requireNamedMerge(rows: unknown): {
  hash: string;
  conflicts: number;
} {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new WorkItemMergeConflictError();
  }
  const row = rows[0] as Record<string, unknown>;
  const hash = String(row.hash ?? "").trim();
  const conflicts = Number(row.conflicts);
  if (!hash || !Number.isFinite(conflicts) || conflicts !== 0) {
    throw new WorkItemMergeConflictError();
  }
  return { hash, conflicts };
}

function validateTransitionMatrix(
  proof: MutationProof,
  before: RowSnapshot,
  after: RowSnapshot,
  commitAt: number
): boolean {
  if (
    proof.beforeRow &&
    !snapshotsEqual(before, snapshotRow(proof.beforeRow))
  ) {
    return false;
  }
  if (proof.afterRow && !snapshotsEqual(after, snapshotRow(proof.afterRow))) {
    return false;
  }

  const changed = changedColumns(before, after);
  const beforeRevision = asRevision(before.revision);
  const afterRevision = asRevision(after.revision);
  const revisionAdvanced =
    beforeRevision !== undefined && afterRevision === beforeRevision + 1;
  const creatorBefore = String(before.created_by_principal_id ?? "");
  const creatorAfter = String(after.created_by_principal_id ?? "");
  const itemId = proof.itemId ?? "";

  switch (proof.verb) {
    case "create": {
      const required = [
        after.id,
        after.type,
        after.title,
        after.status,
        after.node,
        after.created_at,
        after.updated_at,
      ];
      return (
        isNullSnapshot(before) &&
        required.every((value) => value !== null && String(value).length > 0) &&
        String(after.id) === itemId &&
        creatorAfter === proof.principal &&
        afterRevision === 0 &&
        after.claimed_by_run === null &&
        after.claimed_at === null &&
        after.claim_owner_principal_id === null &&
        after.claim_expires_at === null
      );
    }
    case "patch": {
      const requestedColumns = proof.patchValues
        ? Object.keys(proof.patchValues)
        : [...PATCH_DB_COLUMNS];
      const allowed = new Set<string>([
        ...requestedColumns,
        "revision",
        "updated_at",
      ]);
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        // `created_by_principal_id` is immutable, so the equality below also
        // forbids a patch from quietly adopting an unadopted row.
        creatorBefore === creatorAfter &&
        (creatorPermits(creatorBefore, proof.principal) ||
          (proof.principal.length > 0 &&
            onlyAllowedChanges(changed, TRIAGE_COLUMNS))) &&
        (proof.expectedRevision === undefined ||
          beforeRevision === proof.expectedRevision) &&
        [...IMMUTABLE_COLUMNS].every(
          (column) =>
            canonicalJson(before[column as PersistedColumn]) ===
            canonicalJson(after[column as PersistedColumn])
        ) &&
        changed.size > 0 &&
        changed.has("revision") &&
        changed.has("updated_at") &&
        onlyAllowedChanges(changed, allowed) &&
        revisionAdvanced &&
        Object.entries(proof.patchValues ?? {}).every(
          ([column, value]) =>
            PATCH_DB_COLUMNS.has(column) &&
            canonicalJson(after[column as PersistedColumn]) ===
              canonicalJson(normalizedPersistedValue(value))
        )
      );
    }
    case "delete":
      return (
        String(before.id) === itemId &&
        creatorPermits(creatorBefore, proof.principal) &&
        isNullSnapshot(after)
      );
    case "claim": {
      const beforeExpiry = asEpoch(before.claim_expires_at);
      const afterClaimedAt = asEpoch(after.claimed_at);
      const afterExpiry = asEpoch(after.claim_expires_at);
      const sameLease =
        String(before.claim_owner_principal_id ?? "") === proof.principal &&
        String(before.claimed_by_run ?? "") ===
          String(after.claimed_by_run ?? "");
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        creatorBefore === creatorAfter &&
        (sameLease || beforeExpiry === undefined || beforeExpiry <= commitAt) &&
        String(after.claim_owner_principal_id ?? "") === proof.principal &&
        String(after.claimed_by_run ?? "").length > 0 &&
        (proof.runId === undefined || after.claimed_by_run === proof.runId) &&
        afterClaimedAt !== undefined &&
        afterExpiry !== undefined &&
        // Doltgres may report commit metadata at whole-second precision while
        // NOW()-backed row timestamps retain fractional precision. Compare the
        // lower bound at the coarser authority precision so a legitimate claim
        // in the same second is not preserved as unsafe.
        Math.floor(afterClaimedAt / 1_000) <= Math.floor(commitAt / 1_000) &&
        commitAt < afterExpiry &&
        afterExpiry > afterClaimedAt &&
        (proof.command === undefined || after.last_command === proof.command) &&
        onlyAllowedChanges(changed, CLAIM_COLUMNS) &&
        revisionAdvanced
      );
    }
    case "heartbeat": {
      const beforeExpiry = asEpoch(before.claim_expires_at);
      const afterExpiry = asEpoch(after.claim_expires_at);
      const leaseUnchanged =
        before.claim_owner_principal_id === after.claim_owner_principal_id &&
        before.claimed_by_run === after.claimed_by_run &&
        before.claimed_at === after.claimed_at;
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        String(before.claim_owner_principal_id ?? "") === proof.principal &&
        String(before.claimed_by_run ?? "").length > 0 &&
        (proof.runId === undefined || before.claimed_by_run === proof.runId) &&
        leaseUnchanged &&
        beforeExpiry !== undefined &&
        afterExpiry !== undefined &&
        beforeExpiry > commitAt &&
        afterExpiry > commitAt &&
        afterExpiry > beforeExpiry &&
        (proof.commandProvided
          ? after.last_command === proof.command
          : before.last_command === after.last_command) &&
        onlyAllowedChanges(changed, HEARTBEAT_COLUMNS) &&
        revisionAdvanced
      );
    }
    case "release":
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        String(before.claim_owner_principal_id ?? "") === proof.principal &&
        String(before.claimed_by_run ?? "").length > 0 &&
        (proof.runId === undefined || before.claimed_by_run === proof.runId) &&
        after.claimed_by_run === null &&
        after.claim_owner_principal_id === null &&
        after.claimed_at === null &&
        after.claim_expires_at === null &&
        before.last_command === after.last_command &&
        onlyAllowedChanges(changed, RELEASE_COLUMNS) &&
        revisionAdvanced
      );
  }
}

function queryStage(query: string): string {
  if (query.startsWith("SELECT pg_try_advisory_lock")) return "lock.try";
  if (query.startsWith("SELECT pg_advisory_unlock")) return "lock.release";
  if (query.includes("dolt_checkout('-b'")) return "branch.create";
  if (query === "SELECT dolt_checkout('main')") return "main.checkout";
  if (query.startsWith("SELECT dolt_commit")) return "branch.commit";
  if (query.startsWith("SELECT dolt_merge_base")) return "merge.reachability";
  if (query === "SELECT dolt_merge('--abort')") return "merge.abort";
  if (
    query.startsWith("SELECT dolt_merge") ||
    query.includes("FROM dolt_merge")
  )
    return "merge.apply";
  if (query.startsWith("SELECT dolt_branch")) return "branch.delete";
  if (query.includes("FROM dolt.merge_status")) return "merge.status";
  if (query === "SELECT table_name FROM dolt.status") return "main.status";
  if (query === "SELECT name, hash FROM dolt.branches") return "branches.list";
  if (query.startsWith("INSERT INTO work_items")) return "dml.create";
  if (query.startsWith("UPDATE work_items")) return "dml.update";
  if (query.startsWith("DELETE FROM work_items")) return "dml.delete";
  if (query.includes("FROM work_items")) return "dml.read";
  return "sql.other";
}

function doltBoolean(rows: unknown, field: string): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const value = (rows[0] as Record<string, unknown>)[field];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === true || raw === 1 || String(raw).toLowerCase() === "true";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorMessage: String(error) };
}

function isConnectionTerminal(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return (
    code === "CONNECTION_DESTROYED" ||
    code === "CONNECTION_ENDED" ||
    code === "CONNECTION_CLOSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  );
}

function isServerSqlError(error: unknown): boolean {
  return error instanceof Error && error.name === "PostgresError";
}

export class DoltgresWorkItemAdapter
  implements WorkItemsContentPort, WorkItemQueryPort
{
  private operationTail: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private readonly queueWaiters = new Set<() => void>();
  private readonly cleanupScope = new AsyncLocalStorage<OperationContext>();
  private poisoned = false;
  private heldWriter: OperationContext | undefined;
  private readonly logger: WorkItemLogger;
  private readonly idFloor: number;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly writerLockProtocol: "bridge" | "database";
  private readonly queueWaitMs: number;
  private readonly queryTimeoutMs: number;
  private readonly branchTimeoutMs: number;
  private readonly reserveTimeoutMs: number;
  private readonly recreateClient: (() => Sql) | undefined;
  private readClient: Sql | undefined;
  private readonly recreateReadClient: (() => Sql) | undefined;
  /**
   * Read pool derived from `recreateClient` when the caller passed no
   * `readClient`. Built on first read, not in the constructor: a node that
   * never reads must not pay for a connection, and construction must not
   * depend on the database being reachable.
   */
  private readonly terminatingPools = new WeakMap<object, Promise<void>>();
  private readonly readPools = new Set<Sql>();
  private readonly retiredReadPools = new WeakSet<object>();
  private readonly drainingReadPools = new WeakMap<object, Promise<void>>();
  private readonly readConnectionBudget: number | undefined;
  private readonly readPending = new Map<Sql, number>();
  private readonly readWaiters = new Map<Sql, ReadWaiter[]>();
  private readonly unknownReadPools = new WeakSet<object>();

  constructor(
    private sql: Sql,
    options: DoltgresWorkItemAdapterOptions = {}
  ) {
    this.logger = options.logger ?? noopLogger;
    this.idFloor = options.idFloor ?? 1;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
    this.writerLockProtocol = options.writerLockProtocol ?? "bridge";
    this.queueWaitMs = options.queueWaitMs ?? OPERATION_QUEUE_WAIT_MS;
    this.queryTimeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
    this.branchTimeoutMs = options.branchTimeoutMs ?? BRANCH_TIMEOUT_MS;
    this.reserveTimeoutMs = options.reserveTimeoutMs ?? RESERVE_TIMEOUT_MS;
    this.recreateClient = options.recreateClient;
    this.readClient = options.readClient;
    this.readConnectionBudget = options.readConnectionBudget;
    if (
      this.readConnectionBudget !== undefined &&
      (!Number.isInteger(this.readConnectionBudget) ||
        this.readConnectionBudget < 1)
    )
      throw new Error("readConnectionBudget must be a positive integer");
    this.recreateReadClient =
      options.recreateReadClient ?? options.recreateClient;
    if (!this.readClient && !this.recreateReadClient) {
      throw new Error(
        "DoltgresWorkItemAdapter requires a dedicated readClient or read-client factory"
      );
    }
    if (this.readClient === this.sql) {
      throw new Error(
        "DoltgresWorkItemAdapter read and write clients must be separate pools"
      );
    }
    if (this.readClient) this.validateReadPool(this.readClient);
  }

  private logStage(
    level: "info" | "warn" | "error",
    context: OperationContext,
    stage: string,
    state: "start" | "complete" | "error",
    fields: Record<string, unknown> = {}
  ): void {
    this.logger[level](
      {
        event: `adapter.work_items.stage_${state}`,
        component: "doltgres-work-items",
        operationId: context.operationId,
        operation: context.operation,
        stage,
        ...fields,
      },
      `work_items ${stage} ${state}`
    );
  }

  private async terminateClient(
    pool: Sql,
    context: OperationContext,
    stage: string,
    reason: string
  ): Promise<void> {
    if (context.abandoned || context.nativeUnknown) {
      this.poisoned = true;
      this.heldWriter = context;
      return;
    }
    const activeTermination = this.terminatingPools.get(pool as object);
    if (activeTermination) return activeTermination;

    const termination = (async () => {
      if (this.sql === pool) this.poisoned = true;
      this.logStage("error", context, "connection.terminate", "error", {
        failedStage: stage,
        reason,
      });
      try {
        await pool.end({ timeout: 0 });
      } catch (error) {
        this.logStage("error", context, "connection.terminate", "error", {
          failedStage: stage,
          reason: "terminate_failed",
          ...errorFields(error),
        });
        return;
      }

      if (this.sql !== pool || !this.recreateClient) return;
      try {
        this.sql = this.recreateClient();
        this.poisoned = false;
        this.logStage("info", context, "connection.recreate", "complete", {
          failedStage: stage,
        });
      } catch (error) {
        this.logStage("error", context, "connection.recreate", "error", {
          failedStage: stage,
          ...errorFields(error),
        });
      }
    })();
    this.terminatingPools.set(pool as object, termination);
    return termination;
  }

  private async executeQuery(
    pool: Sql,
    conn: ReservedSql,
    context: OperationContext,
    query: string
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const unlock = /^SELECT pg_advisory_unlock\(/.test(query);
    const cleanup = this.cleanupScope.getStore() === context;
    if (context.nativeUnknown)
      throw context.abandoned ?? new WorkItemsCapacityError("unknown");
    if (context.abandoned && !cleanup && !unlock) {
      if (context.admitting && !context.nativeUnknown)
        throw new DoltWriterAdmissionError("lock_contended", false, {
          cause: context.abandoned,
        });
      throw context.abandoned;
    }
    if (
      /^\s*(?:INSERT|UPDATE|DELETE)|dolt_(?:checkout|commit|merge|branch|reset|add)\(/i.test(
        query
      )
    )
      context.laneMutated = true;
    const stage = queryStage(query);
    const startedAt = Date.now();
    let timedOut = false;
    let nativeReturned = false;
    const branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1] ?? context.branch;
    const queryFields = branch ? { branch } : {};
    this.logStage("info", context, stage, "start", queryFields);
    const pending = conn.unsafe(query);
    const budgetMs = BRANCH_HOUSEKEEPING_STAGES.has(stage)
      ? Math.max(this.branchTimeoutMs, this.queryTimeoutMs)
      : this.queryTimeoutMs;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      this.abandonOperation(context, stage);
    }, budgetMs);
    try {
      const rows = (await pending) as ReadonlyArray<Record<string, unknown>>;
      nativeReturned = true;
      if (
        stage === "branch.create" &&
        context.mutationState &&
        query.includes(escapeValue(context.mutationState.branch))
      ) {
        try {
          assertDoltStatus(rows, "dolt_checkout");
          context.mutationState.creationProven = true;
        } catch {
          /* failed creation never grants cleanup ownership */
        }
      }
      if (timedOut && !context.admitting && !unlock && !cleanup) {
        throw context.abandoned;
      }
      this.logStage("info", context, stage, "complete", {
        ...queryFields,
        durationMs: Date.now() - startedAt,
      });
      return rows;
    } catch (error) {
      if (!nativeReturned && !isServerSqlError(error)) {
        context.nativeUnknown = true;
        this.poisoned = true;
        this.abandonOperation(context, stage);
      }
      this.logStage("error", context, stage, "error", {
        ...queryFields,
        durationMs: Date.now() - startedAt,
        timedOut,
        ...errorFields(error),
      });
      if (timedOut && !cleanup) {
        throw context.abandoned;
      }
      if (isConnectionTerminal(error)) {
        context.nativeUnknown = true;
        this.poisoned = true;
        this.abandonOperation(context, stage);
        throw context.abandoned;
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private abandonOperation(context: OperationContext, stage: string): void {
    if (context.abandoned) return;
    context.abandoned = context.branch
      ? new WorkItemWriteOutcomeUnknownError(
          context.operationId,
          context.branch,
          context.mutationState?.branchCommit,
          context.mutationState?.proof.itemId
        )
      : new WorkItemsCapacityError(
          context.nativeUnknown ? "unknown" : "pending"
        );
    this.heldWriter = context;
    for (const reject of this.queueWaiters) reject();
    this.logStage("warn", context, stage, "error", {
      reason: "caller_abandoned_native_retained",
    });
    context.rejectCaller?.(context.abandoned);
  }

  private instrumentConnection(
    pool: Sql,
    conn: ReservedSql,
    context: OperationContext
  ): WorkItemConnection {
    return {
      context,
      pool,
      unsafe: (query) => this.executeQuery(pool, conn, context, query),
    };
  }

  private async enterOperationQueue(
    context: OperationContext
  ): Promise<() => void> {
    if (this.queuedOperations >= 32)
      throw new WorkItemsCapacityError("pending");
    this.queuedOperations++;
    const predecessor = this.operationTail;
    let releaseTurn: () => void = () => undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.operationTail = predecessor.then(() => turnDone);

    const startedAt = Date.now();
    this.logStage("info", context, "operation.queue", "start");
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let rejectCapacity: () => void = () => undefined;
    const heldCapacity = new Promise<never>((_resolve, reject) => {
      rejectCapacity = () => reject(new WorkItemsCapacityError("pending"));
    });
    this.queueWaiters.add(rejectCapacity);
    try {
      await Promise.race([
        predecessor,
        heldCapacity,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new WorkItemsBusyError(
                  "Work-item store queue wait timed out; retry shortly"
                )
              ),
            this.queueWaitMs
          );
        }),
      ]);
    } catch (error) {
      // Keep the FIFO chain live even though this caller abandoned its turn.
      // The resolved ticket is skipped once its predecessor eventually exits.
      releaseTurn();
      this.logStage("warn", context, "operation.queue", "error", {
        durationMs: Date.now() - startedAt,
        reason: "wait_timeout",
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.queuedOperations--;
      this.queueWaiters.delete(rejectCapacity);
    }

    this.logStage("info", context, "operation.queue", "complete", {
      durationMs: Date.now() - startedAt,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTurn();
    };
  }

  private async withGlobalLock<T>(
    context: OperationContext,
    fn: (conn: WorkItemConnection) => Promise<T>,
    options: { readonly reconcile?: BranchReconciliation } = {}
  ): Promise<T> {
    if (this.poisoned) {
      throw new WorkItemsBusyError(
        "Work-item store requires restart reconciliation"
      );
    }
    const operationPool = this.sql;
    const reserveStartedAt = Date.now();
    let rawConn: ReservedSql | undefined;
    let connection: WorkItemConnection | undefined;
    let writerLock: DoltWriterLock | undefined;
    let reserveTimedOut = false;
    let reserveTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingRecovery = false;
    try {
      // postgres.js 3.4.9 does not resolve reserve() on its cold-connection
      // path when fetch_types=false. A real query opens the dedicated
      // connection first; reserve() can then bind that open session.
      await this.executeQuery(
        operationPool,
        operationPool as unknown as ReservedSql,
        context,
        "SELECT 1 AS work_items_ready"
      );
      this.logStage("info", context, "connection.reserve", "start");
      reserveTimer = setTimeout(() => {
        reserveTimedOut = true;
        this.abandonOperation(context, "connection.reserve");
      }, this.reserveTimeoutMs);
      try {
        rawConn = await operationPool.reserve();
      } catch (error) {
        if (reserveTimedOut) {
          throw new WorkItemsBusyError(
            "Work-item store timed out reserving a connection; retry shortly"
          );
        }
        throw error;
      }
      if (reserveTimedOut) {
        rawConn.release();
        rawConn = undefined;
        throw context.abandoned;
      }
      if (reserveTimer) clearTimeout(reserveTimer);
      this.logStage("info", context, "connection.reserve", "complete", {
        durationMs: Date.now() - reserveStartedAt,
      });
      const conn = this.instrumentConnection(operationPool, rawConn, context);
      connection = conn;
      this.logStage("info", context, "lock.acquire", "start", {
        protocol: this.writerLockProtocol,
      });
      context.admitting = true;
      try {
        writerLock = await acquireDoltWriterLocks(conn, {
          protocol: this.writerLockProtocol,
          lockWaitMs: this.lockWaitMs,
          lockRetryMs: this.lockRetryMs,
        });
      } finally {
        context.admitting = false;
      }
      if (context.abandoned) throw context.abandoned;
      this.logStage("info", context, "lock.acquire", "complete", {
        protocol: writerLock.protocol,
        baseDatabase: writerLock.baseDatabase,
      });
      const reconciliation = options.reconcile ?? "required";
      if (reconciliation !== "skipped") await this.reconcileUnderLock(conn);
      return await fn(conn);
    } catch (error) {
      if (error instanceof DoltWriterAdmissionError) {
        if (error.discardSession) {
          await this.terminateClient(
            operationPool,
            context,
            "lock.acquire",
            error.reason
          );
          rawConn = undefined;
        }
        throw new WorkItemsBusyError(
          `Work-item writer admission unavailable: ${error.reason}`
        );
      }
      pendingRecovery = error instanceof PendingBranchRecoveryError;
      this.logStage("error", context, "operation", "error", {
        durationMs: Date.now() - reserveStartedAt,
        ...errorFields(error),
      });
      throw error;
    } finally {
      if (reserveTimer) clearTimeout(reserveTimer);
      let reconciled = false;
      if (
        context.abandoned &&
        context.laneMutated &&
        !context.nativeUnknown &&
        writerLock &&
        connection
      ) {
        const state = context.mutationState;
        const ownedConnection = connection;
        const ownedGuard = writerLock;
        try {
          reconciled = await this.cleanupScope.run(context, () =>
            reconcileAbandonedDoltOperation(ownedConnection, {
              guard: ownedGuard,
              ...(context.branch ? { branch: context.branch } : {}),
              ...(state?.baseHash ? { baseHash: state.baseHash } : {}),
              creationProven: state?.creationProven === true,
              commitAttempted: state?.commitAttempted === true,
              mergeAttempted: state?.mergeAttempted === true,
            })
          );
        } catch (error) {
          this.logStage(
            "error",
            context,
            "abandoned.reconcile",
            "error",
            errorFields(error)
          );
        }
      }
      // Every native await above settled before entering finally. A branch or
      // unknown lock acknowledgement needs inspection; never resume/replay it.
      if (
        context.abandoned &&
        !reconciled &&
        (context.laneMutated || context.nativeUnknown)
      ) {
        this.poisoned = true;
        this.heldWriter = context;
      }
      // Fresh recovery is permitted only after authoritative native settlement.
      // Caller abandonment and transport uncertainty bypass this path entirely:
      // closing a client is not evidence that its native work or locks stopped.
      if (pendingRecovery && rawConn && !context.abandoned) {
        await this.terminateClient(
          operationPool,
          context,
          "operation.recovery_handoff",
          "pending_branch_recovery"
        );
        rawConn = undefined;
        writerLock = undefined;
      }
      if (
        writerLock &&
        rawConn &&
        this.sql === operationPool &&
        !this.poisoned
      ) {
        try {
          await writerLock.release();
        } catch {
          // Never return a session that may still own the writer locks to the
          // pool. This client is dedicated to work items, so terminate the old
          // pool before the injected factory constructs a clean replacement.
          await this.terminateClient(
            operationPool,
            context,
            "lock.release",
            "unlock_failed"
          );
          rawConn = undefined;
        }
      }
      if (rawConn && this.sql === operationPool && !this.poisoned) {
        rawConn.release();
      }
    }
  }

  private async withOperationQueue<T>(
    operation: string,
    fn: (context: OperationContext) => Promise<T>
  ): Promise<T> {
    if (this.heldWriter || this.poisoned)
      throw new WorkItemsCapacityError(this.poisoned ? "unknown" : "pending");
    const context: OperationContext = { operationId: randomUUID(), operation };
    const leaveQueue = await this.enterOperationQueue(context);
    const caller = new Promise<T>((resolve, reject) => {
      context.rejectCaller = reject;
      context.acknowledge = (value) => {
        if (context.abandoned) return;
        context.acknowledged = true;
        resolve(value as T);
      };
    });
    const execution = (async () => {
      try {
        if (this.heldWriter || this.poisoned)
          throw new WorkItemsCapacityError(
            this.poisoned ? "unknown" : "pending"
          );
        return await fn(context);
      } finally {
        // Caller deadline does not release the actual execution's FIFO ticket.
        if (!this.poisoned && this.heldWriter === context)
          this.heldWriter = undefined;
        leaveQueue();
      }
    })();
    return Promise.race([execution, caller]);
  }

  private logReconciliation(
    level: "info" | "warn" | "error",
    conn: WorkItemConnection,
    fields: Record<string, unknown>
  ): void {
    this.logger[level](
      {
        event: "adapter.work_items.reconcile",
        component: "doltgres-work-items",
        operationId: conn.context.operationId,
        ...fields,
      },
      "work_items operation branch reconciled"
    );
  }

  private preservedBranchError(
    branch: string,
    error: unknown
  ): WorkItemsBusyError {
    return error instanceof WorkItemsBusyError
      ? error
      : new WorkItemsBusyError(
          `Work-item branch ${branch} could not be safely proven; preserving evidence`
        );
  }

  /**
   * Re-reads the ref after a delete whose acknowledgement did not arrive.
   *
   * Doltgres can apply `dolt_branch('-D', ...)` durably and still lose the ack
   * to the query deadline — the same lost-acknowledgement shape as bug.5358,
   * one layer down. Taking the thrown error at face value reports completed
   * work as pending, which sends an operator (or a retry loop) chasing a ref
   * that is already gone. Observed on poly production 2026-10-08T02:20:15Z.
   */
  private async deleteLanded(
    conn: WorkItemConnection,
    branch: string
  ): Promise<boolean> {
    try {
      return (await this.operationBranchRow(conn, branch)) === undefined;
    } catch {
      // The session may be dead too. An unverifiable delete stays pending.
      return false;
    }
  }

  private async cleanupVerifiedBranch(
    conn: WorkItemConnection,
    transition: ValidatedBranchTransition,
    startedAt: number
  ): Promise<boolean> {
    try {
      await this.deleteOperationBranch(conn, transition.branch);
      return true;
    } catch (error) {
      const fields = {
        branch: transition.branch,
        baseHash: transition.baseHash,
        tip: transition.tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      };
      if (await this.deleteLanded(conn, transition.branch)) {
        // No `classification` key: the caller records the cleaned verdict, and
        // adding a value here would make existing classification queries
        // incomplete. `deleteAckLost` is the queryable substrate signal.
        this.logReconciliation("info", conn, {
          ...fields,
          deleteAckLost: true,
        });
        return true;
      }
      // Once reachability (and, for a fresh merge, the exact current row) is
      // proven, ref deletion is repairable housekeeping. Returning a 503 here
      // would invite callers to replay an already-durable PATCH/CREATE.
      this.logReconciliation("warn", conn, {
        ...fields,
        classification: "cleanup_pending",
      });
      return false;
    }
  }

  private async operationBranchRow(
    conn: WorkItemConnection,
    branch: string
  ): Promise<Record<string, unknown> | undefined> {
    const rows = (await conn.unsafe(
      "SELECT name, hash FROM dolt.branches"
    )) as ReadonlyArray<Record<string, unknown>>;
    return rows.find((row) => String(row.name ?? "") === branch);
  }

  private async validateOperationBranch(
    conn: WorkItemConnection,
    branch: string,
    tip: string,
    pending?: PendingBranchState<unknown>
  ): Promise<ValidatedBranchTransition> {
    const commitRows = (await conn.unsafe(
      `SELECT * FROM dolt.commits WHERE commit_hash = ${escapeValue(tip)}`
    )) as ReadonlyArray<Record<string, unknown>>;
    const commit = commitRows.find(
      (row) => String(row.commit_hash ?? "") === tip
    );
    const parentRows = (await conn.unsafe(
      `SELECT * FROM dolt.commit_ancestors WHERE commit_hash = ${escapeValue(tip)}`
    )) as ReadonlyArray<Record<string, unknown>>;
    if (!commit || parentRows.length !== 1) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has unprovable commit evidence; preserving evidence`
      );
    }
    const parent = parentRows[0];
    if (!parent || Number(parent.parent_index) !== 0) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has non-linear history; preserving evidence`
      );
    }
    const baseHash = String(parent.parent_hash ?? "");
    if (
      !baseHash ||
      (pending && baseHash !== pending.baseHash) ||
      (pending?.branchCommit && pending.branchCommit !== tip)
    ) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} moved from its frozen base; preserving evidence`
      );
    }

    const summaries = (await conn.unsafe(
      `SELECT * FROM dolt_diff_summary(${escapeValue(baseHash)}, ${escapeValue(tip)})`
    )) as ReadonlyArray<Record<string, unknown>>;
    const summary = summaries[0];
    // Deployed Doltgres falsifies data_change=false for the real b112 one-row
    // add. The exact row diff below is data authority; summary is schema/scope
    // authority only (bug.5358 approved Rev3 amendment).
    if (
      summaries.length !== 1 ||
      !summary ||
      String(summary.from_table_name ?? "") !== "public.work_items" ||
      String(summary.to_table_name ?? "") !== "public.work_items" ||
      doltBoolean([summary], "schema_change")
    ) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} changed unsupported schema or tables; preserving evidence`
      );
    }
    const diffs = (await conn.unsafe(
      `SELECT * FROM dolt_diff(${escapeValue(baseHash)}, ${escapeValue(tip)}, 'work_items')`
    )) as ReadonlyArray<Record<string, unknown>>;
    if (diffs.length !== 1 || !diffs[0]) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} is not an exact one-row change; preserving evidence`
      );
    }
    const diff = diffs[0];
    const before = snapshotRow(diff, "from_");
    const after = snapshotRow(diff, "to_");
    const commitAt = asEpoch(commit.date);
    if (commitAt === undefined) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has no authoritative commit time; preserving evidence`
      );
    }
    const proof =
      pending?.proof ??
      legacyProofFromMessage(String(commit.message ?? ""), before, after);
    if (!proof || !validateTransitionMatrix(proof, before, after, commitAt)) {
      throw new UnprovableTransitionError(
        `Work-item branch ${branch} failed its operation proof; preserving evidence`
      );
    }
    const expectedDiffType =
      proof.verb === "create"
        ? "added"
        : proof.verb === "delete"
          ? "removed"
          : "modified";
    if (String(diff.diff_type ?? "").toLowerCase() !== expectedDiffType) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has the wrong operation shape; preserving evidence`
      );
    }
    return { branch, baseHash, tip, proof, before, after, commitAt };
  }

  private async proveFreshMergeOutcome(
    conn: WorkItemConnection,
    transition: ValidatedBranchTransition
  ): Promise<void> {
    if (!(await this.branchCommitIsOnMain(conn, transition.tip))) {
      throw new DoltMergeOutcomeUnknownError();
    }
    const id = String(
      transition.proof.verb === "delete"
        ? transition.before.id
        : transition.after.id
    );
    const rows = (await conn.unsafe(
      `SELECT * FROM work_items WHERE id = ${escapeValue(id)} LIMIT 1`
    )) as ReadonlyArray<Record<string, unknown>>;
    if (transition.proof.verb === "delete") {
      if (rows.length !== 0) throw new DoltMergeOutcomeUnknownError();
      return;
    }
    if (!rows[0] || !snapshotsEqual(snapshotRow(rows[0]), transition.after)) {
      throw new DoltMergeOutcomeUnknownError();
    }
  }

  private async resolveOperationBranch<T>(
    conn: WorkItemConnection,
    branch: string,
    pending?: PendingBranchState<T>,
    originalError?: unknown
  ): Promise<T | undefined> {
    const startedAt = Date.now();
    const preserveLevel = "error";
    const preserveFields = {};
    try {
      const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
      assertDoltStatus(checkoutRows, "dolt_checkout");
      await this.abortOwnedMergeIfPresent(conn, branch);
      await this.assertMainClean(conn);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }

    let row: Record<string, unknown> | undefined;
    try {
      row = await this.operationBranchRow(conn, branch);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    if (!row && !pending?.branchCommit) {
      if (pending) throw originalError;
      return undefined;
    }
    let tip: string;
    try {
      tip = row
        ? doltScalar([row], "hash")
        : String(pending?.branchCommit ?? "");
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    if (pending && !pending.branchCommit && tip === pending.baseHash) {
      // The owned ref never acquired a commit; no later sweep can land this intent.
      pending.outcomeSafelyAbsent = true;
      try {
        await this.deleteOperationBranch(conn, branch);
      } catch (error) {
        this.logReconciliation(preserveLevel, conn, {
          ...preserveFields,
          branch,
          baseHash: pending.baseHash,
          tip,
          classification: "preserved_unsafe",
          durationMs: Date.now() - startedAt,
          ...errorFields(error),
        });
        throw this.preservedBranchError(branch, error);
      }
      this.logReconciliation("info", conn, {
        branch,
        baseHash: pending.baseHash,
        tip,
        verb: pending.proof.verb,
        itemId: pending.proof.itemId,
        classification: "empty_deleted",
        durationMs: Date.now() - startedAt,
      });
      throw originalError;
    }
    if (!pending) {
      let currentMain: string;
      try {
        currentMain = doltScalar(
          await conn.unsafe("SELECT dolt_hashof('main') AS dolt_hashof"),
          "dolt_hashof"
        );
      } catch (error) {
        this.logReconciliation(preserveLevel, conn, {
          ...preserveFields,
          branch,
          tip,
          classification: "preserved_unsafe",
          durationMs: Date.now() - startedAt,
          ...errorFields(error),
        });
        throw this.preservedBranchError(branch, error);
      }
      if (tip === currentMain) {
        try {
          await this.deleteOperationBranch(conn, branch);
        } catch (error) {
          this.logReconciliation(preserveLevel, conn, {
            ...preserveFields,
            branch,
            baseHash: currentMain,
            tip,
            classification: "preserved_unsafe",
            durationMs: Date.now() - startedAt,
            ...errorFields(error),
          });
          throw this.preservedBranchError(branch, error);
        }
        this.logReconciliation("info", conn, {
          branch,
          baseHash: currentMain,
          tip,
          classification: "empty_deleted",
          durationMs: Date.now() - startedAt,
        });
        return undefined;
      }
    }

    let reachable: boolean;
    try {
      reachable = await this.branchCommitIsOnMain(conn, tip);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        tip,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    // A restart branch whose exact tip is already reachable from main owns no
    // commits that main does not. This includes a branch-create acknowledgement
    // failure: Dolt can create the ref at the then-current main, lose the ack,
    // and leave the ref behind; once main advances that tip is an old main
    // ancestor. Do not interpret that ancestor commit as a work-item operation
    // commit — its parent diff legitimately describes any repository change,
    // which is what produced `changed unsupported schema or tables` on poly
    // production (poly #169, bug.5358).
    if (reachable && !pending) {
      let cleaned = true;
      try {
        await this.deleteOperationBranch(conn, branch);
      } catch (error) {
        cleaned = await this.deleteLanded(conn, branch);
        this.logReconciliation(cleaned ? "info" : "warn", conn, {
          branch,
          tip,
          ...(cleaned
            ? { deleteAckLost: true }
            : { classification: "reachable_redundant_cleanup_pending" }),
          durationMs: Date.now() - startedAt,
          ...errorFields(error),
        });
      }
      this.logReconciliation("info", conn, {
        branch,
        tip,
        classification: cleaned
          ? "reachable_redundant_cleaned"
          : "reachable_redundant_cleanup_pending",
        durationMs: Date.now() - startedAt,
      });
      return undefined;
    }

    let transition: ValidatedBranchTransition;
    try {
      transition = await this.validateOperationBranch(
        conn,
        branch,
        tip,
        pending as PendingBranchState<unknown> | undefined
      );
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        tip,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }

    if (reachable) {
      if (pending?.requiresFreshOutcomeProof) {
        try {
          await this.proveFreshMergeOutcome(conn, transition);
        } catch (error) {
          this.logReconciliation(preserveLevel, conn, {
            ...preserveFields,
            branch,
            baseHash: transition.baseHash,
            tip,
            verb: transition.proof.verb,
            itemId: transition.proof.itemId,
            classification: "preserved_unsafe",
            durationMs: Date.now() - startedAt,
            ...errorFields(error),
          });
          throw this.preservedBranchError(branch, error);
        }
      }
      if (pending?.result !== undefined)
        conn.context.acknowledge?.(pending.result);
      const cleaned = row
        ? await this.cleanupVerifiedBranch(conn, transition, startedAt)
        : true;
      this.logReconciliation("info", conn, {
        branch,
        baseHash: transition.baseHash,
        tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        classification: cleaned
          ? "reachable_cleaned"
          : "reachable_cleanup_pending",
        durationMs: Date.now() - startedAt,
      });
      return pending?.result;
    }

    let merge: { hash: string; conflicts: number };
    try {
      merge = requireNamedMerge(
        await conn.unsafe(
          `SELECT hash, fast_forward, conflicts, message FROM dolt_merge(${escapeValue(branch)})`
        )
      );
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        baseHash: transition.baseHash,
        tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        classification: "preserved_conflict",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    try {
      await this.proveFreshMergeOutcome(conn, transition);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        baseHash: transition.baseHash,
        tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    if (pending?.result !== undefined)
      conn.context.acknowledge?.(pending.result);
    const cleaned = await this.cleanupVerifiedBranch(
      conn,
      transition,
      startedAt
    );
    this.logReconciliation("info", conn, {
      branch,
      baseHash: transition.baseHash,
      tip,
      verb: transition.proof.verb,
      itemId: transition.proof.itemId,
      mergeHash: merge.hash,
      classification: "merged_verified",
      cleanupPending: !cleaned,
      durationMs: Date.now() - startedAt,
    });
    return pending?.result;
  }

  private async makeMainSafe(conn: WorkItemConnection): Promise<void> {
    try {
      const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
      assertDoltStatus(checkoutRows, "dolt_checkout");
      await this.abortOwnedMergeIfPresent(conn);
      await this.assertMainClean(conn);
    } catch {
      throw new WorkItemsBusyError(
        "Work-item main could not be made safe for reconciliation; retry shortly"
      );
    }
  }

  private async reconcileUnderLock(conn: WorkItemConnection): Promise<void> {
    await this.makeMainSafe(conn);

    let branchRows: ReadonlyArray<Record<string, unknown>>;
    try {
      branchRows = await conn.unsafe("SELECT name, hash FROM dolt.branches");
    } catch {
      throw new WorkItemsBusyError(
        "Work-item branch reconciliation could not list evidence; retry shortly"
      );
    }
    const branches = branchRows
      .map((row) => String(row.name ?? ""))
      .filter((branch) => branch.startsWith(OP_BRANCH_PREFIX))
      .sort();
    // Reads never enter this method. A write preserves unprovable evidence
    // and may quarantine only a structurally verified obsolete operation.
    let tolerated = false;
    for (const branch of branches) {
      try {
        await this.resolveOperationBranch(conn, branch, undefined, undefined);
      } catch (error) {
        // ONLY the structurally-verified arm is quarantinable. A branch whose
        // tip is missing, or whose reachability could not be proven, has
        // established nothing about its contents — parking it could hide
        // arbitrary divergence, so those keep failing closed exactly as
        // before.
        if (!(error instanceof UnprovableTransitionError)) throw error;
        // ONE UNPROVABLE BRANCH MUST NOT BLOCK EVERY FUTURE WRITE.
        // bug.5358 left this arm throwing, which made writes permanently
        // unavailable on a node carrying a single residual branch: nothing
        // deletes a `preserved_unsafe` ref, and this sweep re-walks
        // `dolt.branches` on every request, so no restart clears it. Measured
        // on operator production — a promote failed at 05:27:04Z, the lost
        // `branch.create` ack left `work-item-op/9ee34c81…` behind at
        // 05:28:33Z, and 88 consecutive write attempts 503'd over the next
        // two hours while reads stayed 200.
        //
        // Quarantine rather than delete. The branch reached this arm having
        // ALREADY passed every structural check — linear history, frozen base
        // intact, exactly one `public.work_items` row diff, authoritative
        // commit time — and fails only its transition proof. So it may hold a
        // real one-row write, and deleting it is the data loss bug.5358 was
        // filed to prevent. Renaming it out of the enumerated namespace
        // preserves those commits byte-for-byte with zero data mutation,
        // keeps them reachable for a human to merge, and unblocks writes now.
        // A failed rename still throws: quarantine must not be best-effort,
        // or a write would proceed believing evidence was parked when it was
        // not.
        await this.quarantineOperationBranch(conn, branch, error);
        tolerated = true;
      }
    }
    // Each iteration re-proves `main` itself, so one pass at the end is enough
    // to guarantee the next command never runs on a half-reconciled session.
    if (tolerated) await this.makeMainSafe(conn);
  }

  private async mergeState(
    conn: WorkItemConnection
  ): Promise<Record<string, unknown> | undefined> {
    const rows = (await conn.unsafe(
      "SELECT is_merging, source, source_commit, target, unmerged_tables FROM dolt.merge_status"
    )) as ReadonlyArray<Record<string, unknown>>;
    return rows.find((row) => doltBoolean([row], "is_merging"));
  }

  private async abortOwnedMergeIfPresent(
    conn: WorkItemConnection,
    expectedBranch?: string
  ): Promise<boolean> {
    const state = await this.mergeState(conn);
    if (!state) return false;
    const source = String(state.source ?? "");
    const target = String(state.target ?? "");
    const owned =
      source.startsWith(OP_BRANCH_PREFIX) &&
      (expectedBranch === undefined || source === expectedBranch) &&
      (target === "main" || target === "refs/heads/main");
    if (!owned) throw new ForeignMergeInProgressError();

    await conn.unsafe("SELECT dolt_merge('--abort')");
    if (await this.mergeState(conn)) {
      throw new DoltOperationFailedError("dolt_merge --abort");
    }
    return true;
  }

  private async branchCommitIsOnMain(
    conn: WorkItemConnection,
    branchCommit: string
  ): Promise<boolean> {
    const rows = await conn.unsafe(
      `SELECT dolt_merge_base('main', ${escapeValue(branchCommit)}) AS dolt_merge_base`
    );
    return doltScalar(rows, "dolt_merge_base") === branchCommit;
  }

  private async assertMainClean(conn: WorkItemConnection): Promise<void> {
    const rows = (await conn.unsafe(
      "SELECT table_name FROM dolt.status"
    )) as ReadonlyArray<Record<string, unknown>>;
    if (
      rows.some((row) =>
        String(row.table_name ?? "")
          .toLowerCase()
          .endsWith("work_items")
      )
    ) {
      throw new DirtyWorkItemsMainError();
    }
  }

  private async mutate<T>(
    message: string,
    principalId: string,
    fn: (conn: WorkItemConnection, proof: MutationProof) => Promise<T>,
    options: MutationOptions<T>
  ): Promise<T> {
    return this.withOperationQueue(message, async (context) => {
      try {
        return await this.withGlobalLock(context, async (conn) => {
          await options.preflight?.(conn, options.proof);
          return this.mutateOnBranch(
            conn,
            message,
            requirePrincipal(principalId),
            fn,
            options.proof,
            options.shouldCommit ?? (() => true)
          );
        });
      } catch (error) {
        if (context.abandoned) throw context.abandoned;
        if (!(error instanceof PendingBranchRecoveryError)) throw error;
        try {
          const resolved = await this.withGlobalLock(
            context,
            (conn) =>
              this.resolveOperationBranch(
                conn,
                error.state.branch,
                error.state as PendingBranchState<T>,
                error.originalError
              ),
            { reconcile: "skipped" }
          );
          if (resolved === undefined) throw new DoltMergeOutcomeUnknownError();
          return resolved;
        } catch (recoveryError) {
          // This wrapper belongs only to the CURRENT command. Old orphan preflight
          // failures occur before mutateOnBranch and remain safe admission failures.
          if (error.state.commitAttempted && !error.state.outcomeSafelyAbsent) {
            throw new WorkItemWriteOutcomeUnknownError(
              error.state.operationId,
              error.state.branch,
              error.state.branchCommit,
              error.state.proof.itemId
            );
          }
          throw recoveryError;
        }
      }
    });
  }

  private async mutateOnBranch<T>(
    conn: WorkItemConnection,
    message: string,
    principalId: string,
    fn: (conn: WorkItemConnection, proof: MutationProof) => Promise<T>,
    proof: MutationProof,
    shouldCommit: (result: T) => boolean
  ): Promise<T> {
    const startedAt = Date.now();
    const branch = `${OP_BRANCH_PREFIX}${randomUUID()}`;
    const baseRows = await conn.unsafe(
      "SELECT dolt_hashof('main') AS dolt_hashof"
    );
    conn.context.branch = branch;
    const state: PendingBranchState<T> = {
      operationId: conn.context.operationId,
      branch,
      baseHash: doltScalar(baseRows, "dolt_hashof"),
      proof,
    };
    conn.context.mutationState = state as PendingBranchState<unknown>;
    // Arm recovery before branch-create: the ref can be durable even when the
    // checkout acknowledgement is lost (bug.5358 Rev3).
    try {
      const createRows = await conn.unsafe(
        `SELECT dolt_checkout('-b', ${escapeValue(branch)}, 'main')`
      );
      assertDoltStatus(createRows, "dolt_checkout");

      const result = await fn(conn, proof);
      state.result = result;
      if (!shouldCommit(result)) {
        await this.returnToMainAndDeleteBranch(conn, branch);
        return result;
      }
      const addRows = await conn.unsafe("SELECT dolt_add('work_items')");
      assertDoltStatus(addRows, "dolt_add");
      state.commitAttempted = true;
      const commitRows = await conn.unsafe(
        `SELECT dolt_commit('-m', ${escapeValue(`${COMMIT_TAG}: ${message} by actor:${principalId}`)})`
      );
      const branchCommit = doltCommitHash(commitRows);
      state.branchCommit = branchCommit;

      const mainRows = await conn.unsafe("SELECT dolt_checkout('main')");
      assertDoltStatus(mainRows, "dolt_checkout");
      const transition = await this.validateOperationBranch(
        conn,
        branch,
        branchCommit,
        state as PendingBranchState<unknown>
      );
      state.mergeAttempted = true;
      requireNamedMerge(
        await conn.unsafe(
          `SELECT hash, fast_forward, conflicts, message FROM dolt_merge(${escapeValue(branch)})`
        )
      );
      state.requiresFreshOutcomeProof = true;
      // A merge acknowledgement alone is not success. Reachability and the
      // exact current row are proven while serialization is still held.
      await this.proveFreshMergeOutcome(conn, transition);
      conn.context.acknowledge?.(result);
      await this.cleanupVerifiedBranch(conn, transition, startedAt);
      return result;
    } catch (error) {
      throw new PendingBranchRecoveryError(state, error);
    }
  }

  private async returnToMainAndDeleteBranch(
    conn: WorkItemConnection,
    branch: string
  ): Promise<void> {
    const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
    assertDoltStatus(checkoutRows, "dolt_checkout");
    await this.assertMainClean(conn);
    await this.deleteOperationBranch(conn, branch);
  }

  /**
   * Move an unprovable operation branch out of the swept namespace, loudly.
   * `error` is the proof failure that sent it here and is logged with it, so
   * the quarantine record says WHY this ref could not be proven rather than
   * just that it moved.
   */
  private async quarantineOperationBranch(
    conn: WorkItemConnection,
    branch: string,
    error: unknown
  ): Promise<void> {
    const target = `${QUARANTINE_BRANCH_PREFIX}${branch.slice(
      OP_BRANCH_PREFIX.length
    )}`;
    const rows = await conn.unsafe(
      `SELECT dolt_branch('-m', ${escapeValue(branch)}, ${escapeValue(target)})`
    );
    assertDoltStatus(rows, "dolt_branch");
    this.logReconciliation("warn", conn, {
      branch,
      quarantinedAs: target,
      classification: "quarantined_unprovable",
      ...errorFields(error),
    });
  }

  private async deleteOperationBranch(
    conn: WorkItemConnection,
    branch: string
  ): Promise<void> {
    const rows = await conn.unsafe(
      `SELECT dolt_branch('-D', ${escapeValue(branch)})`
    );
    assertDoltStatus(rows, "dolt_branch");
  }

  /**
   * COMMAND_QUERY_SEPARATION AT RUNTIME, not just in the type system.
   * `work-items-port.md` splits `WorkItemQueryPort` from
   * `WorkItemCommandPort`; this method is why that split has to hold in
   * execution too.
   *
   * `dolt_checkout` is session state, so a WRITE must own its session: pinned
   * connection, FIFO admission, the common per-database writer lock. A READ needs
   * none of that — it reads committed `main`, which is plain SQL. Routing reads
   * through the write lane made read concurrency structurally 1 (a `max: 1`
   * pool behind a single-slot queue), so N concurrent readers serialized.
   * Measured on operator production: `operation.queue` averaged 2660 ms and
   * peaked at 7334 ms while the actual `dml.read` was 677 ms — a dashboard
   * firing four list calls took ~30 s to paint.
   *
   * The read path runs on a pool of its own — `readClient` when the caller
   * passed one, otherwise one the adapter derives from `recreateClient`. It
   * never calls `dolt_checkout`, never takes the lock, and never reconciles,
   * so read concurrency equals that pool's width and no read ever waits on a
   * write. A missing independent read pool is a configuration error.
   *
   * WHY NOT CHECKING OUT IS SAFE: a fresh connection opens on the database's
   * default branch, which is `main`. This lane never moves it, so every read
   * sees committed `main`. Writes never commit to `main` outside their proven
   * `work-item-op/*` merge, so there is no dirty-main window for a reader to
   * observe. Reads remain available through residual branch evidence, which is
   * the bug.5358 guarantee, and they no longer pay to enumerate it.
   */
  /**
   * Resolve the independent query pool. Missing configuration never falls
   * back to writer admission.
   *
   * `recreateClient` is the caller's own factory for a work-items connection,
   * so a pool built from it has the right URL, the right `application_name`
   * shape, and the right driver options by construction — nothing here has to
   * guess a DSN. Reads need their OWN pool rather than a second checkout from
   * the write pool because that pool is `max: 1` on every node in the fleet:
   * sharing it would put every read back behind the in-flight write.
   */
  private validateReadPool(pool: Sql): void {
    if (
      !pool ||
      typeof pool.unsafe !== "function" ||
      pool === this.sql ||
      this.retiredReadPools.has(pool as object)
    ) {
      throw new Error(
        "Read-client factory must return a fresh independent reader pool"
      );
    }
    const knownWidths = [
      ...this.readPools,
      ...(this.readPools.has(pool) ? [] : [pool]),
    ].map((client) => client.options?.max);
    if (
      this.readConnectionBudget !== undefined &&
      (!knownWidths.every((width) => Number.isInteger(width) && width > 0) ||
        knownWidths.reduce((sum, width) => sum + width, 0) >
          this.readConnectionBudget)
    ) {
      throw new Error(
        "Reader generations exceed the declared readConnectionBudget"
      );
    }
    this.readPools.add(pool);
  }

  /** Stop new assignments immediately; existing siblings retain their own deadlines. */
  private retireReadPool(
    pool: Sql,
    context: OperationContext,
    stage: string
  ): void {
    if (this.readClient === pool) this.readClient = undefined;
    this.retiredReadPools.add(pool as object);
    const waiters = this.readWaiters.get(pool) ?? [];
    this.readWaiters.delete(pool);
    for (const waiter of waiters)
      waiter.reject(
        new WorkItemsCapacityError(
          this.unknownReadPools.has(pool as object) ? "unknown" : "pending"
        )
      );
    if (
      this.drainingReadPools.has(pool as object) ||
      (this.readPending.get(pool) ?? 0) > 0 ||
      this.unknownReadPools.has(pool as object)
    )
      return;
    const draining = Promise.resolve()
      // All native results arrived. Closing idle sockets cannot abandon SQL.
      .then(() => pool.end({ timeout: 0 }))
      .then(() => {
        this.readPools.delete(pool);
        this.readPending.delete(pool);
        this.logStage("info", context, "read_pool.drain", "complete", {
          failedStage: stage,
        });
      })
      .catch((error) => {
        // Unknown shutdown retains its generation slot; never grow without bound.
        this.logStage("error", context, "read_pool.drain", "error", {
          ...errorFields(error),
          failedStage: stage,
        });
      });
    this.drainingReadPools.set(pool as object, draining);
  }

  private readWidth(pool: Sql): number {
    const width = pool.options?.max;
    return typeof width === "number" && Number.isInteger(width) && width > 0
      ? width
      : 1;
  }

  private async enterReaderQueue(pool: Sql, deadline: number): Promise<void> {
    if (this.retiredReadPools.has(pool as object))
      throw new WorkItemsCapacityError("pending");
    if ((this.readPending.get(pool) ?? 0) < this.readWidth(pool)) {
      this.readPending.set(pool, (this.readPending.get(pool) ?? 0) + 1);
      return;
    }
    const waiters = this.readWaiters.get(pool) ?? [];
    if (waiters.length >= 32) throw new WorkItemsCapacityError("pending");
    this.readWaiters.set(pool, waiters);
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter: ReadWaiter = {
        deadline,
        start: () => {
          clearTimeout(timer);
          this.readPending.set(pool, (this.readPending.get(pool) ?? 0) + 1);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      waiters.push(waiter);
      timer = setTimeout(
        () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          waiter.reject(
            new WorkItemsBusyError(
              "Work-item read deadline elapsed before native dispatch"
            )
          );
        },
        Math.max(1, deadline - Date.now())
      );
    });
  }

  private releaseReaderPermit(
    pool: Sql,
    context: OperationContext,
    stage: string
  ): void {
    this.readPending.set(
      pool,
      Math.max(0, (this.readPending.get(pool) ?? 1) - 1)
    );
    if (
      this.retiredReadPools.has(pool as object) ||
      this.unknownReadPools.has(pool as object)
    ) {
      this.retireReadPool(pool, context, stage);
      return;
    }
    const waiters = this.readWaiters.get(pool) ?? [];
    while (
      waiters.length &&
      (this.readPending.get(pool) ?? 0) < this.readWidth(pool)
    ) {
      const waiter = waiters.shift();
      if (!waiter) break;
      if (Date.now() >= waiter.deadline)
        waiter.reject(
          new WorkItemsBusyError(
            "Work-item read deadline elapsed before native dispatch"
          )
        );
      else waiter.start();
    }
    if (!waiters.length) this.readWaiters.delete(pool);
  }

  private async executeReadQuery(
    pool: Sql,
    context: OperationContext,
    query: string,
    deadline: number = Date.now() + this.queryTimeoutMs
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const stage = queryStage(query);
    const startedAt = Date.now();
    if (startedAt >= deadline)
      throw new WorkItemsBusyError(
        "Work-item read deadline elapsed before native dispatch"
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await this.enterReaderQueue(pool, deadline);
    let nativeStarted = false;
    const native = Promise.resolve().then(() => {
      if (Date.now() >= deadline || this.retiredReadPools.has(pool as object))
        throw new WorkItemsCapacityError("pending");
      nativeStarted = true;
      return pool.unsafe(query);
    });
    const settled = native
      .then(
        (rows) => rows,
        (error: unknown) => {
          if (nativeStarted && !isServerSqlError(error))
            this.unknownReadPools.add(pool as object);
          throw error;
        }
      )
      .finally(() => {
        this.releaseReaderPermit(pool, context, stage);
      });
    try {
      return await Promise.race([
        settled.then(
          (rows) => rows as ReadonlyArray<Record<string, unknown>>
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              this.retireReadPool(pool, context, stage);
              reject(
                new WorkItemsBusyError(
                  `Work-item read timed out during ${stage}; retry shortly`
                )
              );
            },
            Math.max(1, deadline - Date.now())
          );
        })
      ]);
    } catch (error) {
      if (this.unknownReadPools.has(pool as object))
        this.retireReadPool(pool, context, stage);
      this.logStage("error", context, stage, "error", {
        ...errorFields(error),
        durationMs: Date.now() - startedAt
      });
      if (isConnectionTerminal(error))
        throw new WorkItemsBusyError(
          `Work-item reader connection ended during ${stage}; retry shortly`
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private resolveReadPool(): Sql {
    if (this.readClient) return this.readClient;
    if (this.readPools.size >= 2)
      throw new WorkItemsCapacityError(
        [...this.readPools].some((pool) =>
          this.unknownReadPools.has(pool as object)
        )
          ? "unknown"
          : "pending"
      );
    if (!this.recreateReadClient) {
      throw new WorkItemsBusyError(
        "Work-item read lane requires a fresh connection; retry shortly"
      );
    }
    try {
      this.readClient = this.recreateReadClient();
      this.validateReadPool(this.readClient);
    } catch (error) {
      const candidate = this.readClient;
      this.readClient = undefined;
      if (
        candidate &&
        candidate !== this.sql &&
        typeof candidate.unsafe === "function" &&
        !this.readPools.has(candidate) &&
        !this.retiredReadPools.has(candidate as object)
      ) {
        this.readPools.add(candidate);
        this.retireReadPool(
          candidate,
          { operationId: randomUUID(), operation: "configure reader" },
          "reader.configuration"
        );
      }
      this.logger.warn(
        {
          event: "adapter.work_items.read_pool_derive_failed",
          ...errorFields(error),
        },
        "work_items could not rebuild its dedicated read pool"
      );
      throw new WorkItemsBusyError(
        "Work-item read lane could not reconnect; retry shortly"
      );
    }
    this.logger.info(
      { event: "adapter.work_items.read_pool_derived" },
      "work_items derived a dedicated read pool from recreateClient"
    );
    return this.readClient;
  }

  private async readOnCleanMain<T>(
    fn: (conn: WorkItemConnection) => Promise<T>
  ): Promise<T> {
    const readPool = this.resolveReadPool();
    const context = { operationId: randomUUID(), operation: "read work items" };
    const deadline = Date.now() + this.queryTimeoutMs;
    // No reserve, checkout, advisory lock, reconciliation or writer-pool call.
    return fn({
      pool: readPool,
      context,
      unsafe: (query) =>
        this.executeReadQuery(readPool, context, query, deadline)
    });
  }

  private async getWith(conn: WorkItemConnection, id: WorkItemId) {
    const rows = await conn.unsafe(
      `SELECT * FROM work_items WHERE id = ${escapeValue(id as string)} LIMIT 1`
    );
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : undefined;
  }

  async get(id: WorkItemId): Promise<WorkItem | null> {
    return this.readOnCleanMain(async (conn) => {
      const row = await this.getWith(conn, id);
      return row ? rowToWorkItem(row) : null;
    });
  }

  async list(query: WorkQuery = {}): Promise<{
    items: WorkItem[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean };
  }> {
    if (
      (query.rankMin !== undefined && !Number.isFinite(query.rankMin)) ||
      (query.rankMax !== undefined && !Number.isFinite(query.rankMax)) ||
      (query.rankMin !== undefined &&
        query.rankMax !== undefined &&
        query.rankMin > query.rankMax)
    )
      throw new Error("invalid rank range");
    const order = normalizeWorkItemOrder(query);
    const conditions: string[] = [];
    const rankConditions: string[] = [];
    const rankExpression = order.sortBy === "rankScore" ? "__sort_value" : `(${rankScoreSql()})`;
    if (query.ids?.length) {
      conditions.push(
        `id IN (${query.ids.map((id) => escapeValue(id as string)).join(", ")})`
      );
    }
    if (query.types?.length) {
      conditions.push(`type IN (${query.types.map(escapeValue).join(", ")})`);
    }
    if (query.statuses?.length) {
      conditions.push(
        `status IN (${query.statuses.map(escapeValue).join(", ")})`
      );
    }
    if (query.actor && query.actor !== "either") conditions.push("FALSE");
    if (query.projectId) {
      conditions.push(`project_id = ${escapeValue(query.projectId as string)}`);
    }
    if (query.projectIds?.length)
      conditions.push(
        `project_id IN (${query.projectIds.map(escapeValue).join(", ")})`
      );
    if (query.rankMin !== undefined)
      rankConditions.push(`${rankExpression} >= ${Number(query.rankMin)}`);
    if (query.rankMax !== undefined)
      rankConditions.push(`${rankExpression} <= ${Number(query.rankMax)}`);
    if (query.node) {
      const nodes = Array.isArray(query.node) ? query.node : [query.node];
      if (nodes.length) conditions.push(`node IN (${nodes.map(escapeValue).join(", ")})`);
    }
    if (query.labels?.length) {
      // Doltgres has no `jsonb_array_elements_text`, so match against the
      // serialized array text. A label is a JSON element `"<label>"`; the quotes
      // delimit elements, so `%"<label>"%` is an exact any-of element match.
      conditions.push(
        `(${query.labels
          .map(
            (label) =>
              `CAST(labels AS TEXT) LIKE ${escapeValue(`%"${label}"%`)}`
          )
          .join(" OR ")})`
      );
    }
    if (query.labelPrefix) {
      // `"<prefix>` (opening quote, no closing) matches only elements whose text
      // starts with the prefix — elements are quote-delimited in the array text.
      conditions.push(
        `CAST(labels AS TEXT) LIKE ${escapeValue(`%"${query.labelPrefix}%`)}`
      );
    }
    if (query.scored !== undefined) {
      // Scored == a complete 6-axis score; rankScoreSql() is NULL otherwise.
      rankConditions.push(
        `${rankExpression} IS ${query.scored ? "NOT NULL" : "NULL"}`
      );
    }
    if (order.sortBy !== "rankScore") conditions.push(...rankConditions);
    const textNeedle = query.text?.toLowerCase();
    const initialCursor = query.cursor
      ? decodeCursor(query.cursor, order, queryIdentity(query))
      : undefined;
    const keyExpression =
      order.sortBy === "rankScore"
        ? rankScoreSql()
        : {
            priority: "priority",
            rank: "rank",
            type: "type",
            status: "status",
            projectId: "project_id",
            estimate: "estimate",
            // NOW() retains hidden nanoseconds, but native timestamp text I/O
            // exposes microseconds. Use that same precision for ordering and
            // seeking, so the projected cursor can roundtrip the boundary.
            createdAt: "date_trunc('microseconds', created_at)",
            updatedAt: "date_trunc('microseconds', updated_at)"
          }[order.sortBy];
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    // Text filtering happens after native ordering. Decouple its scan window
    // from the response size to avoid re-ranking the backlog for every pagelet.
    const scanLimit = textNeedle ? 501 : limit + 1;
    const nativeCursor = (row: Record<string, unknown>): WorkItemCursor => ({
      v: 2,
      filter: queryIdentity(query),
      ...order,
      key: row.__sort_key === null ? null : String(row.__sort_key),
      id: String(row.id)
    });
    const seek = (cursor: WorkItemCursor | undefined) => {
      if (!cursor) return "";
      const afterId = `id > ${escapeValue(cursor.id)}`;
      if (cursor.key === null)
        return `__sort_value IS NULL AND ${afterId}`;
      const nativeType =
        order.sortBy === "createdAt" || order.sortBy === "updatedAt"
          ? "TIMESTAMP WITH TIME ZONE"
          : ["type", "status", "projectId"].includes(order.sortBy)
            ? "TEXT"
            : "DOUBLE PRECISION";
      const key = `CAST(${escapeValue(cursor.key)} AS ${nativeType})`;
      return `__sort_value IS NULL OR __sort_value ${order.sortDirection === "asc" ? ">" : "<"} ${key} OR (__sort_value = ${key} AND ${afterId})`;
    };
    // Structural filters → derived native key → seek/order → bounded batch.
    // Text folding stays in JS because native LOWER on cold TEXT can panic.
    // Every batch shares readOnCleanMain's ONE deadline and captured pool.
    const matchedRows = await this.readOnCleanMain(async (conn) => {
      const matches: Record<string, unknown>[] = [];
      let cursor = initialCursor;
      if (cursor?.keyRef) {
        const row = await this.getWith(conn, toWorkItemId(cursor.id));
        const key = row?.project_id;
        if (typeof key !== "string" || createHash("sha256").update(key).digest("hex") !== cursor.keyRef) throw new InvalidCursorError();
        cursor = { ...cursor, key, keyRef: undefined };
      }
      while (true) {
        const outerConditions = order.sortBy === "rankScore" ? [...rankConditions] : [];
        const seekCondition = seek(cursor);
        if (seekCondition) outerConditions.push(seekCondition);
        const outerWhere = outerConditions.length
          ? `WHERE ${outerConditions.map((condition) => `(${condition})`).join(" AND ")}`
          : "";
        const rows = await conn.unsafe(
          `SELECT ordered.*, CAST(__sort_value AS TEXT) AS __sort_key FROM (SELECT work_items.*, ${keyExpression} AS __sort_value FROM work_items ${where}) AS ordered ${outerWhere} ORDER BY CASE WHEN __sort_value IS NULL THEN 1 ELSE 0 END ASC, __sort_value ${order.sortDirection.toUpperCase()}, id ASC LIMIT ${scanLimit}`
        );
        for (const row of rows) {
          if (
            !textNeedle ||
            [row.id, row.title, row.summary, ...jsonArrayOf<string>(row.labels)].some((value) =>
              String(value ?? "")
                .toLowerCase()
                .includes(textNeedle)
            )
          )
            matches.push(row);
          if (matches.length > limit) return matches;
        }
        if (!textNeedle || rows.length < scanLimit) return matches;
        const last = rows[rows.length - 1];
        if (!last) return matches;
        cursor = nativeCursor(last);
      }
    });
    const hasMore = matchedRows.length > limit;
    const pageRows = matchedRows.slice(0, limit);
    const items = pageRows.map(rowToWorkItem);
    const last = pageRows[pageRows.length - 1];
    const lastCursor = last ? nativeCursor(last) : undefined;
    const encodedCursor = lastCursor?.sortBy === "projectId" && lastCursor.key !== null ? { ...lastCursor, key: null, keyRef: createHash("sha256").update(lastCursor.key).digest("hex") } : lastCursor;
    const endCursor = hasMore && encodedCursor ? encodeCursor(encodedCursor) : null;
    return {
      items,
      pageInfo: { endCursor, hasMore },
      ...(endCursor && { nextCursor: endCursor })
    };
  }

  async create(
    input: WorkItemsCreateInput,
    principalId: string
  ): Promise<WorkItem> {
    const principal = requirePrincipal(principalId);
    const scores =
      input.scores === undefined
        ? undefined
        : (validScores(input.scores) ?? undefined);
    const createOnce = (allocatedId?: string) =>
      this.mutate(
        "create work item",
        principal,
        async (conn, proof) => {
          const insert = async (allocatedId: string) => {
            const columns = [
              "id",
              "type",
              "title",
              "status",
              "node",
              "created_by_principal_id",
            ];
            const values = [
              escapeValue(allocatedId),
              escapeValue(input.type),
              escapeValue(input.title),
              escapeValue(input.status ?? "needs_triage"),
              escapeValue(input.node ?? "shared"),
              escapeValue(principal),
            ];
            const add = (column: string, value: unknown) => {
              if (value === undefined) return;
              columns.push(column);
              values.push(escapeValue(value));
            };
            add("summary", input.summary);
            add("outcome", input.outcome);
            add("project_id", input.projectId);
            add("parent_id", input.parentId);
            add("priority", input.priority);
            add("rank", input.rank);
            add("estimate", input.estimate);
            add("scores", scores);
            add("assignees", input.assignees);
            add("labels", input.labels);
            add("spec_refs", input.specRefs);
            const rows = await conn.unsafe(
              `INSERT INTO work_items (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING *`
            );
            const row = rows[0] as Record<string, unknown> | undefined;
            if (!row) throw new Error("INSERT returned no row");
            proof.itemId = allocatedId;
            proof.afterRow = row;
            return rowToWorkItem(row);
          };

          if (allocatedId) return insert(allocatedId);

          const idRows = await conn.unsafe(
            `SELECT id FROM work_items WHERE type = ${escapeValue(input.type)}`
          );
          let maxSuffix = this.idFloor - 1;
          for (const row of idRows as ReadonlyArray<Record<string, unknown>>) {
            const suffix = parseSuffix(String(row.id), input.type);
            if (suffix !== null && suffix > maxSuffix) maxSuffix = suffix;
          }
          const nextId = `${input.type}.${String(maxSuffix + 1).padStart(4, "0")}`;
          try {
            return await insert(nextId);
          } catch (error) {
            if (isDuplicateError(error)) {
              throw new WorkItemAlreadyExistsError(nextId);
            }
            throw error;
          }
        },
        {
          proof: { verb: "create", principal },
        }
      );

    if (input.id) {
      const requested = String(input.id);
      if (!requested.startsWith(`${input.type}.`)) {
        throw new Error(
          `Provided id '${requested}' does not match type '${input.type}'`
        );
      }
      try {
        return await createOnce(requested);
      } catch (error) {
        if (isDuplicateError(error)) {
          throw new WorkItemAlreadyExistsError(requested);
        }
        throw error;
      }
    }

    let lastCollisionId = `${input.type}.${this.idFloor}`;
    for (let attempt = 0; attempt < AUTO_ID_RETRIES; attempt += 1) {
      try {
        return await createOnce();
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        const match = /work item id '([^']+)'/.exec(
          error instanceof Error ? error.message : ""
        );
        if (match?.[1]) lastCollisionId = match[1];
      }
    }
    throw new WorkItemAlreadyExistsError(lastCollisionId);
  }

  async patch(
    input: WorkItemsPatchInput,
    principalId: string
  ): Promise<WorkItem> {
    const principal = requirePrincipal(principalId);
    const id = input.id as string;
    const expectedRevision = parseExpectedRevision(input.expectedRevision);
    const set: WorkItemsPatchSet =
      input.set.scores === undefined
        ? input.set
        : {
            ...input.set,
            scores: validScores(input.set.scores),
          };
    const clauses: string[] = [];
    const setKeys: (keyof WorkItemsPatchSet)[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
      keyof WorkItemsPatchSet,
      string,
    ][]) {
      const value = set[key];
      if (value !== undefined) {
        clauses.push(`${column} = ${escapeValue(value)}`);
        setKeys.push(key);
      }
    }
    const triageOnly =
      setKeys.length > 0 && setKeys.every((key) => TRIAGE_PATCH_KEYS.has(key));
    const permits = (row: Record<string, unknown>) =>
      triageOnly || mayMutate(row, principal);
    const revisionConflict = (row: Record<string, unknown>) => {
      const currentRevision = Number(row.revision ?? 0);
      return expectedRevision !== undefined &&
        currentRevision !== expectedRevision
        ? new WorkItemRevisionConflictError(
            id,
            expectedRevision,
            currentRevision
          )
        : undefined;
    };
    if (!clauses.length) {
      return this.readOnCleanMain(async (conn) => {
        const current = await this.getWith(conn, input.id);
        if (!current) throw new Error(`Work item not found: ${id}`);
        if (!mayMutate(current, principal)) {
          throw new WorkItemAuthorizationError(id);
        }
        const conflict = revisionConflict(current);
        if (conflict) throw conflict;
        return rowToWorkItem(current);
      });
    }

    const where = [`id = ${escapeValue(id)}`];
    if (!triageOnly) {
      where.push(
        `(created_by_principal_id IS NULL OR created_by_principal_id = ${escapeValue(principal)})`
      );
    }
    if (expectedRevision !== undefined) {
      where.push(`revision = ${escapeValue(expectedRevision)}`);
    }
    const result = await this.mutate<WorkItem | WorkItemRevisionConflictError>(
      `patch ${id}`,
      principal,
      async (conn, proof) => {
        clauses.push("revision = revision + 1", "updated_at = NOW()");
        const rows = await conn.unsafe(
          `UPDATE work_items SET ${clauses.join(", ")} WHERE ${where.join(" AND ")} RETURNING *`
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) {
          // CAS lost after preflight: a writer outside this lock moved the
          // revision. Returned, not thrown, so `shouldCommit` drops the empty
          // op branch with nothing committed.
          const current = await this.getWith(conn, input.id);
          const conflict =
            current && permits(current) ? revisionConflict(current) : undefined;
          if (conflict) return conflict;
          await this.throwMissingOrUnauthorized(conn, input.id);
        }
        proof.afterRow = row as Record<string, unknown>;
        return rowToWorkItem(row as Record<string, unknown>);
      },
      {
        proof: {
          verb: "patch",
          principal,
          itemId: id,
          expectedRevision,
          patchValues: Object.fromEntries(
            setKeys.map((key) => [PATCH_COLUMNS[key], set[key]])
          ),
        },
        preflight: async (conn, proof) => {
          const current = await this.getWith(conn, input.id);
          if (!current) throw new Error(`Work item not found: ${id}`);
          if (!permits(current)) {
            throw new WorkItemAuthorizationError(id);
          }
          const conflict = revisionConflict(current);
          if (conflict) throw conflict;
          proof.beforeRow = current;
        },
        shouldCommit: (value) =>
          !(value instanceof WorkItemRevisionConflictError),
      }
    );
    if (result instanceof WorkItemRevisionConflictError) throw result;
    return result;
  }

  async delete(_id: WorkItemId, _principalId: string): Promise<boolean> {
    throw new WorkItemDeletionRetiredError();
  }

  private async throwMissingOrUnauthorized(
    conn: WorkItemConnection,
    id: WorkItemId
  ): Promise<never> {
    if (await this.getWith(conn, id)) {
      throw new WorkItemAuthorizationError(id as string);
    }
    throw new Error(`Work item not found: ${id as string}`);
  }

  async listRelations(id: WorkItemId): Promise<WorkRelation[]> {
    const rows = await this.readOnCleanMain(
      async (conn) =>
        (await conn.unsafe(
          `SELECT id, parent_id, blocked_by FROM work_items WHERE id = ${escapeValue(id as string)} OR parent_id = ${escapeValue(id as string)} OR blocked_by = ${escapeValue(id as string)}`
        )) as ReadonlyArray<Record<string, unknown>>
    );
    const relations: WorkRelation[] = [];
    for (const row of rows) {
      const rowId = toWorkItemId(String(row.id));
      if (row.parent_id) {
        relations.push({
          fromId: toWorkItemId(String(row.parent_id)),
          toId: rowId,
          type: "parent_of",
        });
      }
      if (row.blocked_by) {
        relations.push({
          fromId: toWorkItemId(String(row.blocked_by)),
          toId: rowId,
          type: "blocks",
        });
      }
    }
    return relations;
  }
}
