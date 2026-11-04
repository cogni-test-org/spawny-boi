// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type { ReservedSql, Sql } from "postgres";

type Rows = ReadonlyArray<Record<string, unknown>>;

interface FakeDoltgresSqlOptions {
  readonly commitDate?: string;
  readonly claimClaimedAt?: string;
  readonly claimExpiresAt?: string;
}

export function makeFakeDoltgresSql(
  respond: (query: string) => Rows | Promise<Rows>,
  queries: string[],
  options: FakeDoltgresSqlOptions = {}
): Sql {
  let mainHash = "test-main";
  let branch: string | undefined;
  let branchBase = mainHash;
  let branchCommit: string | undefined;
  let commitMessage = "";
  let commitDate = "2026-10-03T00:01:00.000Z";
  let beforeRow: Record<string, unknown> | undefined;
  let afterRow: Record<string, unknown> | undefined;
  let currentTableRow: Record<string, unknown> | undefined;
  let diffType: "added" | "modified" | "removed" = "modified";
  let operation = 0;
  let merged = false;
  let provingMergedRow = false;

  const unquote = (value: string | undefined) => value?.replace(/''/g, "'");
  const prefixed = (
    prefix: "from_" | "to_",
    row: Record<string, unknown> | undefined
  ) =>
    Object.fromEntries(
      Object.entries(row ?? {}).map(([key, value]) => [
        `${prefix}${key}`,
        value,
      ])
    );
  const nextCommitDate = (row: Record<string, unknown> | undefined) => {
    const created = new Date(
      String(row?.created_at ?? "2026-10-03T00:00:00.000Z")
    );
    const base = Number.isFinite(created.getTime())
      ? created.getTime()
      : Date.parse("2026-10-03T00:00:00.000Z");
    return new Date(base + operation * 60_000).toISOString();
  };

  const unsafe = async (query: string): Promise<Rows> => {
    queries.push(query);
    if (query === "SELECT current_database() AS dolt_writer_database")
      return [{ dolt_writer_database: "knowledge_test" }];
    if (query === "SELECT 1 AS work_items_ready") {
      return [{ work_items_ready: 1 }];
    }
    if (query.startsWith("SELECT pg_try_advisory_lock")) {
      return [{ pg_try_advisory_lock: true }];
    }
    if (query.startsWith("SELECT pg_advisory_unlock")) {
      return [{ pg_advisory_unlock: true }];
    }
    if (query === "SELECT dolt_checkout('main')") {
      return [{ dolt_checkout: [0, ""] }];
    }
    if (query.includes("dolt_checkout('-b'")) {
      branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1];
      branchBase = mainHash;
      branchCommit = undefined;
      afterRow = undefined;
      merged = false;
      return [{ dolt_checkout: [0, ""] }];
    }
    if (query === "SELECT table_name FROM dolt.status") return [];
    if (query === "SELECT name, hash FROM dolt.branches") {
      return branch ? [{ name: branch, hash: branchCommit ?? branchBase }] : [];
    }
    if (query.includes("FROM dolt.merge_status")) return [];
    if (query === "SELECT dolt_hashof('main') AS dolt_hashof") {
      return [{ dolt_hashof: mainHash }];
    }
    if (query === "SELECT dolt_add('work_items')") {
      return [{ dolt_add: [0, ""] }];
    }
    if (query.startsWith("SELECT dolt_commit")) {
      operation += 1;
      branchCommit = `test-commit-${operation}`;
      commitMessage =
        unquote(/SELECT dolt_commit\('-m', '(.*)'\)/.exec(query)?.[1]) ?? "";
      commitDate = options.commitDate ?? nextCommitDate(afterRow ?? beforeRow);
      return [{ dolt_commit: branchCommit }];
    }
    if (query.includes("FROM dolt_merge(")) {
      merged = true;
      provingMergedRow = true;
      mainHash = `test-merge-${operation}`;
      currentTableRow = afterRow;
      return [
        {
          hash: mainHash,
          fast_forward: 0,
          conflicts: 0,
          message: "ok",
        },
      ];
    }
    if (query.startsWith("SELECT dolt_merge_base")) {
      const requested = /dolt_merge_base\('main', '([^']+)'\)/.exec(query)?.[1];
      return [
        {
          dolt_merge_base:
            merged && requested === branchCommit ? branchCommit : mainHash,
        },
      ];
    }
    if (query.includes("FROM dolt.commits")) {
      return branchCommit
        ? [
            {
              commit_hash: branchCommit,
              message: commitMessage,
              date: commitDate,
            },
          ]
        : [];
    }
    if (query.includes("FROM dolt.commit_ancestors")) {
      return branchCommit
        ? [
            {
              commit_hash: branchCommit,
              parent_hash: branchBase,
              parent_index: 0,
            },
          ]
        : [];
    }
    if (query.startsWith("SELECT * FROM dolt_diff_summary")) {
      return [
        {
          from_table_name: "public.work_items",
          to_table_name: "public.work_items",
          schema_change: false,
          data_change: false,
        },
      ];
    }
    if (query.startsWith("SELECT * FROM dolt_diff(")) {
      return [
        {
          ...prefixed("from_", beforeRow),
          ...prefixed("to_", afterRow),
          diff_type: diffType,
        },
      ];
    }
    if (query.startsWith("SELECT dolt_branch")) {
      branch = undefined;
      branchCommit = undefined;
      currentTableRow = afterRow;
      beforeRow = undefined;
      return [{ dolt_branch: [0, ""] }];
    }
    if (
      provingMergedRow &&
      query.startsWith("SELECT * FROM work_items WHERE id")
    ) {
      provingMergedRow = false;
      return currentTableRow ? [currentTableRow] : [];
    }

    const rows = await respond(query);
    if (query.startsWith("INSERT INTO work_items")) {
      diffType = "added";
      beforeRow = undefined;
      afterRow = rows[0] ? { ...rows[0] } : undefined;
      if (afterRow) {
        // The real INSERT RETURNING row includes the creator supplied as the
        // sixth value. Model that at INSERT time; a later Dolt commit never
        // mutates application columns.
        const insertedValues = [...query.matchAll(/'((?:''|[^'])*)'/g)].map(
          ([, value]) => unquote(value)
        );
        afterRow.created_by_principal_id ??= insertedValues[5];
        afterRow.revision = 0;
        afterRow.claimed_by_run = null;
        afterRow.claimed_at = null;
        afterRow.claim_owner_principal_id = null;
        afterRow.claim_expires_at = null;
      }
      return afterRow ? [afterRow] : rows;
    }
    if (query.startsWith("UPDATE work_items")) {
      diffType = "modified";
      afterRow = rows[0] ? { ...rows[0] } : undefined;
      if (afterRow) {
        const previousRevision = Number(beforeRow?.revision ?? 0);
        afterRow.revision = previousRevision + 1;
        afterRow.updated_at = new Date(
          Date.parse(
            String(beforeRow?.created_at ?? "2026-10-03T00:00:00.000Z")
          ) +
            (operation + 1) * 60_000
        ).toISOString();
        if (query.includes("SET claimed_by_run =")) {
          afterRow.claimed_by_run = unquote(
            /SET claimed_by_run = '([^']*)'/.exec(query)?.[1]
          );
          afterRow.claim_owner_principal_id = unquote(
            /claim_owner_principal_id = '([^']*)'/.exec(query)?.[1]
          );
          afterRow.claimed_at =
            options.claimClaimedAt ??
            new Date(
              Date.parse(String(afterRow.updated_at)) - 1_000
            ).toISOString();
          afterRow.claim_expires_at =
            options.claimExpiresAt ??
            new Date(
              Date.parse(String(afterRow.updated_at)) + 300_000
            ).toISOString();
          afterRow.last_command = unquote(
            /last_command = '([^']*)'/.exec(query)?.[1]
          );
        } else if (query.includes("SET claim_expires_at = NOW()")) {
          afterRow.claim_expires_at = new Date(
            Date.parse(
              String(beforeRow?.claim_expires_at ?? afterRow.updated_at)
            ) + 300_000
          ).toISOString();
          const command = /last_command = '([^']*)'/.exec(query)?.[1];
          if (command !== undefined) afterRow.last_command = unquote(command);
        } else if (query.includes("SET claimed_by_run = NULL")) {
          afterRow.claimed_by_run = null;
          afterRow.claim_owner_principal_id = null;
          afterRow.claimed_at = null;
          afterRow.claim_expires_at = null;
        }
      }
      return afterRow ? [afterRow] : rows;
    }
    if (query.startsWith("DELETE FROM work_items")) {
      diffType = "removed";
      afterRow = undefined;
    } else if (
      query.includes("FROM work_items") &&
      rows[0] &&
      !query.startsWith("SELECT id FROM work_items")
    ) {
      beforeRow = { ...rows[0] };
      currentTableRow = { ...rows[0] };
    }
    return rows;
  };

  const reserved = {
    unsafe,
    release: () => undefined,
  } as unknown as ReservedSql;
  return {
    unsafe,
    reserve: async () => reserved,
    end: async () => undefined,
  } as unknown as Sql;
}

export function independentReadPool(sql: Sql): Sql {
  return Object.assign(async () => [], {
    unsafe: sql.unsafe.bind(sql),
    end: sql.end?.bind(sql),
  }) as unknown as Sql;
}
