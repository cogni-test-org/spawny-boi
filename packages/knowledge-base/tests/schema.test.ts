// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base/tests/schema`
 * Purpose: Pin the shared knowledge schema contract every knowledge-capable node inherits — the seed bundle's table set and the `knowledge` columns a node's Doltgres migration chain is generated from.
 * Purpose (cont): `use_when` is asserted explicitly because it is a COLUMN, not a content convention, and a node whose snapshot lacks it cannot project a retrieval routing table.
 * Scope: Drizzle table introspection only. Does not connect to a database, apply migrations, or read a node's committed snapshot.
 * Invariants:
 *   - The seed bundle exports exactly the 6 knowledge-family tables that `doltgres-schema` re-exports; losing one silently shrinks every node's generated migration.
 *   - `knowledge.use_when` exists and is NULLABLE — pre-existing rows are backfilled, never rejected (task.5193).
 * Side-effects: none
 * Links: ../src/schema.ts, packages/doltgres-schema/src/knowledge.ts, scripts/db/check-generate-clean.mjs
 */

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  citations,
  domains,
  knowledge,
  knowledgeContributionCommits,
  knowledgeContributions,
  sources,
} from "../src/schema.js";

function columnsOf(table: Parameters<typeof getTableConfig>[0]) {
  return new Map(getTableConfig(table).columns.map((c) => [c.name, c]));
}

describe("knowledge-base seed bundle", () => {
  it("exports the 6 knowledge-family tables doltgres-schema re-exports", () => {
    const names = [
      citations,
      domains,
      knowledge,
      knowledgeContributionCommits,
      knowledgeContributions,
      sources,
    ].map((t) => getTableConfig(t).name);
    expect(names.sort()).toEqual([
      "citations",
      "domains",
      "knowledge",
      "knowledge_contribution_commits",
      "knowledge_contributions",
      "sources",
    ]);
  });
});

describe("knowledge.use_when", () => {
  it("exists as a real column", () => {
    expect([...columnsOf(knowledge).keys()]).toContain("use_when");
  });

  it("is nullable, so pre-existing rows are backfilled rather than rejected", () => {
    const useWhen = columnsOf(knowledge).get("use_when");
    expect(useWhen).toBeDefined();
    expect(useWhen?.notNull).toBe(false);
    expect(useWhen?.hasDefault).toBe(false);
  });

  it("is text, matching the generated `ADD COLUMN \"use_when\" text`", () => {
    expect(columnsOf(knowledge).get("use_when")?.getSQLType()).toBe("text");
  });
});

describe("knowledge provenance columns (ENTRY_HAS_PROVENANCE / ENTRY_HAS_DOMAIN)", () => {
  it("keeps domain and source_type NOT NULL", () => {
    const columns = columnsOf(knowledge);
    expect(columns.get("domain")?.notNull).toBe(true);
    expect(columns.get("source_type")?.notNull).toBe(true);
  });
});
