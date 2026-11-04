// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** PostgreSQL lease authority; injected pool, no runtime configuration or Dolt access. */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type {
  WorkItemLease,
  WorkItemLeaseOwner,
  WorkItemLeasePort,
} from "../../leases.js";
import { toWorkItemId, type WorkItemId } from "../../types.js";
import {
  WorkItemLeaseConflictError,
  WorkItemsBusyError,
} from "../../errors.js";

const TTL_SECONDS = 300;
// Cap unbounded/loose settings, preserve every stricter node-role profile.
// Transaction-local settings reset before the shared pool returns its slot.
const LOCAL_BUDGETS = `SELECT
  set_config('lock_timeout', CASE
    WHEN current_setting('lock_timeout')::interval = interval '0'
      OR current_setting('lock_timeout')::interval > interval '1 second'
    THEN '1s' ELSE current_setting('lock_timeout') END, true),
  set_config('statement_timeout', CASE
    WHEN current_setting('statement_timeout')::interval = interval '0'
      OR current_setting('statement_timeout')::interval > interval '3 seconds'
    THEN '3s' ELSE current_setting('statement_timeout') END, true)`;
const RETURNING = "RETURNING *, expires_at > clock_timestamp() AS active";

function toLease(row: Record<string, unknown>): WorkItemLease {
  const iso = (value: unknown) =>
    (value instanceof Date ? value : new Date(String(value))).toISOString();
  return {
    id: toWorkItemId(String(row.work_item_id)),
    runId: String(row.run_id),
    leaseToken: String(row.lease_token),
    claimedAt: iso(row.claimed_at),
    expiresAt: iso(row.expires_at),
    lastCommand: String(row.last_command),
    active: row.active === true,
  };
}

export class PostgresWorkItemLeaseAdapter implements WorkItemLeasePort {
  constructor(
    private readonly sql: Sql,
    private readonly options: {
      readonly logger?: {
        info(fields: Record<string, unknown>, message: string): void;
        warn(fields: Record<string, unknown>, message: string): void;
      };
    } = {}
  ) {}

  async claim(
    input: WorkItemLeaseOwner & { command: string }
  ): Promise<WorkItemLease> {
    const rows = await this.bounded(() =>
      this.sql.begin(async (tx) => {
        await tx.unsafe(LOCAL_BUDGETS);
        // Create a non-owning tombstone if absent. ON CONFLICT serializes the
        // first-insert race; lock_timeout bounds that wait too.
        await tx.unsafe(
          `INSERT INTO work_item_leases
        (work_item_id, principal_id, run_id, lease_token, claimed_at, expires_at, last_command)
        VALUES ($1, $2, $3, $4, '-infinity', '-infinity', '')
        ON CONFLICT (work_item_id) DO NOTHING`,
          [input.id, input.principalId, input.runId, randomUUID()]
        );
        await tx.unsafe(
          "SELECT work_item_id FROM work_item_leases WHERE work_item_id = $1 FOR UPDATE",
          [input.id]
        );
        // This statement starts AFTER row ownership. One stable server instant
        // determines both eligibility and the entire new lease generation.
        return tx.unsafe(
          `UPDATE work_item_leases SET
        principal_id = $2,
        run_id = $3,
        lease_token = CASE WHEN expires_at > statement_timestamp() THEN lease_token ELSE $4 END,
        claimed_at = CASE WHEN expires_at > statement_timestamp() THEN claimed_at ELSE statement_timestamp() END,
        last_command = CASE WHEN expires_at > statement_timestamp() THEN last_command ELSE $6 END,
        expires_at = CASE WHEN expires_at > statement_timestamp() THEN expires_at ELSE statement_timestamp() + make_interval(secs => $5) END
      WHERE work_item_id = $1 AND (expires_at <= statement_timestamp() OR (principal_id = $2 AND run_id = $3))
      ${RETURNING}`,
          [
            input.id,
            input.principalId,
            input.runId,
            randomUUID(),
            TTL_SECONDS,
            input.command,
          ]
        );
      })
    );
    return this.result(rows, input.id);
  }

  async heartbeat(
    input: WorkItemLeaseOwner & { leaseToken: string; command?: string }
  ): Promise<WorkItemLease> {
    const rows = await this.lockedUpdate(
      input.id,
      `
      UPDATE work_item_leases SET
        expires_at = clock_timestamp() + make_interval(secs => $5),
        last_command = COALESCE($6, last_command)
      WHERE work_item_id = $1 AND principal_id = $2 AND run_id = $3 AND lease_token = $4
        AND expires_at > clock_timestamp()
      ${RETURNING}`,
      [
        input.id,
        input.principalId,
        input.runId,
        input.leaseToken,
        TTL_SECONDS,
        input.command ?? null,
      ]
    );
    return this.result(rows, input.id);
  }

  async release(
    input: WorkItemLeaseOwner & { leaseToken: string }
  ): Promise<WorkItemLease> {
    // Retain the token as a tombstone: release retries are safe; a successor
    // acquisition gets another token, so stale renew/release cannot affect it.
    const rows = await this.lockedUpdate(
      input.id,
      `
      UPDATE work_item_leases SET expires_at = LEAST(expires_at, clock_timestamp())
      WHERE work_item_id = $1 AND principal_id = $2 AND run_id = $3 AND lease_token = $4
      ${RETURNING}`,
      [input.id, input.principalId, input.runId, input.leaseToken]
    );
    return this.result(rows, input.id);
  }

  async getMany(
    ids: readonly WorkItemId[]
  ): Promise<ReadonlyMap<WorkItemId, WorkItemLease>> {
    if (ids.length === 0) return new Map();
    const rows = await this.bounded(() =>
      this.sql.unsafe(
        "SELECT *, TRUE AS active FROM work_item_leases WHERE work_item_id = ANY($1::text[]) AND expires_at > clock_timestamp()",
        [Array.from(ids)]
      )
    );
    return new Map(
      rows.map((row) => {
        const lease = toLease(row);
        return [lease.id, lease];
      })
    );
  }

  private async lockedUpdate(
    id: WorkItemId,
    query: string,
    parameters: (string | number | null)[]
  ) {
    return this.bounded(() =>
      this.sql.begin(async (tx) => {
        await tx.unsafe(LOCAL_BUDGETS);
        // Acquire first, then read the server clock in another statement. An
        // UPDATE predicate alone can see pre-wait time on a lock-only tuple.
        await tx.unsafe(
          "SELECT work_item_id FROM work_item_leases WHERE work_item_id = $1 FOR UPDATE",
          [id]
        );
        return tx.unsafe(query, parameters);
      })
    );
  }

  private async bounded<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.options.logger?.warn(
        {
          event: "adapter.work_items.lease_error",
          component: "postgres-work-item-leases",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "work-item lease query failed"
      );
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (
        [
          "55P03",
          "57014",
          "53300",
          "08006",
          "ECONNRESET",
          "ECONNREFUSED",
        ].includes(code)
      ) {
        throw new WorkItemsBusyError(
          "Work-item coordination unavailable; retry shortly"
        );
      }
      throw error;
    }
  }

  private result(
    rows: ReadonlyArray<Record<string, unknown>>,
    id: WorkItemId
  ): WorkItemLease {
    if (!rows[0]) {
      this.options.logger?.info(
        {
          event: "adapter.work_items.lease_result",
          workItemId: id,
          outcome: "conflict",
        },
        "work-item lease conflict"
      );
      throw new WorkItemLeaseConflictError(id);
    }
    const lease = toLease(rows[0]);
    this.options.logger?.info(
      {
        event: "adapter.work_items.lease_result",
        workItemId: id,
        outcome: "success",
        active: lease.active,
      },
      "work-item lease complete"
    );
    return lease;
  }
}
