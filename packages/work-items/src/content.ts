// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/content`
 * Purpose: Port + input shapes for the versioned `work_items` API surface every node serves.
 * Scope: Types only, derived from `WorkItemCommandPort`. Does not contain implementation, IO, or container wiring.
 * Invariants:
 *   - DEPEND_ON_THE_PORT, routes and facades import these types, never the concrete adapter.
 *   - NOT_CONFIGURED_IS_WIRED, the container substitutes a throwing impl when the node has no Doltgres URL.
 * Side-effects: none
 * Links: docs/spec/work-items-port.md, docs/guides/agent-api-validation.md
 * @public
 */

import type { WorkItemLeasePort } from "./leases.js";

import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemId,
  WorkQuery,
} from "./index.js";

export type WorkItemsCreateInput = Parameters<WorkItemCommandPort["create"]>[0];

export type WorkItemsPatchSet = NonNullable<
  Parameters<WorkItemCommandPort["patch"]>[0]["set"]
> & {
  readonly deployVerified?: boolean;
  readonly projectId?: string | null;
  readonly parentId?: string | null;
  readonly blockedBy?: string | null;
};

export interface WorkItemsPatchInput {
  readonly expectedRevision?: number;
  readonly id: WorkItemId;
  readonly set: WorkItemsPatchSet;
}

export interface WorkItemsPort {
  get(id: WorkItemId): Promise<WorkItem | null>;
  list(query?: WorkQuery): Promise<{
    items: WorkItem[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean };
  }>;
  create(input: WorkItemsCreateInput, principalId: string): Promise<WorkItem>;
  patch(input: WorkItemsPatchInput, principalId: string): Promise<WorkItem>;
  delete(id: WorkItemId, principalId: string): Promise<boolean>;
  claim: WorkItemLeasePort["claim"];
  heartbeat: WorkItemLeasePort["heartbeat"];
  release: WorkItemLeasePort["release"];
}

export type WorkItemsContentPort = Omit<
  WorkItemsPort,
  "claim" | "heartbeat" | "release"
>;
