// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/catalog-report`
 * Purpose: The catalog-declared run report helpers every node provider calls (CatalogEntry.report).
 * Scope: Pure helpers only. Does not run a graph or touch a logger.
 * Invariants: CATALOG_REPORT_SEAM — telemetry → one `event`, stream echo in GRAPH_REPORT delimiters.
 * Side-effects: none
 * Links: src/catalog.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  graphReportDelta,
  graphReportLogFields,
  LANGGRAPH_CATALOG,
} from "../src/catalog";

describe("catalog report seam (CatalogEntry.report)", () => {
  const report = { event: "ai.work_prioritizer.cycle" };

  it("the work prioritizer declares its report in the node catalog", () => {
    expect(LANGGRAPH_CATALOG["work-prioritizer"]?.report).toEqual(report);
  });

  it("logs the telemetry as one `event`", () => {
    expect(
      graphReportLogFields(report, "run-9", {
        telemetry: { changedItemIds: ["task.1"], changeCount: 1 },
      })
    ).toEqual([
      {
        event: "ai.work_prioritizer.cycle",
        runId: "run-9",
        changedItemIds: ["task.1"],
        changeCount: 1,
      },
    ]);
  });

  it("emits nothing when the output carries no report", () => {
    expect(graphReportLogFields(report, "r", undefined)).toEqual([]);
    expect(graphReportLogFields(report, "r", { content: "x" })).toEqual([]);
    expect(graphReportDelta({ content: "x" })).toBeNull();
  });

  it("echoes the telemetry as one <graph_report> delta", () => {
    expect(graphReportDelta({ telemetry: { changeCount: 0 } })).toBe(
      '\n<graph_report>{"changeCount":0}</graph_report>\n'
    );
  });
});
