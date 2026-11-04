// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/contribution-adapter`
 * Purpose: Focused unit coverage for Doltgres contribution adapter revision selection and metadata ordering.
 * Scope: Uses fake postgres.js clients; does not connect to Doltgres.
 * Invariants: CONTRIBUTION_DIFF_ANCHORED_TO_BASE, CONTRIBUTION_METADATA_BEFORE_BRANCH_DELETE.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts
 * @internal
 */

import type { ReservedSql, Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { DoltgresKnowledgeContributionAdapter } from "../src/adapters/doltgres/contribution-adapter.js";
import {
  DoltBranchSessionRunner,
  DoltgresKnowledgeStoreAdapter,
} from "../src/adapters/doltgres/index.js";
import { ContributionConflictError } from "../src/port/contribution.port.js";
import {
  KnowledgeContributionEditSchema,
  type Principal,
} from "../src/domain/contribution-schemas.js";
import {
  CitationTargetNotFoundError,
  HypothesisMissingEvaluateAtError,
  GoalRequiresContributionError,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeBusyError
} from "../src/port/knowledge-store.port.js";

const HEAD = "a".repeat(32);

const record = {
  id: "contrib-agent-1-abc123",
  branch: "contrib/agent-1-abc123",
  base_commit: "base123",
  head_commit: HEAD,
  commit_count: 3,
  state: "open",
  principal_kind: "agent",
  principal_id: "agent-1",
  message: "branch edit",
  merged_commit: null,
  closed_reason: null,
  idempotency_key: null,
  created_at: new Date("2026-05-19T00:00:00.000Z"),
  resolved_at: null,
  resolved_by: null,
} satisfies Record<string, unknown>;

const reviewer: Principal = {
  id: "user-1",
  kind: "user",
  role: "admin",
};

class FakeReservedSql {
  readonly queries: string[] = [];
  private activeBranch = "main";
  private metadataDirty = false;

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    if (query.includes("current_database()"))
      return [{ dolt_writer_database: "knowledge_test" }];
    if (query.includes("active_branch()"))
      return [{ branch_name: this.activeBranch }];
    if (query.includes("dolt_checkout(")) {
      const args = [...query.matchAll(/'([^']*)'/g)].map((match) => match[1]);
      this.activeBranch = args[0] === "-b" ? args[1]! : args[0]!;
      return [{ dolt_checkout: 0 }];
    }
    if (query === "SELECT * FROM dolt.status")
      return this.metadataDirty
        ? [{ table_name: "knowledge_contributions" }]
        : [];
    if (/^(INSERT INTO|UPDATE) knowledge_contribution/.test(query)) {
      if (!this.activeBranch.startsWith("dolt-op/"))
        throw new Error("Metadata DML escaped its owned operation branch");
      this.metadataDirty = true;
    }
    if (query.includes("dolt_commit") || query.includes("dolt_reset"))
      this.metadataDirty = false;
    if (query.includes("dolt_merge_base")) return [{ merge_base: "next456" }];
    if (
      query.startsWith(
        "SELECT hash, fast_forward, conflicts, message FROM dolt_merge("
      )
    )
      return [
        { hash: "next456", conflicts: 0, fast_forward: 1, message: "merged" }
      ];
    if (query.includes("dolt.merge_status")) return [{ is_merging: false }];
    // Admission control takes a session advisory lock before any branch work
    // (bug.5391); a fake that cannot answer it would fail every write as busy.
    if (query.includes("pg_try_advisory_lock"))
      return [{ pg_try_advisory_lock: true }];
    if (query.includes("pg_advisory_unlock"))
      return [{ pg_advisory_unlock: true }];
    if (query.includes("dolt_hashof")) {
      return query.includes("AS commit_hash")
        ? [{ commit_hash: HEAD }]
        : [{ dolt_hashof: HEAD }];
    }
    if (query.includes("dolt_commit")) {
      return [{ dolt_commit: ["{next456}"] }];
    }
    if (query.includes("FROM domains")) {
      return [{ "?column?": 1 }];
    }
    if (query.includes("dolt_merge")) {
      return [{ dolt_merge: ["merge123"] }];
    }
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    if (query.includes("FROM knowledge_contributions")) {
      return [record];
    }
    // cite-path lookups: both endpoints resolve, no incoming edges yet.
    if (query.includes("SELECT 1 FROM knowledge WHERE id")) {
      return [{ "?column?": 1 }];
    }
    if (query.includes("entry_type FROM knowledge")) {
      return [{ entry_type: "finding" }];
    }
    if (
      query.includes("source_type, entry_type, confidence_pct FROM knowledge")
    ) {
      return [
        { source_type: "external", entry_type: "finding", confidence_pct: 30 },
      ];
    }
    if (query.includes("citation_type FROM citations")) {
      return [];
    }
    if (query.includes("FROM knowledge_contribution_commits")) {
      return [
        {
          contribution_id: "contrib-agent-1-abc123",
          seq: 4,
          commit_hash: "next456",
          principal_kind: "agent",
          principal_id: "agent-1",
          auth_source: "bearer",
          message: "append",
          edit_count: 1,
          source_ref: "contribution:contrib-agent-1-abc123:4",
          created_at: new Date("2026-05-19T00:00:00.000Z")
        }
      ];
    }
    return [];
  }

  release(): void {
    this.queries.push("release");
  }
}

class FakeSql {
  readonly queries: string[] = [];
  readonly conn = new FakeReservedSql();

  constructor(
    private readonly contributionRecord: Record<string, unknown> = record
  ) {}

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) {
      return [this.contributionRecord];
    }
    if (query.includes("dolt_diff")) {
      return [];
    }
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}

// A ReservedSql whose dolt_merge() returns the full Doltgres
// (hash, fast_forward, conflicts, message) record — the real shape a merge of a
// non-trivial branch produces — parameterized so tests can drive both a clean
// merge and a conflicted one. Abort returns its own benign record.
class FakeMergeReservedSql extends FakeReservedSql {
  constructor(
    private readonly mergeRow: unknown[],
    private readonly throwOnMerge?: string
  ) {
    super();
  }
  override async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    if (query.startsWith("SELECT dolt_merge(")) {
      this.queries.push(query);
      if (query.includes("'--abort'"))
        return [{ dolt_merge: ["", "0", "0", "aborted"] }];
      if (this.throwOnMerge)
        throw Object.assign(new Error(this.throwOnMerge), {
          name: "PostgresError",
          code: "XX000",
        });
      return [{ dolt_merge: this.mergeRow }];
    }
    return super.unsafe(query);
  }
}

class FakeMergeSql {
  readonly queries: string[] = [];

  constructor(readonly conn: FakeMergeReservedSql) {}

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) {
      return [record];
    }
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}

function independentWriter(fake: {
  unsafe(query: string): Promise<Record<string, unknown>[]>;
  reserve(): Promise<ReservedSql>;
}): Sql {
  return {
    unsafe: fake.unsafe.bind(fake),
    reserve: fake.reserve.bind(fake),
    end: async () => undefined,
  } as unknown as Sql;
}

function adapterFor(
  fake: FakeSql | FakeMergeSql
): DoltgresKnowledgeContributionAdapter {
  return new DoltgresKnowledgeContributionAdapter({
    sql: fake as unknown as Sql,
    branchSql: independentWriter(fake),
  });
}

describe("DoltgresKnowledgeContributionAdapter", () => {
  it("recovers only this append's finite uncommitted edits and releases queued callers", async () => {
    const fake = new FakeSql();
    const original = fake.conn.unsafe.bind(fake.conn);
    let settle!: () => void;
    const pending = new Promise<Record<string, unknown>[]>((resolve) => {
      settle = () => resolve([]);
    });
    let dirty = false;
    let edits = 0;
    let resets = 0;
    let stall = true;
    fake.conn.unsafe = async (query) => {
      if (query.includes("information_schema.columns"))
        return [{ "?column?": 1 }];
      if (query === "SELECT * FROM dolt.status") {
        fake.conn.queries.push(query);
        return dirty ? [{ table_name: "knowledge" }] : [];
      }
      if (query === "SELECT dolt_reset('--hard', 'HEAD')") {
        fake.conn.queries.push(query);
        resets++;
        dirty = false;
        return [{ dolt_reset: 0 }];
      }
      if (query.startsWith("UPDATE knowledge SET")) {
        edits++;
        dirty = true;
        fake.conn.queries.push(query);
        if (stall) return pending;
        return [];
      }
      if (/^(INSERT INTO|UPDATE) knowledge_contribution/.test(query))
        dirty = true;
      if (query.includes("dolt_commit")) dirty = false;
      return original(query);
    };
    let ended = 0;
    const writer = independentWriter(fake);
    writer.end = async () => {
      ended++;
    };
    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: writer,
      branchSession: { queryTimeoutMs: 10 },
    });
    const input = {
      contributionId: String(record.id),
      principal: { id: "agent-1", kind: "agent" as const },
      message: "private edit",
      edits: [
        {
          op: "patch" as const,
          targetRowId: "row-1",
          entry: { useWhen: "new intent" },
        },
      ],
    };
    const first = adapter.appendCommit(input).catch((error: unknown) => error);
    const queued = adapter
      .appendCommit({ ...input, contributionId: "contrib-other" })
      .catch((error: unknown) => error);
    const receipt = await first;
    expect(receipt).toBeInstanceOf(KnowledgeWriteOutcomeUnknownError);
    expect(await queued).toBeInstanceOf(KnowledgeBusyError);
    expect(
      fake.conn.queries.filter((query) =>
        query.includes("FROM knowledge_contributions")
      )
    ).toHaveLength(1);
    expect(edits).toBe(1);
    expect(resets).toBe(0);
    expect(
      fake.conn.queries.some((q) => q.includes("pg_advisory_unlock"))
    ).toBe(false);
    expect(fake.conn.queries.some((q) => q.includes("dolt_commit"))).toBe(
      false
    );
    stall = false;
    settle();
    await expect
      .poll(() => fake.conn.queries.filter((q) => q === "release").length)
      .toBe(1);
    expect(resets).toBe(1);
    expect(edits).toBe(1);
    expect(ended).toBe(0);
    expect(
      fake.conn.queries.filter((q) => q.includes("pg_advisory_unlock"))
    ).toHaveLength(3);
    expect(
      fake.conn.queries.some((q) =>
        /dolt_branch|INSERT INTO knowledge_contribution/.test(q)
      )
    ).toBe(false);
    expect(receipt).toMatchObject({
      retryable: false,
      receipt: { lookup: { branch: record.branch } },
    });
    await expect(adapter.appendCommit(input)).resolves.toMatchObject({
      commitHash: "next456",
    });
    expect(edits).toBe(2);
    expect(resets).toBe(1);
    expect(ended).toBe(0);
  });

  it("keeps metadata DML private through a finite timeout and admits a fresh close after native settlement", async () => {
    const fake = new FakeSql();
    const native = fake.conn.unsafe.bind(fake.conn);
    let settle!: () => void;
    const finite = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let stalled = false,
      metadataCalls = 0,
      resets = 0;
    fake.conn.unsafe = async (query) => {
      if (query.startsWith("UPDATE knowledge_contributions")) {
        metadataCalls++;
        const rows = await native(query);
        if (!stalled) {
          stalled = true;
          await finite;
        }
        return rows;
      }
      if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
      return native(query);
    };
    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
      branchSession: { queryTimeoutMs: 10 },
    });
    const input = {
      contributionId: String(record.id),
      principal: reviewer,
      reason: "finite metadata",
    };
    const outcome = await adapter.close(input).catch((error) => error);
    expect(outcome).toMatchObject({
      name: "KnowledgeWriteOutcomeUnknownError",
      retryable: false,
      receipt: { lookup: { branch: expect.stringMatching(/^dolt-op\//) } }
    });
    expect(metadataCalls).toBe(1);
    expect(resets).toBe(0);
    expect(
      fake.conn.queries.some((query) => query.includes("pg_advisory_unlock"))
    ).toBe(false);
    await expect(adapter.close(input)).rejects.toBeInstanceOf(
      KnowledgeBusyError
    );
    expect(metadataCalls).toBe(1);
    settle();
    await expect
      .poll(
        () => fake.conn.queries.filter((query) => query === "release").length
      )
      .toBe(1);
    expect(resets).toBe(1);
    expect(metadataCalls).toBe(1);
    expect(
      fake.conn.queries.filter((query) => query.includes("pg_advisory_unlock"))
    ).toHaveLength(3);
    expect(
      fake.conn.queries.some(
        (query) => query === `SELECT dolt_branch('-D', '${record.branch}')`
      )
    ).toBe(false);
    await expect(
      adapter.close({ ...input, reason: "new inspected request" })
    ).resolves.toBeUndefined();
    await expect
      .poll(
        () => fake.conn.queries.filter((query) => query === "release").length
      )
      .toBe(2);
    expect(metadataCalls).toBe(2);
    expect(resets).toBe(1);
  });

  it.each(["commit-ack", "transport"] as const)(
    "preserves metadata inspection evidence for %s uncertainty without replay",
    async (stage) => {
      const fake = new FakeSql(),
        native = fake.conn.unsafe.bind(fake.conn);
      let settle!: () => void;
      const finite = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let metadataCalls = 0;
      fake.conn.unsafe = async (query) => {
        if (query.startsWith("UPDATE knowledge_contributions")) {
          metadataCalls++;
          const rows = await native(query);
          if (stage === "transport")
            throw new Error("Socket acknowledgement disappeared");
          return rows;
        }
        const rows = await native(query);
        if (stage === "commit-ack" && query.startsWith("SELECT dolt_commit("))
          await finite;
        return rows;
      };
      const adapter = new DoltgresKnowledgeContributionAdapter({
        sql: fake as unknown as Sql,
        branchSql: independentWriter(fake),
        branchSession: { queryTimeoutMs: 10 },
      });
      const error = await adapter
        .close({
          contributionId: String(record.id),
          principal: reviewer,
          reason: "retain metadata inspection",
        })
        .catch((error) => error);
      expect(error).toMatchObject({
        name: "KnowledgeWriteOutcomeUnknownError",
        retryable: false,
      });
      expect(metadataCalls).toBe(1);
      expect(
        fake.conn.queries.some((query) => query.includes("pg_advisory_unlock"))
      ).toBe(false);
      if (stage === "commit-ack") {
        settle();
        await expect
          .poll(
            () =>
              fake.conn.queries.filter((query) => query === "release").length
          )
          .toBe(1);
      } else {
        await expect(
          adapter.close({
            contributionId: String(record.id),
            principal: reviewer,
            reason: "no replay",
          })
        ).rejects.toBeInstanceOf(KnowledgeBusyError);
        expect(
          fake.conn.queries.some((query) =>
            query.includes("pg_advisory_unlock")
          )
        ).toBe(false);
      }
      expect(metadataCalls).toBe(1);
      expect(
        fake.conn.queries.some((query) =>
          /dolt_reset|dolt_branch\('-D'/.test(query)
        )
      ).toBe(false);
    }
  );

  it("maps unproven metadata merge proof to the public nonretryable inspection receipt", async () => {
    const fake = new FakeSql(),
      native = fake.conn.unsafe.bind(fake.conn);
    fake.conn.unsafe = async (query) =>
      query.includes("dolt_merge_base")
        ? [{ merge_base: "unproven" }]
        : native(query);
    await expect(
      adapterFor(fake).close({
        contributionId: String(record.id),
        principal: reviewer,
        reason: "unproven merge"
      })
    ).rejects.toMatchObject({
      name: "KnowledgeWriteOutcomeUnknownError",
      retryable: false,
      receipt: { lookup: { branch: expect.stringMatching(/^dolt-op\//) } }
    });
    expect(
      fake.conn.queries.filter((query) =>
        query.startsWith("UPDATE knowledge_contributions")
      )
    ).toHaveLength(1);
    expect(
      fake.conn.queries.some((query) =>
        /dolt_reset|dolt_branch\('-D'/.test(query)
      )
    ).toBe(false);
  });

  it.each(["merge", "close"] as const)(
    "rereads queued %s state under its existing guard and skips duplicate metadata DML",
    async (action) => {
      const fake = new FakeSql(),
        native = fake.conn.unsafe.bind(fake.conn);
      let current: Record<string, unknown> = { ...record },
        staged: Record<string, unknown> | undefined;
      let entered!: () => void, settle!: () => void;
      const editing = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        finite = new Promise<void>((resolve) => {
          settle = resolve;
        });
      let metadataCalls = 0,
        merges = 0;
      fake.conn.unsafe = async (query) => {
        if (query.includes("FROM knowledge_contributions")) {
          fake.conn.queries.push(query);
          return [current];
        }
        if (query.startsWith("SELECT dolt_merge('contrib/")) merges++;
        if (query.startsWith("UPDATE knowledge_contributions")) {
          metadataCalls++;
          const rows = await native(query);
          staged = {
            ...current,
            state: action === "merge" ? "merged" : "closed",
            merged_commit: action === "merge" ? "merge123" : null,
          };
          entered();
          await finite;
          return rows;
        }
        const rows = await native(query);
        if (
          query.startsWith(
            "SELECT hash, fast_forward, conflicts, message FROM dolt_merge("
          ) &&
          staged
        ) {
          current = staged;
          staged = undefined;
        }
        return rows;
      };
      const adapter = adapterFor(fake);
      const invoke = () =>
        action === "merge"
          ? adapter.merge({
              contributionId: String(record.id),
              principal: reviewer,
            })
          : adapter.close({
              contributionId: String(record.id),
              principal: reviewer,
              reason: "close once",
            });
      const first = invoke();
      await editing;
      const queued = invoke();
      await expect
        .poll(
          () =>
            fake.queries.filter((query) =>
              query.includes("FROM knowledge_contributions")
            ).length
        )
        .toBe(2);
      settle();
      await expect(Promise.all([first, queued])).resolves.toEqual(
        action === "merge"
          ? [{ commitHash: "merge123" }, { commitHash: "merge123" }]
          : [undefined, undefined]
      );
      expect(metadataCalls).toBe(1);
      expect(merges).toBe(action === "merge" ? 1 : 0);
      expect(
        fake.conn.queries.filter((query) =>
          query.includes("FROM knowledge_contributions")
        )
      ).toHaveLength(2);
    }
  );

  it.each(["dirty", "head"])(
    "preserves a typed conflict for preexisting %s contribution state before edits",
    async (condition) => {
      const fake = new FakeSql();
      const original = fake.conn.unsafe.bind(fake.conn);
      let active = "main";
      fake.conn.unsafe = async (query) => {
        if (query.includes("dolt_checkout(")) active = query.split("'")[1]!;
        if (
          condition === "dirty" &&
          query === "SELECT * FROM dolt.status" &&
          active !== "main"
        ) {
          fake.conn.queries.push(query);
          return [{ table_name: "knowledge" }];
        }
        if (condition === "head" && query.includes("AS commit_hash"))
          return [{ commit_hash: "b".repeat(32) }];
        return original(query);
      };
      await expect(
        adapterFor(fake).appendCommit({
          contributionId: String(record.id),
          principal: { id: "agent-1", kind: "agent" },
          message: "must not overwrite old work",
          edits: [
            { op: "patch", targetRowId: "row-1", entry: { useWhen: "new" } },
          ],
        })
      ).rejects.toBeInstanceOf(ContributionConflictError);
      expect(
        fake.conn.queries.some((q) =>
          /UPDATE knowledge SET|dolt_reset|dolt_commit/.test(q)
        )
      ).toBe(false);
    }
  );
  it("rejects missing or read-aliased branch configuration before SQL", () => {
    const fake = new FakeSql();
    const sql = fake as unknown as Sql;
    expect(() => new DoltgresKnowledgeContributionAdapter({ sql })).toThrow(
      /independent/
    );
    expect(
      () => new DoltgresKnowledgeContributionAdapter({ sql, branchSql: sql })
    ).toThrow(/independent/);
    expect(() => new DoltgresKnowledgeStoreAdapter({ sql })).not.toThrow();
    const aliasedRunner = new DoltBranchSessionRunner(sql);
    expect(
      () =>
        new DoltgresKnowledgeContributionAdapter({
          sql,
          writerSession: aliasedRunner,
        })
    ).toThrow(/independent/);
    expect(
      () =>
        new DoltgresKnowledgeStoreAdapter({ sql, writerSession: aliasedRunner })
    ).toThrow(/independent/);
    expect(fake.queries).toHaveLength(0);
    expect(fake.conn.queries).toHaveLength(0);
  });

  it("anchors contribution diff to the recorded base and head commits", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      `dolt_diff('base123', '${HEAD}', 'knowledge')`
    );
  });

  it("uses base commit as both sides for diff when no branch commit exists", async () => {
    const fake = new FakeSql({ ...record, head_commit: null, commit_count: 0 });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      "dolt_diff('base123', 'base123', 'knowledge')"
    );
  });

  it("normalizes persisted brace-wrapped refs before building diff refs", async () => {
    const fake = new FakeSql({
      ...record,
      base_commit: "{base123}",
      head_commit: `{${HEAD}}`,
    });

    await adapterFor(fake).diff("contrib-agent-1-abc123");

    expect(fake.queries.at(-1)).toContain(
      `dolt_diff('base123', '${HEAD}', 'knowledge')`
    );
  });

  it("commits merge metadata before deleting the contribution branch", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).merge({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
    });

    await expect
      .poll(() =>
        fake.conn.queries.some(
          (query) => query === `SELECT dolt_branch('-D', '${record.branch}')`
        )
      )
      .toBe(true);
    const updateIndex = fake.conn.queries.findIndex((query) =>
      query.includes("SET state = 'merged'")
    );
    const commitIndex = fake.conn.queries.findIndex((query) =>
      query.includes("contrib-merge: contrib-agent-1-abc123")
    );
    const deleteIndex = fake.conn.queries.findIndex((query) =>
      query.includes("dolt_branch('-D'")
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(deleteIndex).toBeGreaterThan(commitIndex);
  });

  it("surfaces a merge conflict as a typed error and aborts, leaving the branch open (bug.5120)", async () => {
    // Doltgres reports a data conflict as a non-zero `conflicts` field in the
    // dolt_merge record WITHOUT throwing. The adapter must detect it, abort the
    // half-applied merge, and raise a typed ContributionConflictError rather
    // than blindly marking the contribution merged and letting the later
    // dolt_commit throw an opaque 500.
    const conn = new FakeMergeReservedSql(["", "0", "2", "conflicts found"]);
    const fake = new FakeMergeSql(conn);

    await expect(
      adapterFor(fake).merge({
        contributionId: "contrib-agent-1-abc123",
        principal: reviewer,
      })
    ).rejects.toThrow(/conflict/i);

    // it aborted the conflicted merge so the working set is clean for next time
    expect(conn.queries.some((q) => q.includes("dolt_merge('--abort')"))).toBe(
      true
    );
    // and it never marked the contribution merged or deleted the branch
    expect(conn.queries.some((q) => q.includes("SET state = 'merged'"))).toBe(
      false
    );
    expect(conn.queries.some((q) => q.includes("dolt_branch('-D'"))).toBe(
      false
    );
  });

  it("merges a branch whose dolt_merge returns the full clean record (no false conflict on intra-branch citations)", async () => {
    // A real branch carrying entries plus intra-branch citation edges produces
    // the full (hash, fast_forward, conflicts=0, message) record. The new
    // conflict parsing must treat conflicts=0 as success — not misread a later
    // field as a conflict — and complete the merge without aborting.
    const conn = new FakeMergeReservedSql([
      "merge999",
      "0",
      "0",
      "merge successful",
    ]);
    const fake = new FakeMergeSql(conn);

    const result = await adapterFor(fake).merge({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
    });

    expect(result.commitHash).toBe("merge999");
    expect(conn.queries.some((q) => q.includes("dolt_merge('--abort')"))).toBe(
      false
    );
    expect(conn.queries.some((q) => q.includes("SET state = 'merged'"))).toBe(
      true
    );
    await expect
      .poll(() =>
        conn.queries.some(
          (q) => q === `SELECT dolt_branch('-D', '${record.branch}')`
        )
      )
      .toBe(true);
  });

  it("maps a thrown Dolt conflict to a clean human message, never the raw SQL (bug.5120)", async () => {
    // Doltgres throws on a conflicted merge with @autocommit on. The raw text
    // ("@@dolt_allow_commit_conflicts", branch refs, dolt_conflicts tables) must
    // NOT reach the admin — only a plain what-happened + how-to-fix message.
    const raw =
      "dolt_merge failed for contrib/x: Merge conflict detected, @autocommit transaction rolled back. set @@dolt_allow_commit_conflicts = 1";
    const conn = new FakeMergeReservedSql([], raw);
    const fake = new FakeMergeSql(conn);

    const err = await adapterFor(fake)
      .merge({ contributionId: "contrib-agent-1-abc123", principal: reviewer })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/conflict/i);
    // no raw Dolt/SQL leakage
    expect(err?.message).not.toMatch(
      /dolt_merge|@@dolt|autocommit|dolt_conflicts/i
    );
    expect(err?.message).not.toContain("contrib/x");
    // conflicted branch is never marked merged
    expect(conn.queries.some((q) => q.includes("SET state = 'merged'"))).toBe(
      false
    );
  });

  it("commits close metadata before deleting the contribution branch", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).close({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
      reason: "superseded",
    });

    await expect
      .poll(() =>
        fake.conn.queries.some(
          (query) => query === `SELECT dolt_branch('-D', '${record.branch}')`
        )
      )
      .toBe(true);
    const updateIndex = fake.conn.queries.findIndex((query) =>
      query.includes("SET state = 'closed'")
    );
    const commitIndex = fake.conn.queries.findIndex((query) =>
      query.includes("contrib-close: contrib-agent-1-abc123")
    );
    const deleteIndex = fake.conn.queries.findIndex((query) =>
      query.includes("dolt_branch('-D'")
    );

    expect(updateIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(deleteIndex).toBeGreaterThan(commitIndex);
  });

  it("accepts Dolt commit refs returned with and without braces while appending", async () => {
    const fake = new FakeSql();

    const commit = await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "append",
      edits: [
        {
          op: "insert",
          entry: {
            id: "row-1",
            domain: "meta",
            title: "row",
            content: "content",
          },
        },
      ],
    });

    expect(commit.commitHash).toBe("next456");
    expect(fake.conn.queries).toContain(
      "SELECT dolt_hashof('HEAD') AS commit_hash"
    );
    expect(
      fake.conn.queries.some((query) =>
        query.includes(`head_commit = '${HEAD}'`)
      )
    ).toBe(true);
  });

  it("applies a cite edit as a citations insert + cited-row confidence recompute", async () => {
    const fake = new FakeSql();

    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "link synthesis to atom",
      edits: [
        {
          op: "cite",
          citingId: "oss-cap-eval-harness",
          citedId: "oss-promptfoo",
          citationType: "supports",
        },
      ],
    });

    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") &&
          q.includes("'oss-cap-eval-harness'") &&
          q.includes("'oss-promptfoo'") &&
          q.includes("'supports'")
      )
    ).toBe(true);
    // the edge recomputes the cited row's confidence inside the branch
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("UPDATE knowledge SET confidence_pct") &&
          q.includes("'oss-promptfoo'")
      )
    ).toBe(true);
  });

  // bug.5024: a branch contribution citing a row that was merged to main AFTER
  // the branch forked. The target resolves on main but not on the branch HEAD;
  // the cite must still succeed (main ∪ branch resolution) and skip the
  // branch-local confidence recompute (no branch row to UPDATE).
  it("accepts a cross-plane cite (target on main, absent from branch) and skips recompute", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["cicd-agent-playbook", "finding"]]),
      branchEntryTypes: new Map([["oss-langgraph", "finding"]]),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    const commit = await adapter.appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "cite a merged-main atom from a branch entry",
      edits: [
        {
          op: "cite",
          citingId: "oss-langgraph",
          citedId: "cicd-agent-playbook",
          citationType: "supports",
        },
      ],
    });

    expect(commit.commitHash).toBe("next456");
    // The edge is recorded on the branch even though the target is main-only.
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") &&
          q.includes("'cicd-agent-playbook'")
      )
    ).toBe(true);
    // main was consulted for the cited entry_type when the branch lookup missed.
    expect(
      fake.queries.some(
        (q) =>
          q.includes("entry_type FROM knowledge") &&
          q.includes("'cicd-agent-playbook'")
      )
    ).toBe(true);
    // No branch-local recompute: the cited row isn't on the branch to UPDATE.
    expect(
      fake.conn.queries.some((q) =>
        q.includes("UPDATE knowledge SET confidence_pct")
      )
    ).toBe(false);
    expect(
      fake.conn.queries.some((q) => q.includes("source_type FROM knowledge"))
    ).toBe(false);
  });

  it("accepts a work-item tracking cite and skips confidence recompute", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["work-knowledge-write-planes", "finding"]]),
      branchEntryTypes: new Map(),
      mainWorkItemIds: new Set(["task.5017"]),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await adapter.appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "link work item to durable knowledge",
      edits: [
        {
          op: "cite",
          citingId: "task.5017",
          citedId: "work-knowledge-write-planes",
          citationType: "tracks",
        },
      ],
    });

    expect(
      fake.queries.some(
        (q) => q.includes("FROM work_items") && q.includes("'task.5017'")
      )
    ).toBe(true);
    expect(
      fake.conn.queries.some(
        (q) =>
          q.includes("INSERT INTO citations") &&
          q.includes("'task.5017'") &&
          q.includes("'work-knowledge-write-planes'") &&
          q.includes("'tracks'")
      )
    ).toBe(true);
    expect(
      fake.conn.queries.some((q) =>
        q.includes("UPDATE knowledge SET confidence_pct")
      )
    ).toBe(false);
  });

  it("rejects a work-item tracking cite when the work item is absent from main", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map([["work-knowledge-write-planes", "finding"]]),
      branchEntryTypes: new Map(),
      mainWorkItemIds: new Set(),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await expect(
      adapter.appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "link missing work item",
        edits: [
          {
            op: "cite",
            citingId: "task.9999",
            citedId: "work-knowledge-write-planes",
            citationType: "tracks",
          },
        ],
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });

  it("rejects a work-item tracking cite when the knowledge endpoint is branch-only", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map(),
      branchEntryTypes: new Map([["branch-only-entry", "finding"]]),
      mainWorkItemIds: new Set(["task.5017"]),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await expect(
      adapter.appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "link branch-only knowledge to work",
        edits: [
          {
            op: "cite",
            citingId: "branch-only-entry",
            citedId: "task.5017",
            citationType: "tracks",
          },
        ],
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });

  it("throws CitationTargetNotFoundError when the cited row is on neither branch nor main", async () => {
    const fake = new CrossPlaneFakeSql({
      mainEntryTypes: new Map(),
      branchEntryTypes: new Map(),
    });

    const adapter = new DoltgresKnowledgeContributionAdapter({
      sql: fake as unknown as Sql,
      branchSql: independentWriter(fake),
    });
    await expect(
      adapter.appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "cite a bogus id",
        edits: [
          {
            op: "cite",
            citingId: "oss-langgraph",
            citedId: "does-not-exist-anywhere",
            citationType: "supports",
          },
        ],
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });

  it("refuses an existing goal inside a real admitted write scope before DML", async () => {
    const fake = new FakeSql();
    const original = fake.conn.unsafe.bind(fake.conn);
    fake.conn.unsafe = async (query: string) => {
      if (
        query.includes("entry_type FROM knowledge") &&
        query.includes("'goal-a'")
      )
        return [{ entry_type: "goal" }];
      if (query.includes("SELECT * FROM knowledge WHERE id")) {
        fake.conn.queries.push(query);
        return [
          {
            id: "goal-a",
            entry_type: "goal",
            domain: "strategy",
            content: "original",
            title: "Goal",
            source_type: "human",
            confidence_pct: 30
          }
        ];
      }
      return original(query);
    };
    const store = new DoltgresKnowledgeStoreAdapter({
      sql: fake as unknown as Sql,
      writerSession: new DoltBranchSessionRunner(independentWriter(fake))
    });
    await expect(
      store.withWrite(
        { operationId: "refuse-goal-change", message: "must refuse" },
        (write) =>
          write.upsertKnowledge({
            id: "goal-a",
            domain: "strategy",
            title: "changed",
            content: "changed",
            sourceType: "agent"
          })
      )
    ).rejects.toBeInstanceOf(GoalRequiresContributionError);
    expect(
      fake.conn.queries.some((q) =>
        /^INSERT INTO knowledge |^UPDATE knowledge SET/.test(q)
      )
    ).toBe(false);
    expect(
      fake.conn.queries.some((q) => q.includes("pg_try_advisory_lock"))
    ).toBe(true);
  });

  it("refuses a merge whose branch head moved after the gate read (MERGE_EXPECTED_HEAD)", async () => {
    const fake = new FakeSql();
    await expect(
      adapterFor(fake).merge({
        contributionId: "contrib-agent-1-abc123",
        principal: reviewer,
        expectedHeadCommit: "reviewed-older-head",
      })
    ).rejects.toBeInstanceOf(ContributionConflictError);
    expect(fake.conn.queries.some((q) => q.includes("SELECT dolt_merge("))).toBe(false);
  });

  it("merges when the expected head is still the branch head", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).merge({
      contributionId: "contrib-agent-1-abc123",
      principal: reviewer,
      expectedHeadCommit: HEAD
    });
    expect(fake.conn.queries.some((q) => q.includes("SELECT dolt_merge("))).toBe(true);
  });

  it("touchedIds reads raw knowledge + citation diffs at the head (MERGE_GATE_ON_RAW_DIFF)", async () => {
    const fake = new FakeSql();
    const original = fake.unsafe.bind(fake);
    fake.unsafe = async (query: string) => {
      if (query.includes("'knowledge')")) {
        fake.queries.push(query);
        return [{ from_id: "goal-a", to_id: "goal-a" }, { from_id: null, to_id: "row-b" }];
      }
      if (query.includes("'citations')")) {
        fake.queries.push(query);
        return [
          { from_citing_id: null, from_cited_id: null, to_citing_id: "x", to_cited_id: "goal-a", to_citation_type: "supersedes" },
        ];
      }
      return original(query);
    };
    const touched = await adapterFor(fake).touchedIds("contrib-agent-1-abc123");
    expect(touched).toEqual({
      headCommit: HEAD,
      knowledgeIds: ["goal-a", "row-b"],
      citations: [
        { citingId: "x", citedId: "goal-a", citationType: "supersedes" }
      ]
    });
    expect(
      fake.queries.some((q) =>
        q.includes(`dolt_diff('base123', '${HEAD}', 'knowledge')`)
      )
    ).toBe(true);
  });

  it("refuses a patch that retypes a row to goal without a deadline (GOAL_REQUIRES_DEADLINE)", async () => {
    const fake = new FakeSql();
    await expect(
      adapterFor(fake).appendCommit({
        contributionId: "contrib-agent-1-abc123",
        principal: { id: "agent-1", kind: "agent" },
        message: "retype",
        edits: [{ op: "patch", targetRowId: "row-1", entry: { entryType: "goal" } }],
      })
    ).rejects.toBeInstanceOf(HypothesisMissingEvaluateAtError);
    expect(fake.conn.queries.some((q) => q.startsWith("UPDATE knowledge SET"))).toBe(false);
  });

  it("a patch may set a goal's deadline, and an update persists evaluate_at + resolution_strategy", async () => {
    const fake = new FakeSql();
    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "retype with deadline",
      edits: [
        {
          op: "patch",
          targetRowId: "row-1",
          entry: { entryType: "goal", evaluateAt: "2027-01-01T00:00:00.000Z" },
        },
      ],
    });
    const patch = fake.conn.queries.find((q) => q.startsWith("UPDATE knowledge SET"));
    expect(patch).toContain("evaluate_at = '2027-01-01T00:00:00.000Z'");

    const fake2 = new FakeSql();
    await adapterFor(fake2).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "move the By date",
      edits: [
        KnowledgeContributionEditSchema.parse({
          op: "update",
          targetRowId: "goal-a",
          entry: {
            id: "goal-a",
            domain: "strategy",
            title: "Goal: a",
            content: "Statement.",
            entryType: "goal",
            evaluateAt: "2027-02-01T00:00:00.000Z",
            resolutionStrategy: "manual",
          },
        }),
      ],
    });
    const update = fake2.conn.queries.find((q) => q.startsWith("UPDATE knowledge SET domain"));
    expect(update).toContain("evaluate_at = '2027-02-01T00:00:00.000Z'");
    expect(update).toContain("resolution_strategy = 'manual'");
  });

  it("an update that omits evaluateAt / entryType keeps the row's deadline and type", async () => {
    const fake = new FakeSql();
    const original = fake.conn.unsafe.bind(fake.conn);
    fake.conn.unsafe = async (query: string) => {
      if (query.includes("entry_type, evaluate_at, resolution_strategy FROM knowledge")) {
        fake.conn.queries.push(query);
        return [
          {
            entry_type: "goal",
            evaluate_at: "2027-03-01T00:00:00.000Z",
            resolution_strategy: "manual",
          },
        ];
      }
      return original(query);
    };
    await adapterFor(fake).appendCommit({
      contributionId: "contrib-agent-1-abc123",
      principal: { id: "agent-1", kind: "agent" },
      message: "reword the goal",
      edits: [
        KnowledgeContributionEditSchema.parse({
          op: "update",
          targetRowId: "goal-a",
          entry: { id: "goal-a", domain: "strategy", title: "Goal: a", content: "Reworded." },
        }),
      ],
    });
    const update = fake.conn.queries.find((q) => q.startsWith("UPDATE knowledge SET domain"));
    expect(update).toContain("entry_type = 'goal'");
    expect(update).toContain("evaluate_at = '2027-03-01T00:00:00.000Z'");
    expect(update).toContain("resolution_strategy = 'manual'");
  });
});

/**
 * Fakes that distinguish the branch (reserved connection) plane from the merged
 * `main` (pool) plane so the cross-plane cite path (bug.5024) can be exercised.
 * `entry_type FROM knowledge` reads resolve against the per-plane id maps; the
 * citing-row existence check (`SELECT 1 ...`) always resolves on the branch.
 */
function idFromQuery(query: string): string | undefined {
  return query.match(/id = '([^']+)'/)?.[1];
}

class CrossPlaneFakeReservedSql {
  readonly queries: string[] = [];
  private activeBranch = "main";
  private metadataDirty = false;

  constructor(private readonly branchEntryTypes: Map<string, string>) {}

  async unsafe(
    query: string
  ): Promise<Record<string, unknown>[] & { count?: number }> {
    this.queries.push(query);
    if (query.includes("current_database()"))
      return [{ dolt_writer_database: "knowledge_test" }];
    if (query.includes("active_branch()"))
      return [{ branch_name: this.activeBranch }];
    if (query.includes("dolt_checkout(")) {
      const args = [...query.matchAll(/'([^']*)'/g)].map((match) => match[1]);
      this.activeBranch = args[0] === "-b" ? args[1]! : args[0]!;
      return [{ dolt_checkout: 0 }];
    }
    if (query === "SELECT * FROM dolt.status")
      return this.metadataDirty
        ? [{ table_name: "knowledge_contributions" }]
        : [];
    if (/^(INSERT INTO|UPDATE) knowledge_contribution/.test(query)) {
      if (!this.activeBranch.startsWith("dolt-op/"))
        throw new Error("Metadata DML escaped its owned operation branch");
      this.metadataDirty = true;
    }
    if (query.includes("dolt_commit") || query.includes("dolt_reset"))
      this.metadataDirty = false;
    if (query.includes("dolt_merge_base")) return [{ merge_base: "next456" }];
    if (
      query.startsWith(
        "SELECT hash, fast_forward, conflicts, message FROM dolt_merge("
      )
    )
      return [
        { hash: "next456", conflicts: 0, fast_forward: 1, message: "merged" },
      ];
    if (query.includes("dolt.merge_status")) return [{ is_merging: false }];
    // Admission control takes a session advisory lock before any branch work
    // (bug.5391); a fake that cannot answer it would fail every write as busy.
    if (query.includes("pg_try_advisory_lock"))
      return [{ pg_try_advisory_lock: true }];
    if (query.includes("pg_advisory_unlock"))
      return [{ pg_advisory_unlock: true }];
    if (query.includes("dolt_hashof"))
      return query.includes("AS commit_hash")
        ? [{ commit_hash: HEAD }]
        : [{ dolt_hashof: HEAD }];
    if (query.includes("dolt_commit")) return [{ dolt_commit: ["{next456}"] }];
    if (query.includes("SELECT 1 FROM knowledge WHERE id"))
      return [{ "?column?": 1 }];
    if (query.includes("entry_type FROM knowledge")) {
      const t = this.branchEntryTypes.get(idFromQuery(query) ?? "");
      return t ? [{ entry_type: t }] : [];
    }
    if (query.includes("source_type FROM knowledge"))
      return [{ source_type: "external" }];
    if (query.includes("citation_type FROM citations")) return [];
    if (query.includes("UPDATE knowledge_contributions")) {
      const rows: Record<string, unknown>[] & { count?: number } = [];
      rows.count = 1;
      return rows;
    }
    if (query.includes("FROM knowledge_contributions")) return [record];
    if (query.includes("FROM knowledge_contribution_commits")) {
      return [
        {
          contribution_id: "contrib-agent-1-abc123",
          seq: 4,
          commit_hash: "next456",
          principal_kind: "agent",
          principal_id: "agent-1",
          auth_source: "bearer",
          message: "append",
          edit_count: 1,
          source_ref: "contribution:contrib-agent-1-abc123:4",
          created_at: new Date("2026-05-19T00:00:00.000Z"),
        },
      ];
    }
    return [];
  }

  release(): void {
    this.queries.push("release");
  }
}

class CrossPlaneFakeSql {
  readonly queries: string[] = [];
  readonly conn: CrossPlaneFakeReservedSql;
  private readonly mainEntryTypes: Map<string, string>;
  private readonly mainWorkItemIds: Set<string>;

  constructor(opts: {
    mainEntryTypes: Map<string, string>;
    branchEntryTypes: Map<string, string>;
    mainWorkItemIds?: Set<string>;
  }) {
    this.mainEntryTypes = opts.mainEntryTypes;
    this.mainWorkItemIds = opts.mainWorkItemIds ?? new Set();
    this.conn = new CrossPlaneFakeReservedSql(opts.branchEntryTypes);
  }

  async unsafe(query: string): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    if (query.includes("FROM knowledge_contributions")) return [record];
    if (query.includes("FROM work_items")) {
      return this.mainWorkItemIds.has(idFromQuery(query) ?? "")
        ? [{ "?column?": 1 }]
        : [];
    }
    if (query.includes("entry_type FROM knowledge")) {
      const t = this.mainEntryTypes.get(idFromQuery(query) ?? "");
      return t ? [{ entry_type: t }] : [];
    }
    if (query.includes("dolt_diff")) return [];
    return [];
  }

  async reserve(): Promise<ReservedSql> {
    return this.conn as unknown as ReservedSql;
  }
}
