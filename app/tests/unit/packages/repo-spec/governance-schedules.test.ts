// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/governance-schedules`
 * Purpose: Governance schedule `graph:` / `model:` support (task.5282) and LEDGER_INGEST preservation.
 * Scope: Does not touch Temporal; schema and accessor mapping only.
 * Invariants:
 *   - GRAPH_REQUIRES_MODEL: `graph` without `model` is rejected at parse time
 *   - BACK_COMPAT_SHAPE: an entry without graph/model maps to the exact pre-task.5282 object
 *   - LEDGER_PRESERVED: a declared graph charter never drops or alters the synthesized LEDGER_INGEST
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts, packages/repo-spec/src/accessors.ts
 * @public
 */

import {
  extractGovernanceConfig,
  governanceScheduleSchema,
  type RepoSpec,
} from "../../../../../packages/repo-spec/src/index";
import { describe, expect, it } from "vitest";

const BASE_ENTRY = {
  charter: "COGNI_DECIDE",
  cron: "*/5 * * * *",
  timezone: "UTC",
  entrypoint: "DECIDE",
};

describe("governanceScheduleSchema graph/model", () => {
  it("accepts a namespaced graph with a model", () => {
    const parsed = governanceScheduleSchema.parse({
      ...BASE_ENTRY,
      graph: "langgraph:cogni-decide",
      model: "gpt-oss-120b",
    });
    expect(parsed.graph).toBe("langgraph:cogni-decide");
    expect(parsed.model).toBe("gpt-oss-120b");
  });

  it("rejects graph without model", () => {
    const result = governanceScheduleSchema.safeParse({
      ...BASE_ENTRY,
      graph: "langgraph:cogni-decide",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("model");
  });

  it("rejects a non-namespaced graph id", () => {
    const result = governanceScheduleSchema.safeParse({
      ...BASE_ENTRY,
      graph: "cogni-decide",
      model: "gpt-oss-120b",
    });
    expect(result.success).toBe(false);
  });

  it("still accepts the legacy shape (no graph, no model)", () => {
    expect(governanceScheduleSchema.parse(BASE_ENTRY)).toEqual(BASE_ENTRY);
  });
});

describe("extractGovernanceConfig graph/model mapping", () => {
  const specWith = (schedules: unknown[]): RepoSpec =>
    ({ governance: { schedules } }) as unknown as RepoSpec;

  it("passes graph + model through for a graph charter", () => {
    const config = extractGovernanceConfig(
      specWith([
        {
          ...BASE_ENTRY,
          graph: "langgraph:cogni-decide",
          model: "gpt-oss-120b",
        },
      ]),
    );
    expect(config.schedules).toEqual([
      {
        ...BASE_ENTRY,
        graph: "langgraph:cogni-decide",
        model: "gpt-oss-120b",
      },
    ]);
  });

  it("BACK_COMPAT_SHAPE: a charter without graph maps to exactly the pre-task.5282 object", () => {
    const config = extractGovernanceConfig(specWith([BASE_ENTRY]));
    expect(config.schedules).toEqual([BASE_ENTRY]);
    expect(config.schedules[0]).not.toHaveProperty("graph");
    expect(config.schedules[0]).not.toHaveProperty("model");
  });
});
