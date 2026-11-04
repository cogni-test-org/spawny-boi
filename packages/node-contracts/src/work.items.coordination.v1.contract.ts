// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/work.items.coordination.v1.contract`
 * Purpose: Typed operations for work-item claim, heartbeat, release, and coordination state.
 * Scope: Wire schemas only; no persistence or authorization logic.
 * Invariants: CLAIM_AUTH_BINDS_PRINCIPAL_AND_RUN, VALIDATE_IO.
 * Side-effects: none
 * @internal
 */

import { z } from "zod";

export const WorkItemLeaseSchema = z.object({
  id: z.string(),
  runId: z.string(),
  leaseToken: z.string().uuid(),
  claimedAt: z.string(),
  expiresAt: z.string(),
  lastCommand: z.string(),
  active: z.boolean(),
});

const WorkItemIdSchema = z
  .string()
  .regex(/^(task|bug|story|spike|subtask)\.\d+$/);

export const workItemsClaimOperation = {
  id: "work.items.claim.v2",
  summary: "Claim a work item",
  description:
    "Acquires a lease or returns the identical active principal/run claim; renewal uses heartbeat.",
  input: z.object({
    id: WorkItemIdSchema,
    runId: z.string().min(1),
    command: z.string().min(1),
  }),
  output: WorkItemLeaseSchema,
} as const;

export const workItemsHeartbeatOperation = {
  id: "work.items.heartbeat.v2",
  summary: "Heartbeat a work-item claim",
  description:
    "Refreshes an active lease owned by the authenticated principal and run.",
  input: z.object({
    id: WorkItemIdSchema,
    runId: z.string().min(1),
    leaseToken: z.string().uuid(),
    command: z.string().min(1).optional(),
  }),
  output: WorkItemLeaseSchema,
} as const;

export const workItemsReleaseOperation = {
  id: "work.items.release.v2",
  summary: "Release a work-item claim",
  description: "Releases a lease owned by the authenticated principal and run.",
  input: z.object({
    id: WorkItemIdSchema,
    runId: z.string().min(1),
    leaseToken: z.string().uuid(),
  }),
  output: WorkItemLeaseSchema,
} as const;

export const WorkItemCoordinationSchema = z.object({
  nextAction: z.string().nullable(),
  session: z.object({
    status: z.enum(["active", "none"]),
    claimedByRun: z.string().nullable(),
    claimedByDisplayName: z.string().nullable(),
    claimedAt: z.string().nullable(),
    lastCommand: z.string().nullable(),
  }),
});

export const workItemsCoordinationOperation = {
  id: "work.items.coordination.v1",
  summary: "Read work-item coordination state",
  description: "Returns the active lease and next recommended workflow action.",
  input: z.object({ id: WorkItemIdSchema }),
  output: WorkItemCoordinationSchema,
} as const;

export type WorkItemCoordinationOutput = z.infer<
  typeof WorkItemCoordinationSchema
>;
