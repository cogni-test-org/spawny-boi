// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/system/page`
 * Purpose: Server entrypoint for the DAO autonomous AI activity page within governance.
 * Scope: Server component only; delegates all client behavior to GovernanceView. Does not perform data fetching.
 * Invariants: Auth enforced by (app) layout guard. task.5387 SUPERSEDES the task.5038 System redirect (/gov/system -> /dashboard); task.5038's epoch-admin consolidation at /gov/review is unchanged.
 * Side-effects: none (server render only)
 * Links: task.5387, task.5038, story.5134
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { PageSkeleton } from "@/components";

import { GovernanceView } from "./view";

export default function SystemActivityPage(): ReactElement {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <GovernanceView />
    </Suspense>
  );
}
