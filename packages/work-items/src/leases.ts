// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Operational coordination lives in PostgreSQL, independently of versioned content. */
import type { WorkItemId } from "./types.js";

export interface WorkItemLease {
  readonly id: WorkItemId;
  readonly runId: string;
  readonly leaseToken: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly lastCommand: string;
  readonly active: boolean;
}

export interface WorkItemLeaseOwner {
  readonly id: WorkItemId;
  readonly runId: string;
  readonly principalId: string;
}

export interface WorkItemLeasePort {
  claim(
    input: WorkItemLeaseOwner & { readonly command: string }
  ): Promise<WorkItemLease>;
  heartbeat(
    input: WorkItemLeaseOwner & {
      readonly leaseToken: string;
      readonly command?: string;
    }
  ): Promise<WorkItemLease>;
  release(
    input: WorkItemLeaseOwner & { readonly leaseToken: string }
  ): Promise<WorkItemLease>;
  /** One bounded batch per content page, never one query per work item. */
  getMany(
    ids: readonly WorkItemId[]
  ): Promise<ReadonlyMap<WorkItemId, WorkItemLease>>;
}
