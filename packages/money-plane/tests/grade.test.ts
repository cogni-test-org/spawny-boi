// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/tests/grade`
 * Purpose: Pin the grading policy: thresholds, and that an unmeasured value is UNKNOWN, never GREEN.
 * Scope: Pure functions only.
 * Invariants: UNREADABLE_IS_UNKNOWN
 * Side-effects: none
 * Links: src/grade.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  EXPIRY_DAYS,
  gradeExpiry,
  gradeRunway,
  gradeSpend,
  RUNWAY_DAYS,
  SPEND_USD_PER_MONTH,
  worstGrade,
} from "../src/index";

describe("policy constants", () => {
  it("match the approved design", () => {
    expect(RUNWAY_DAYS).toEqual({ yellow: 21, red: 7 });
    expect(SPEND_USD_PER_MONTH).toEqual({ yellow: 100, red: 300 });
    expect(EXPIRY_DAYS).toEqual({ yellow: 45, red: 14 });
  });
});

describe("gradeRunway", () => {
  it("grades by days of runway left", () => {
    expect(gradeRunway(30)).toBe("GREEN");
    expect(gradeRunway(21)).toBe("GREEN");
    expect(gradeRunway(20.9)).toBe("YELLOW");
    expect(gradeRunway(7)).toBe("YELLOW");
    expect(gradeRunway(6.9)).toBe("RED");
    expect(gradeRunway(0)).toBe("RED");
  });

  it("treats a measured zero burn (infinite runway) as GREEN", () => {
    expect(gradeRunway(Number.POSITIVE_INFINITY)).toBe("GREEN");
  });

  it("is UNKNOWN, never GREEN, when runway is unmeasured", () => {
    expect(gradeRunway(null)).toBe("UNKNOWN");
    expect(gradeRunway(undefined)).toBe("UNKNOWN");
    expect(gradeRunway(Number.NaN)).toBe("UNKNOWN");
    expect(gradeRunway(-1)).toBe("UNKNOWN");
  });
});

describe("gradeSpend", () => {
  it("does not imply approval from an ungoverned spend threshold", () => {
    expect(gradeSpend(0)).toBe("UNKNOWN");
    expect(gradeSpend(50)).toBe("UNKNOWN");
    expect(gradeSpend(300)).toBe("UNKNOWN");
  });
  it("grades a monthly spend rate, higher is worse", () => {
    expect(gradeSpend(50, SPEND_USD_PER_MONTH)).toBe("GREEN");
    expect(gradeSpend(100, SPEND_USD_PER_MONTH)).toBe("YELLOW");
    expect(gradeSpend(299, SPEND_USD_PER_MONTH)).toBe("YELLOW");
    expect(gradeSpend(300, SPEND_USD_PER_MONTH)).toBe("RED");
    expect(gradeSpend(null)).toBe("UNKNOWN");
    expect(gradeSpend(-5)).toBe("UNKNOWN");
    expect(gradeSpend(Number.POSITIVE_INFINITY, SPEND_USD_PER_MONTH)).toBe(
      "UNKNOWN"
    );
  });
});

describe("gradeExpiry", () => {
  it("grades days until expiry", () => {
    expect(gradeExpiry(90)).toBe("GREEN");
    expect(gradeExpiry(44)).toBe("YELLOW");
    expect(gradeExpiry(13)).toBe("RED");
    expect(gradeExpiry(null)).toBe("UNKNOWN");
  });
});

describe("worstGrade", () => {
  it("orders RED > UNKNOWN > YELLOW > GREEN > INFO", () => {
    expect(worstGrade(["GREEN", "YELLOW", "INFO"])).toBe("YELLOW");
    expect(worstGrade(["YELLOW", "UNKNOWN"])).toBe("UNKNOWN");
    expect(worstGrade(["UNKNOWN", "RED", "GREEN"])).toBe("RED");
    expect(worstGrade(["INFO", "GREEN"])).toBe("GREEN");
    expect(worstGrade(["INFO"])).toBe("INFO");
  });

  it("is UNKNOWN for an empty set: nothing measured is not GREEN", () => {
    expect(worstGrade([])).toBe("UNKNOWN");
  });
});
