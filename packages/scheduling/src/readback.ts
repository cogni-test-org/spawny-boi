// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Owned schedule readback through injected ports; no execution or content reads. */
import {
  type ScheduleHistory,
  ScheduleHistoryQuerySchema,
  type ScheduleRunSummary,
} from "./contracts/schedules.history.v1.contract.js";

export interface OwnedScheduleIdentity {
  id: string;
  ownerUserId: string;
}
export interface ScheduleHistoryOptions {
  limit: number;
  cursor?: string;
}
export interface ScheduleRunReader {
  /** Return limit+1 rows in scheduledFor DESC NULLS LAST, id DESC order. */
  listRuns(
    caller: string,
    scheduleId: string,
    options: ScheduleHistoryOptions
  ): Promise<ScheduleRunSummary[]>;
}
export class ScheduleHistoryNotFoundError extends Error {}
export class InvalidScheduleRunCursorError extends Error {
  constructor() {
    super("Invalid history cursor. Refresh to see the latest runs.");
    this.name = "InvalidScheduleRunCursorError";
  }
}

export function createScheduleHistoryService<
  T extends OwnedScheduleIdentity,
>(deps: {
  getSchedule: (caller: string, scheduleId: string) => Promise<T | null>;
  reader: ScheduleRunReader;
}) {
  async function schedule(caller: string, scheduleId: string): Promise<T> {
    const found = await deps.getSchedule(caller, scheduleId);
    if (!found || found.ownerUserId !== caller) {
      throw new ScheduleHistoryNotFoundError("Schedule not found");
    }
    return found;
  }
  return {
    schedule,
    async history(
      caller: string,
      scheduleId: string,
      options: ScheduleHistoryOptions
    ): Promise<ScheduleHistory> {
      const { limit, cursor } = ScheduleHistoryQuerySchema.parse(options);
      await schedule(caller, scheduleId);
      const rows = await deps.reader.listRuns(caller, scheduleId, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      const page = rows.slice(0, limit).map((run) => ({
        id: run.id,
        runId: run.runId,
        stateKey: run.stateKey,
        status: run.status,
        scheduledFor: run.scheduledFor,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }));
      return {
        runs: page,
        nextCursor:
          rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  };
}
