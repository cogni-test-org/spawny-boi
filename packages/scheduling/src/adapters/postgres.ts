// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Owned metadata reader on the caller's app-role pool. No client/role/schema lifecycle.
 * RLS and an explicit schedule-owner join both apply. SQL retains cursor precision.
 */
import type { Sql } from "postgres";
import {
  ScheduleHistoryQuerySchema,
  type ScheduleRunSummary,
} from "../contracts/schedules.history.v1.contract.js";
import {
  InvalidScheduleRunCursorError,
  type ScheduleHistoryOptions,
  type ScheduleRunReader,
} from "../readback.js";

interface RunRow {
  id: string;
  run_id: string;
  state_key: string | null;
  status: ScheduleRunSummary["status"];
  scheduled_for: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}
const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export class PostgresScheduleRunReader implements ScheduleRunReader {
  constructor(private readonly sql: Sql) {}

  async listRuns(
    caller: string,
    scheduleId: string,
    options: ScheduleHistoryOptions
  ): Promise<ScheduleRunSummary[]> {
    const { limit, cursor } = ScheduleHistoryQuerySchema.parse(options);
    return this.sql.begin(async (tx) => {
      // Parameterized and transaction-local; never interpolate an identity into SQL.
      await tx`SELECT set_config('app.current_user_id', ${caller}, true)`;
      let seek = "";
      const params: (string | number)[] = [caller, scheduleId, limit + 1];
      if (cursor) {
        const [anchor] = await tx<{ id: string; slot: string | null }[]>`
          SELECT r.id, r.scheduled_for::text AS slot
          FROM graph_runs r JOIN schedules s ON s.id = r.schedule_id
          WHERE s.owner_user_id = ${caller} AND r.schedule_id = ${scheduleId}
            AND r.id = ${cursor}
          LIMIT 1`;
        if (!anchor) throw new InvalidScheduleRunCursorError();
        params.push(anchor.id);
        if (anchor.slot === null) {
          seek = "AND r.scheduled_for IS NULL AND r.id < $4::uuid";
        } else {
          params.push(anchor.slot);
          seek = `AND (r.scheduled_for < $5::timestamptz
            OR (r.scheduled_for = $5::timestamptz AND r.id < $4::uuid)
            OR r.scheduled_for IS NULL)`;
        }
      }
      // seek contains only the static fragments above; every value is parameter-bound.
      const rows = await tx.unsafe<RunRow[]>(
        `SELECT r.id, r.run_id, r.state_key, r.status,
           r.scheduled_for, r.started_at, r.completed_at
         FROM graph_runs r JOIN schedules s ON s.id = r.schedule_id
         WHERE s.owner_user_id = $1 AND r.schedule_id = $2::uuid ${seek}
         ORDER BY r.scheduled_for DESC NULLS LAST, r.id DESC LIMIT $3`,
        params
      );
      return rows.map((run) => ({
        id: run.id,
        runId: run.run_id,
        stateKey: run.state_key,
        status: run.status,
        scheduledFor: iso(run.scheduled_for),
        startedAt: iso(run.started_at),
        completedAt: iso(run.completed_at),
      }));
    });
  }
}
