// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/dao-goals`
 * Purpose: Selects the approved DAO goals every AI loop reads, and renders the cognition Goals section.
 * Scope: Pure selection + shape (which rows count) + render. Does not perform I/O; the SQL read lives in the Doltgres adapter's `listActiveGoals`.
 * Invariants:
 *   - ONE_GOAL_LIST: a goal is a merged row with `entry_type = 'goal'` whose id
 *     starts `goal-`, not deprecated. A goal is a human commitment, not a
 *     `hypothesis`: it is admin-merged and its confidence is never recomputed
 *     from citations. No new table — `entry_type` is plain text.
 *   - NO_GOAL_CAP: every active goal is returned, sorted by id. There is no
 *     count cap (Derek, 2026-10-21: caps are a hack; the admin merge is the
 *     only gate). The list is never truncated or thrown away.
 *   - NO_GOALS_FAILS_LOUD: zero goals is an empty array the caller must render
 *     visibly (the cognition bundle prints `no approved goals` plus the
 *     bootstrap instruction, `GOALS_BOOTSTRAP_INSTRUCTION`).
 *   - GOAL_RETIRED_BY_SUPERSEDES: a goal cited by a merged `supersedes` edge is
 *     inactive (DEPRECATE_NOT_DELETE; no contribution op sets `status`).
 *   - GOALS_RENDER_SHIPS_BY_RELEASE: `resolveGoals` + `renderGoalsLines` are the
 *     one cognition `## Goals` renderer every node calls; nodes keep only the
 *     call site (node-goals-bootstrap, story.5101).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/dao-goals-design
 * @public
 */

/** The entry type of a DAO goal atom. */
export const GOAL_ENTRY_TYPE = "goal" as const;
/** Id prefix every DAO goal atom carries (`goal-<slug>`). */
export const GOAL_ID_PREFIX = "goal-" as const;
/** The citation type whose merged edge onto a goal retires it. */
export const GOAL_RETIRING_EDGE = "supersedes" as const;

/** A hub row id in the goal namespace (GOAL_CHANGE_IS_NODE_ADMIN gates key on it). */
export function isGoalRowId(rowId: unknown): boolean {
  return typeof rowId === "string" && rowId.startsWith(GOAL_ID_PREFIX);
}

/** One approved DAO goal, as every reader sees it. */
export interface ActiveGoal {
  id: string;
  title: string;
  content: string;
  /** The goal's `By:` deadline (`evaluate_at`), when set. */
  evaluateAt: Date | null;
}

/** The row fields goal selection needs; both adapters project to this. */
export interface GoalCandidateRow {
  id: string;
  entryType: string | null | undefined;
  status?: string | null | undefined;
  title: string;
  content: string;
  evaluateAt: Date | null;
}

/**
 * True iff the row is an active DAO goal atom (ONE_GOAL_LIST): a `goal-*` goal
 * row that is neither deprecated nor superseded (GOAL_RETIRED_BY_SUPERSEDES).
 */
export function isActiveGoalRow(
  row: GoalCandidateRow,
  supersededIds: ReadonlySet<string> = new Set()
): boolean {
  return (
    row.entryType === GOAL_ENTRY_TYPE &&
    row.id.startsWith(GOAL_ID_PREFIX) &&
    row.status !== "deprecated" &&
    !supersededIds.has(row.id)
  );
}

/** Filter candidate rows to the active goal list, sorted by id (NO_GOAL_CAP). */
export function selectActiveGoals(
  rows: readonly GoalCandidateRow[],
  supersededIds: ReadonlySet<string> = new Set()
): ActiveGoal[] {
  const goals = rows
    .filter((r) => isActiveGoalRow(r, supersededIds))
    .map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      evaluateAt: r.evaluateAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return goals;
}

// ---------------------------------------------------------------------------
// Cognition `## Goals` section — the one renderer every node's bundle calls
// ---------------------------------------------------------------------------

/**
 * The zero-goal bootstrap instruction (node-goals-bootstrap, option B). Rendered
 * right after `no approved goals` so a fresh node's first agent asks its admin
 * for goals instead of inventing them.
 */
export const GOALS_BOOTSTRAP_INSTRUCTION =
  "no approved goals. Ask your node admin for the goals (one or more) that serve the mission above (outcome, KPI with its exact read, baseline, target, By date). File them in ONE contribution as `goal-<slug>` inserts (`entryType: goal`, `domain: strategy`, `evaluateAt` = the By date) and hand the admin the inbox link. Never invent goals, and never merge them yourself. If the mission is still the starter placeholder, settle it with the admin first." as const;

/**
 * The Goals section state. `unavailable` is a visible line, never an omitted
 * section (NO_GOALS_FAILS_LOUD): a session must be able to tell "no goals" from
 * "could not read goals".
 */
export type GoalsSection =
  | { status: "ok"; goals: readonly ActiveGoal[] }
  | { status: "unavailable"; reason: string };

/** Minimal read surface `resolveGoals` needs — `KnowledgeStorePort.listActiveGoals`. */
export interface GoalsLookupPort {
  listActiveGoals(): Promise<readonly ActiveGoal[]>;
}

/**
 * Read the approved goals by one direct query. A read failure or an
 * unconfigured hub becomes a visible `unavailable` state rather than a missing
 * section.
 */
export async function resolveGoals(
  port: GoalsLookupPort | undefined
): Promise<GoalsSection> {
  if (!port) {
    return { status: "unavailable", reason: "knowledge hub not configured" };
  }
  try {
    const goals = await port.listActiveGoals();
    return {
      status: "ok",
      goals: goals.map((g) => ({
        id: g.id,
        title: g.title,
        content: g.content,
        evaluateAt: g.evaluateAt,
      })),
    };
  } catch (e) {
    return {
      status: "unavailable",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

function goalsOneLine(value: string): string {
  return value
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/** `YYYY-MM-DD` from the `evaluate_at` column, or an explicit gap marker. */
function goalDeadline(evaluateAt: Date | null): string {
  return evaluateAt ? evaluateAt.toISOString().slice(0, 10) : "no deadline set";
}

/**
 * Render the `## Goals` section lines: per goal its title, the deadline from
 * the `evaluate_at` column (never parsed from content), then content verbatim.
 * Zero goals renders `GOALS_BOOTSTRAP_INSTRUCTION`.
 */
export function renderGoalsLines(goals: GoalsSection): string[] {
  const head = ["", "## Goals", ""];
  if (goals.status === "unavailable") {
    return [...head, `goals unavailable: ${goalsOneLine(goals.reason)}`];
  }
  if (goals.goals.length === 0) return [...head, GOALS_BOOTSTRAP_INSTRUCTION];
  return [
    ...head,
    ...goals.goals.flatMap((g, i) => [
      ...(i > 0 ? [""] : []),
      `### ${g.title}`,
      "",
      `By: ${goalDeadline(g.evaluateAt)} · \`${g.id}\``,
      "",
      g.content,
    ]),
  ];
}
