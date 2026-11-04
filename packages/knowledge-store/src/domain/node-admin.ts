// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/node-admin`
 * Purpose: The shared seam for the goal-layer node-admin privileges (story.5101,
 *   dao-goals-design): merging a change that touches a goal, and setting work-item
 *   priority <= 1. Every node injects ONE `NodeAdminAuthority`; the operator backs it
 *   with OpenFGA `node.administer`, a node without OpenFGA with its repo-spec admin
 *   wallets. Callers never know which.
 * Scope: Types, the pure privileged-priority rule, the goal-touch rule on raw diff ids,
 *   and the typed refusal. No I/O.
 * Invariants:
 *   - GOAL_CHANGE_IS_NODE_ADMIN / P0P1_IS_NODE_ADMIN.
 *   - PRIVILEGED_PRIORITY_IS_AT_MOST_ONE: `priority <= 1` (negative included) is the
 *     node-admin tier; contracts also bound priority to 0..99.
 *   - FAIL_CLOSED_WITH_DISTINCTION: deny → `authz_denied` (403); no authority or an
 *     outage → `authz_unavailable` (503). Never conflated.
 *   - MERGE_GATE_ON_RAW_DIFF: the goal-touch rule reads raw row/edge ids, never the
 *     display diff (which hides unchanged-display edits).
 * Side-effects: none
 * Links: https://cognidao.org/work/items/story.5101, https://github.com/cogni-dao/cogni/pull/2864#issuecomment-6329632774
 * @public
 */

import { GOAL_ID_PREFIX, GOAL_RETIRING_EDGE } from "./dao-goals.js";

/** The acting principal. A SIWE session carries a wallet; an agent key does not. */
export interface NodeAdminActor {
  readonly userId: string;
  readonly walletAddress?: string | null;
}

export type NodeAdminDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: "authz_denied" }
  | {
      readonly ok: false;
      readonly errorCode: "authz_unavailable";
      readonly reason: string;
    };

/** The one node-admin check a node injects (OpenFGA, repo-spec wallets, …). */
export interface NodeAdminAuthority {
  check(actor: NodeAdminActor): Promise<NodeAdminDecision>;
}

/** Thrown when a node-admin privilege is refused, before any side effect. */
export class NodeAdminRequiredError extends Error {
  readonly errorCode: "authz_denied" | "authz_unavailable";
  readonly status: 403 | 503;
  readonly action: string;
  readonly reason: string | null;
  constructor(
    decision: Exclude<NodeAdminDecision, { ok: true }>,
    action: string
  ) {
    // The message is client-safe; the raw authority `reason` (which may carry
    // OpenFGA / connection detail) stays on `.reason` for the server log only.
    super(
      decision.errorCode === "authz_denied"
        ? `${action} requires node admin`
        : `${action}: authorization unavailable`
    );
    this.name = "NodeAdminRequiredError";
    this.errorCode = decision.errorCode;
    this.status = decision.errorCode === "authz_denied" ? 403 : 503;
    this.action = action;
    this.reason = decision.errorCode === "authz_unavailable" ? decision.reason : null;
  }
}

/** PRIVILEGED_PRIORITY_IS_AT_MOST_ONE: priority <= 1 is the node-admin tier. */
export function isPrivilegedPriority(
  priority: number | null | undefined
): boolean {
  return priority != null && priority <= 1;
}

/** Run the injected authority, failing closed (503) when a node wired none. */
export async function checkNodeAdmin(
  authority: NodeAdminAuthority | undefined,
  actor: NodeAdminActor
): Promise<NodeAdminDecision> {
  if (!authority) {
    return {
      ok: false,
      errorCode: "authz_unavailable",
      reason: "no_node_admin_authority",
    };
  }
  try {
    return await authority.check(actor);
  } catch (e) {
    return {
      ok: false,
      errorCode: "authz_unavailable",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** One raw citation edge a contribution adds, changes or removes. */
export interface TouchedCitation {
  readonly citingId: string;
  readonly citedId: string;
  readonly citationType: string;
}

/**
 * True when a contribution's raw diff touches the goal layer: any `goal-*`
 * knowledge row, any edge leaving a goal, or a `supersedes` edge onto a goal
 * (which retires it). Other edges onto a goal (a bet `extends` it) stay open.
 */
export function touchesGoalLayer(touched: {
  readonly knowledgeIds: readonly string[];
  readonly citations: readonly TouchedCitation[];
}): boolean {
  const isGoal = (id: string) => id.startsWith(GOAL_ID_PREFIX);
  return (
    touched.knowledgeIds.some(isGoal) ||
    touched.citations.some(
      (c) =>
        isGoal(c.citingId) ||
        (isGoal(c.citedId) && c.citationType === GOAL_RETIRING_EDGE)
    )
  );
}
