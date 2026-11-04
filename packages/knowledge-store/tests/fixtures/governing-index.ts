// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@tests/fixtures/governing-index`
 * Purpose: Shared disposable completeness fixture beyond the browse API's cap.
 * Scope: Test data only; no I/O or production export.
 * Invariants: Oldest eligible rule precedes over 1,000 newer same-shelf rows; seven types and retirement controls.
 * Side-effects: none
 * Links: task.5309
 * @internal
 */
import { GOVERNING_ENTRY_TYPES } from "../../src/domain/governing.js";
import type { NewKnowledge } from "../../src/domain/schemas.js";
export const GOVERNING_FIXTURE_DOMAIN = "governingproof";
export const GOVERNING_FIXTURE_NEWER_COUNT = 1001;
export function governingFixture() {
  const make = (
    id: string,
    entryType: string,
    useWhen: string | null,
    domain = GOVERNING_FIXTURE_DOMAIN
  ): NewKnowledge & { createdAt: Date } => ({
    id,
    domain,
    entryType,
    useWhen,
    title: `Title ${id}`,
    content: `PRIVATE BODY ${id}`,
    sourceType: "human",
    createdAt: new Date("2026-10-23T00:00:00Z"),
  });
  const oldest = make(
    "gov-old-rule",
    "rule",
    "  review oldest infrastructure guidance  "
  );
  oldest.createdAt = new Date("2020-01-01T00:00:00Z");
  const mission = make("gov-mission", "finding", null);
  mission.content = "CUSTOM NODE MISSION SENTINEL";
  const orientation = make("fresh-node-agent-orientation", "guide", null);
  orientation.content = `CUSTOM LOCAL ORIENTATION ${"retain bytes ".repeat(200)}`;
  const rows = [
    oldest,
    ...Array.from({ length: GOVERNING_FIXTURE_NEWER_COUNT }, (_, i) => {
      const entryType = GOVERNING_ENTRY_TYPES[i % GOVERNING_ENTRY_TYPES.length];
      if (!entryType) throw new Error("Invalid governing fixture type");
      return make(
        `gov-newer-${String(i).padStart(4, "0")}`,
        entryType,
        `Situation ${i}: ${"precise trigger ".repeat(12)}`
      );
    }),
    make("gov-blank", "guide", "  "),
    make("gov-null", "rule", null),
    make("gov-evidence", "finding", "evidence"),
    make("gov-retired", "guide", "retired situation"),
    make("gov-new", "reference", "new situation"),
    make("gov-method", "rule", "review a design", "method"),
    mission,
    orientation,
  ];
  return {
    rows,
    edges: [
      {
        citingId: "gov-new",
        citedId: "gov-retired",
        citationType: "supersedes" as const,
      },
    ],
  };
}
