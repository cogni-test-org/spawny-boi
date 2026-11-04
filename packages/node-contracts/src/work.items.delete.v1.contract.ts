// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Retired hard-delete endpoint: preserve work-item identity and provenance. */

import { z } from "zod";

export const workItemsDeleteOperation = {
  id: "work.items.delete.v2",
  summary: "Retired: cancel a work item with PATCH",
  description:
    "Always returns HTTP 410. PATCH status=cancelled instead; durable work-item identifiers are never reused.",
  input: z.object({
    id: z.string(),
  }),
  output: z.object({
    error: z.literal("work_item_deletion_retired"),
    message: z.string(),
  }),
} as const;

export type WorkItemsDeleteInput = z.infer<
  typeof workItemsDeleteOperation.input
>;
export type WorkItemsDeleteOutput = z.infer<
  typeof workItemsDeleteOperation.output
>;
