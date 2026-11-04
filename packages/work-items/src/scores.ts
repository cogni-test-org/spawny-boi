// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/scores`
 * Purpose: The one validator and rank function for evaluation `scores` (story.5111).
 * Scope: Pure functions. No I/O, no zod, no runtime configuration.
 * Invariants:
 *   - SCORES_BOUNDS_IN_PACKAGE: every write path (adapter, HTTP contract, agent tool)
 *     runs `parseWorkItemScores`; nobody re-states the rules.
 *   - SCORE_NEEDS_EVIDENCE: v ≥ 4 carries an `ev` URL.
 *   - EV_SAFE_HTTPS: `ev` is absolute HTTPS without credentials, on any hostname, ≤ 300 chars.
 *   - SCORES_MAX_1KB: the serialized object is ≤ 1024 UTF-8 bytes.
 *   - RANK_UNKNOWN_IS_UNDEFINED: a missing or 0 rank axis gives no rank, never 0.
 * Side-effects: none
 * Links: hub work-item-scores-design
 * @public
 */

import type { WorkItemScore, WorkItemScores } from "./types.js";

/** Axis ids are config (hub `work-item-scores-design`), never a closed enum. */
export const WORK_ITEM_SCORE_AXIS_ID = /^[a-z][a-z0-9_]{0,31}$/;
export const WORK_ITEM_SCORES_MAX_AXES = 12;
export const WORK_ITEM_SCORE_MIN = 0;
export const WORK_ITEM_SCORE_MAX = 5;
/** v ≥ this needs an evidence URL (SCORE_NEEDS_EVIDENCE). */
export const WORK_ITEM_SCORE_EVIDENCE_FROM = 4;
export const WORK_ITEM_SCORE_EV_MAX_CHARS = 300;
export const WORK_ITEM_SCORES_MAX_BYTES = 1024;

export type WorkItemScoresIssueCode =
  | "not_object"
  | "too_many_axes"
  | "invalid_axis_id"
  | "invalid_entry"
  | "unknown_property"
  | "invalid_value"
  | "evidence_required"
  | "evidence_not_string"
  | "evidence_too_long"
  | "evidence_invalid_url"
  | "evidence_not_https"
  | "too_large";

export interface WorkItemScoresIssue {
  readonly code: WorkItemScoresIssueCode;
  /** Path below `scores`, e.g. `["goal", "ev"]`; empty for the whole object. */
  readonly path: readonly string[];
  readonly message: string;
}

export type WorkItemScoresParseResult =
  | { readonly ok: true; readonly value: WorkItemScores | null }
  | { readonly ok: false; readonly issues: readonly WorkItemScoresIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function evidenceIssue(
  axis: string,
  ev: string
): WorkItemScoresIssue | undefined {
  const path = [axis, "ev"];
  if (ev.length > WORK_ITEM_SCORE_EV_MAX_CHARS) {
    return {
      code: "evidence_too_long",
      path,
      message: `ev must be at most ${WORK_ITEM_SCORE_EV_MAX_CHARS} characters`,
    };
  }
  let url: URL;
  try {
    url = new URL(ev);
  } catch {
    return { code: "evidence_invalid_url", path, message: "ev must be a URL" };
  }
  if (url.protocol !== "https:") {
    return { code: "evidence_not_https", path, message: "ev must be https" };
  }
  if (
    !/^https:\/\//i.test(ev) ||
    /[\u0000-\u0020\u007f]/.test(ev) ||
    url.username ||
    url.password
  ) {
    return {
      code: "evidence_invalid_url",
      path,
      message: "ev must be an absolute HTTPS URL without credentials",
    };
  }
  return undefined;
}

/**
 * Validate a `scores` write. `null` is valid and means "clear the field".
 * On success, `value` holds only `v`/`ev` per axis (a fresh object).
 */
export function parseWorkItemScores(input: unknown): WorkItemScoresParseResult {
  if (input === null) return { ok: true, value: null };
  if (!isPlainObject(input)) {
    return {
      ok: false,
      issues: [
        {
          code: "not_object",
          path: [],
          message: "scores must be an object or null",
        },
      ],
    };
  }
  const issues: WorkItemScoresIssue[] = [];
  const entries = Object.entries(input);
  if (entries.length > WORK_ITEM_SCORES_MAX_AXES) {
    issues.push({
      code: "too_many_axes",
      path: [],
      message: `scores may carry at most ${WORK_ITEM_SCORES_MAX_AXES} axes`,
    });
  }
  const value: Record<string, WorkItemScore> = {};
  for (const [axis, entry] of entries) {
    if (!WORK_ITEM_SCORE_AXIS_ID.test(axis)) {
      issues.push({
        code: "invalid_axis_id",
        path: [axis],
        message: `axis id must match ${WORK_ITEM_SCORE_AXIS_ID.source}`,
      });
      continue;
    }
    if (!isPlainObject(entry)) {
      issues.push({
        code: "invalid_entry",
        path: [axis],
        message: "each axis must be an object { v, ev? }",
      });
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "v" && key !== "ev") {
        issues.push({
          code: "unknown_property",
          path: [axis, key],
          message: `unknown property '${key}'; an axis holds only v and ev`,
        });
      }
    }
    const { v, ev } = entry;
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < WORK_ITEM_SCORE_MIN ||
      v > WORK_ITEM_SCORE_MAX
    ) {
      issues.push({
        code: "invalid_value",
        path: [axis, "v"],
        message: `v must be an integer ${WORK_ITEM_SCORE_MIN}–${WORK_ITEM_SCORE_MAX}`,
      });
      continue;
    }
    if (ev === undefined) {
      if (v >= WORK_ITEM_SCORE_EVIDENCE_FROM) {
        issues.push({
          code: "evidence_required",
          path: [axis, "ev"],
          message: `a score of ${WORK_ITEM_SCORE_EVIDENCE_FROM} or more needs an evidence URL (SCORE_NEEDS_EVIDENCE)`,
        });
        continue;
      }
      value[axis] = { v };
      continue;
    }
    if (typeof ev !== "string") {
      issues.push({
        code: "evidence_not_string",
        path: [axis, "ev"],
        message: "ev must be a URL string",
      });
      continue;
    }
    const evIssue = evidenceIssue(axis, ev);
    if (evIssue) {
      issues.push(evIssue);
      continue;
    }
    value[axis] = { v, ev };
  }
  if (issues.length) return { ok: false, issues };
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > WORK_ITEM_SCORES_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        {
          code: "too_large",
          path: [],
          message: `scores serialize to ${bytes} bytes; the limit is ${WORK_ITEM_SCORES_MAX_BYTES}`,
        },
      ],
    };
  }
  return { ok: true, value };
}

export { EASE_ITERATIONS } from "./rank-policy.js";
export { evaluateRank as rankScore } from "./rank-policy.js";
