// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/knowledge-merge-node-admin`
 * Purpose: handleMerge passes the acting wallet to the service's node-admin gate and maps its refusals
 *   (403 authz_denied, 503 authz_unavailable without leaking the raw cause; 400 missing deadline).
 * Scope: Route handler with a mocked container service. No Doltgres.
 * Invariants: GOAL_CHANGE_IS_NODE_ADMIN, FAIL_CLOSED_WITH_DISTINCTION, HYPOTHESIS_HAS_EVALUATE_AT.
 * Side-effects: none
 * Links: src/app/api/v1/knowledge/contributions/_handlers.ts, story.5101
 * @internal
 */

import {
  HypothesisMissingEvaluateAtError,
  NodeAdminRequiredError,
} from "@cogni/knowledge-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const merge = vi.fn();
const warn = vi.fn();
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    knowledgeContributionService: { merge },
    log: { warn },
  }),
}));

import { handleMerge } from "@/app/api/v1/knowledge/contributions/_handlers";

const session = {
  id: "user-1",
  walletAddress: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
  displayName: null,
} as never;
const req = () =>
  new Request("http://x/api/v1/knowledge/contributions/c1/merge", {
    method: "POST",
    body: "{}",
  });

describe("handleMerge — node-admin gate wiring (story.5101)", () => {
  beforeEach(() => {
    merge.mockReset();
    warn.mockReset();
  });

  it("passes the acting session's wallet as the gate actor", async () => {
    merge.mockResolvedValue({ commitHash: "m1" });
    const res = await handleMerge(req(), "c1", session);
    expect(res.status).toBe(200);
    expect(merge.mock.calls[0]?.[0]).toMatchObject({
      contributionId: "c1",
      actor: {
        userId: "user-1",
        walletAddress: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
      },
    });
  });

  it("maps a denial to 403 authz_denied and logs it", async () => {
    merge.mockRejectedValue(
      new NodeAdminRequiredError(
        { ok: false, errorCode: "authz_denied" },
        "knowledge.contributions.merge.goal"
      )
    );
    const res = await handleMerge(req(), "c1", session);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errorCode: "authz_denied" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("maps an outage to 503 authz_unavailable without echoing the raw cause", async () => {
    merge.mockRejectedValue(
      new NodeAdminRequiredError(
        { ok: false, errorCode: "authz_unavailable", reason: "ECONNREFUSED 10.0.0.7" },
        "knowledge.contributions.merge.goal"
      )
    );
    const res = await handleMerge(req(), "c1", session);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("ECONNREFUSED");
  });

  it("maps a goal write without a deadline to 400", async () => {
    merge.mockRejectedValue(new HypothesisMissingEvaluateAtError("goal-x", "goal"));
    const res = await handleMerge(req(), "c1", session);
    expect(res.status).toBe(400);
  });
});
