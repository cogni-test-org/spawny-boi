// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/node-admin-gate`
 * Purpose: This node's NodeAdminAuthority decides on the repo-spec admin seam (approvers), and the shared
 *   privileged-priority rule covers priority <= 1.
 * Scope: Pure authority with mocked config. Does not touch routes or stores.
 * Invariants: GOAL_CHANGE_IS_NODE_ADMIN, P0P1_IS_NODE_ADMIN, FAIL_CLOSED_WITH_DISTINCTION.
 * Side-effects: none
 * Links: src/bootstrap/node-admin-gate.ts, story.5101
 * @internal
 */

import { checkNodeAdmin, isPrivilegedPriority } from "@cogni/knowledge-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = "0x070075F1389Ae1182aBac722B36CA12285d0c949";
let approvers: string[] = [ADMIN.toLowerCase()];

vi.mock("@/shared/config", () => ({
  getLedgerApprovers: () => approvers,
  isDaoAdmin: (w: string | null | undefined) =>
    !!w && approvers.includes(w.toLowerCase()),
}));

import { createApproversNodeAdminAuthority } from "@/bootstrap/node-admin-gate";

describe("approvers-backed NodeAdminAuthority", () => {
  const authority = createApproversNodeAdminAuthority();
  beforeEach(() => {
    approvers = [ADMIN.toLowerCase()];
  });

  it("allows an approver wallet, case-insensitively", async () => {
    await expect(
      authority.check({ userId: "u1", walletAddress: ADMIN })
    ).resolves.toEqual({ ok: true });
  });

  it("denies an agent key (no wallet) and a non-approver wallet as authz_denied", async () => {
    for (const walletAddress of [
      null,
      "0x0000000000000000000000000000000000000001",
    ]) {
      await expect(
        checkNodeAdmin(authority, { userId: "agent", walletAddress })
      ).resolves.toEqual({ ok: false, errorCode: "authz_denied" });
    }
  });

  it("is authz_unavailable, not a denial, when no admin wallet is configured", async () => {
    approvers = [];
    await expect(
      authority.check({ userId: "u1", walletAddress: ADMIN })
    ).resolves.toMatchObject({ ok: false, errorCode: "authz_unavailable" });
  });

  it("priority <= 1 is privileged (negatives included); 2+ is open", () => {
    expect([-1, 0, 1, 2, 3, null, undefined].map(isPrivilegedPriority)).toEqual(
      [true, true, true, false, false, false, false]
    );
  });
});
