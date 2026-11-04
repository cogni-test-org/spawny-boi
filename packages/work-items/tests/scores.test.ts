// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/scores`
 * Purpose: Pins the package-owned `scores` bounds and the WSJF rank (story.5111).
 * Scope: Pure functions only. Does not touch an adapter or a database.
 * Invariants:
 *   - SCORE_NEEDS_EVIDENCE: v ≥ 4 without ev is rejected.
 *   - EV_SAFE_HTTPS: any source hostname is accepted; ev is absolute HTTPS without credentials, ≤ 300 chars.
 *   - SCORES_MAX_1KB: the serialized object is ≤ 1024 bytes.
 *   - RANK_UNKNOWN_IS_UNDEFINED: a missing or 0 rank axis gives undefined.
 * Side-effects: none
 * Links: packages/work-items/src/scores.ts, hub work-item-scores-design
 * @internal
 */

import { describe, expect, it } from "vitest";

import { parseWorkItemScores, rankScore } from "../src/scores.js";

const EV = "https://cognidao.org/work/items/story.5111";
const codes = (input: unknown) => {
  const result = parseWorkItemScores(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};
const axes = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`axis${i}`, { v: 1 }])
  );

describe("parseWorkItemScores", () => {
  it("accepts the six design axes and returns a fresh v/ev-only object", () => {
    const input = {
      goal: { v: 5, ev: EV },
      time: { v: 0 },
      unblocks: {
        v: 4,
        ev: "https://github.com/cogni-dao/node-template/pull/198",
      },
      ease: { v: 3 },
      confidence: { v: 4, ev: "https://test.cognidao.org/version" },
      agent: {
        v: 4,
        ev: "https://cognidao.org/knowledge/work-item-scores-design",
      },
    };
    const result = parseWorkItemScores(input);
    expect(result).toEqual({ ok: true, value: input });
    expect(result.ok && result.value).not.toBe(input);
  });

  it("accepts null (clears the field)", () => {
    expect(parseWorkItemScores(null)).toEqual({ ok: true, value: null });
  });

  it("accepts a new axis id without a code change (axes are config)", () => {
    expect(codes({ reach_2: { v: 2 } })).toEqual([]);
  });

  it.each([
    ["v ≥ 4 without ev", { goal: { v: 4 } }, "evidence_required"],
    ["v = 5 without ev", { goal: { v: 5 } }, "evidence_required"],
    [
      "userinfo smuggling",
      { goal: { v: 4, ev: "https://cognidao.org@evil.example/x" } },
      "evidence_invalid_url",
    ],
    [
      "credentials on an allowed host",
      { goal: { v: 4, ev: "https://u:p@cognidao.org/x" } },
      "evidence_invalid_url",
    ],
    [
      "http://",
      { goal: { v: 4, ev: "http://cognidao.org/x" } },
      "evidence_not_https",
    ],
    [
      "javascript:",
      { goal: { v: 4, ev: "javascript:alert(1)" } },
      "evidence_not_https",
    ],
    [
      "data:",
      { goal: { v: 1, ev: "data:text/html,<script>1</script>" } },
      "evidence_not_https",
    ],
    [
      "non-URL ev",
      { goal: { v: 4, ev: "see story.5108" } },
      "evidence_invalid_url",
    ],
    [
      "missing HTTPS authority",
      { goal: { v: 4, ev: "https:example.com/x" } },
      "evidence_invalid_url",
    ],
    [
      "raw URL whitespace",
      { goal: { v: 4, ev: "https://example.com/a b" } },
      "evidence_invalid_url",
    ],
    ["relative URL", { goal: { v: 4, ev: "/source" } }, "evidence_invalid_url"],
    ["non-string ev", { goal: { v: 1, ev: 42 } }, "evidence_not_string"],
    [
      "ev over 300 chars",
      { goal: { v: 4, ev: `${EV}?${"a".repeat(300)}` } },
      "evidence_too_long",
    ],
    ["v above 5", { goal: { v: 6 } }, "invalid_value"],
    ["negative v", { goal: { v: -1 } }, "invalid_value"],
    ["fractional v", { goal: { v: 2.5 } }, "invalid_value"],
    ["string v", { goal: { v: "3" } }, "invalid_value"],
    ["missing v", { goal: { ev: EV } }, "invalid_value"],
    ["uppercase axis id", { Goal: { v: 1 } }, "invalid_axis_id"],
    ["hyphenated axis id", { "do-now": { v: 1 } }, "invalid_axis_id"],
    ["axis id starting with a digit", { "1goal": { v: 1 } }, "invalid_axis_id"],
    [
      "33-char axis id",
      { [`a${"b".repeat(32)}`]: { v: 1 } },
      "invalid_axis_id",
    ],
    ["extra property", { goal: { v: 1, note: "x" } }, "unknown_property"],
    ["non-object entry", { goal: 3 }, "invalid_entry"],
    ["array", [], "not_object"],
    ["string", "goal=5", "not_object"],
    ["undefined", undefined, "not_object"],
  ])("rejects %s", (_label, input, code) => {
    expect(codes(input)).toContain(code);
  });

  it("rejects 13 axes and accepts 12", () => {
    expect(codes(axes(12))).toEqual([]);
    expect(codes(axes(13))).toContain("too_many_axes");
  });

  it("rejects a blob over 1 KB even when every field is in bounds", () => {
    const ev = `${EV}?q=${"a".repeat(240)}`;
    const big = Object.fromEntries(
      ["goal", "time", "unblocks", "ease"].map((axis) => [axis, { v: 4, ev }])
    );
    expect(ev.length).toBeLessThanOrEqual(300);
    expect(codes(big)).toEqual(["too_large"]);
    expect(codes(Object.fromEntries(Object.entries(big).slice(0, 3)))).toEqual(
      []
    );
  });

  it.each([
    "https://example.com/research",
    "https://github.com/someone/repo",
    "https://mynode.org/goals/1",
    "https://any-tenant.grafana.net/explore?x=1",
    "https://future-source.example/observation",
  ])("accepts a justification from any HTTPS hostname: %s", (ev) => {
    expect(parseWorkItemScores({ goal: { v: 4, ev } })).toEqual({
      ok: true,
      value: { goal: { v: 4, ev } },
    });
  });
});

describe("rankScore", () => {
  const s = (
    goal: number,
    time: number,
    unblocks: number,
    ease: number,
    confidence: number
  ) => ({
    goal: { v: goal },
    time: { v: time },
    unblocks: { v: unblocks },
    ease: { v: ease },
    confidence: { v: confidence },
    agent: { v: 3 },
  });

  it("divides by the ease band's midpoint iterations", () => {
    // (5+5+5) / 1 × 5/5
    expect(rankScore(s(5, 5, 5, 5, 5))).toBe(15);
    // (5+2+5) / 2.5 × 4/5 — story.5108 in work-item-scores-visual
    expect(rankScore(s(5, 2, 5, 3, 4))).toBeCloseTo(3.84);
    expect(rankScore(s(3, 3, 3, 4, 5))).toBe(6);
    expect(rankScore(s(3, 3, 3, 2, 5))).toBeCloseTo(1.8);
    expect(rankScore(s(4, 4, 4, 1, 5))).toBe(1.5);
  });

  it("uses agent for completeness but not the WSJF multiplier", () => {
    expect(rankScore({ ...s(5, 5, 5, 5, 5), agent: { v: 1 } })).toBe(15);
  });

  it.each([
    "goal",
    "time",
    "unblocks",
    "ease",
    "confidence",
    "agent",
  ])("is undefined when %s is missing or 0", (axis) => {
    const missing: Record<string, { v: number }> = { ...s(3, 3, 3, 3, 3) };
    delete missing[axis];
    expect(rankScore(missing)).toBeUndefined();
    expect(
      rankScore({ ...s(3, 3, 3, 3, 3), [axis]: { v: 0 } })
    ).toBeUndefined();
  });

  it("is undefined for null or undefined scores", () => {
    expect(rankScore(null)).toBeUndefined();
    expect(rankScore(undefined)).toBeUndefined();
  });
});
