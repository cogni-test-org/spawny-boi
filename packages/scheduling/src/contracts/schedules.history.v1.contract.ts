// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: node-contracts/schedules.history.v1
 * Purpose: Owned schedule detail and history contracts.
 * Scope: Wire validation only; does not infer business success from runtime status.
 * Invariants: Bounded metadata page; thread correlation never includes thread content.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import { z } from "zod";
import { ScheduleResponseSchema } from "./schedules.create.v1.contract.js";

export const ScheduleParamsSchema = z.object({ scheduleId: z.string().uuid() });
export const ScheduleHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
});
export const ScheduleRunSummarySchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  stateKey: z.string().nullable(),
  status: z.enum([
    "pending",
    "running",
    "success",
    "error",
    "timeout",
    "skipped",
    "cancelled",
  ]),
  scheduledFor: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export const schedulesGetOperation = {
  id: "schedules.get.v1",
  input: ScheduleParamsSchema,
  output: ScheduleResponseSchema,
} as const;
export const schedulesHistoryOperation = {
  id: "schedules.history.v1",
  input: ScheduleHistoryQuerySchema,
  output: z.object({
    runs: z.array(ScheduleRunSummarySchema),
    nextCursor: z.string().uuid().nullable(),
  }),
} as const;
export type ScheduleHistory = z.infer<typeof schedulesHistoryOperation.output>;
export type ScheduleRunSummary = z.infer<typeof ScheduleRunSummarySchema>;
