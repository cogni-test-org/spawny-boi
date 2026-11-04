// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/governing-index`
 * Purpose: Prove uncapped content-free local governing discovery and adapter parity.
 * Scope: In-memory adapter tests; real Doltgres parity is in the component CI lane.
 * Invariants: One governing selector; no blank trigger or superseded target routes.
 * Side-effects: none
 * Links: task.5309; src/domain/governing.ts
 * @internal
 */
import { afterEach, expect, it, vi } from "vitest";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import {
  governingFixture,
  GOVERNING_FIXTURE_DOMAIN,
} from "./fixtures/governing-index.js";
import { selectGoverningIndex } from "../src/domain/governing.js";

afterEach(() => vi.useRealTimers());

it("returns the oldest governing rule beyond 1,000 newer same-shelf rows with exact shared selection and read-only parity", async () => {
  const { rows, edges } = governingFixture();
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: GOVERNING_FIXTURE_DOMAIN, name: "Fixture" });
  await store.registerDomain({ id: "method", name: "Method" });
  vi.useFakeTimers();
  await store.withWrite(
    { operationId: "governing-complete", message: "fixture" },
    async (write) => {
      for (const row of rows) {
        vi.setSystemTime(row.createdAt);
        await write.addKnowledge(row);
      }
      for (const edge of edges) await write.addCitation(edge);
    }
  );
  const before = JSON.stringify(
    await Promise.all(rows.map((r) => store.getKnowledge(r.id)))
  );
  const commits = store.commitLog.length;
  expect(
    (await store.listKnowledge(GOVERNING_FIXTURE_DOMAIN, { limit: 1000 })).some(
      (r) => r.id === "gov-old-rule"
    )
  ).toBe(false);
  const actual = await store.listGoverningIndex();
  expect(actual).toEqual(selectGoverningIndex(rows, edges));
  expect(new Set(actual.map((r) => r.entryType)).size).toBe(7);
  expect(actual.some((r) => r.id === "gov-old-rule")).toBe(true);
  expect(
    actual.some((r) =>
      ["gov-blank", "gov-null", "gov-retired", "gov-evidence"].includes(r.id)
    )
  ).toBe(false);
  expect(JSON.stringify(actual)).not.toContain("PRIVATE BODY");
  expect(
    JSON.stringify(await Promise.all(rows.map((r) => store.getKnowledge(r.id))))
  ).toBe(before);
  expect(store.commitLog).toHaveLength(commits);
});

it.each([
  "skill",
  "guide",
  "playbook",
  "rule",
  "design",
  "decision",
  "reference",
])("routes the canonical governing type %s by trigger", async (entryType) => {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "method", name: "Method" });
  await store.withWrite(
    { operationId: `fixture:${entryType}`, message: "fixture" },
    (write) =>
      write.addKnowledge({
        id: "qualified",
        domain: "method",
        title: "not routing text",
        content: "PRIVATE BODY",
        entryType,
        useWhen: "a precise situation",
        sourceType: "human",
      })
  );
  expect(await store.listGoverningIndex()).toEqual([
    {
      id: "qualified",
      domain: "method",
      entryType,
      useWhen: "a precise situation",
    },
  ]);
});
