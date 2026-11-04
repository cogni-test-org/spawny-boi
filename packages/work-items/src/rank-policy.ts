// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Private rank expression: the evaluator and native SQL share this exact tree. */
import type { WorkItemScores } from "./types.js";
export const EASE_ITERATIONS: Readonly<Record<number, number>> = Object.freeze({
  5: 1,
  4: 1.5,
  3: 2.5,
  2: 5,
  1: 8
});
const REQUIRED_AXES = [
  "goal",
  "time",
  "unblocks",
  "ease",
  "confidence",
  "agent"
] as const;
type Expression =
  | { axis: string }
  | { constant: number }
  | { iterations: Expression }
  | { op: "+" | "/" | "*"; left: Expression; right: Expression };
const axis = (name: string): Expression => ({ axis: name });
const binary = (
  op: "+" | "/" | "*",
  left: Expression,
  right: Expression
): Expression => ({ op, left, right });
const POLICY = binary(
  "/",
  binary(
    "*",
    binary(
      "/",
      binary("+", binary("+", axis("goal"), axis("time")), axis("unblocks")),
      { iterations: axis("ease") }
    ),
    axis("confidence")
  ),
  { constant: 5 }
);

function validAxis(scores: WorkItemScores, name: string): number | undefined {
  const v = scores[name]?.v;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5
    ? v
    : undefined;
}
export function evaluateRank(
  scores: WorkItemScores | null | undefined
): number | undefined {
  if (
    !scores ||
    REQUIRED_AXES.some((name) => validAxis(scores, name) === undefined)
  )
    return undefined;
  const evaluate = (expr: Expression): number => {
    if ("axis" in expr) return validAxis(scores, expr.axis) as number;
    if ("constant" in expr) return expr.constant;
    if ("iterations" in expr)
      return EASE_ITERATIONS[evaluate(expr.iterations)] as number;
    const a = evaluate(expr.left),
      b = evaluate(expr.right);
    return expr.op === "+" ? a + b : expr.op === "*" ? a * b : a / b;
  };
  return evaluate(POLICY);
}

/** Identifiers/axis names here are package constants, never caller-controlled SQL. */
export function rankScoreSql(): string {
  const number = (value: number) => `CAST(${value} AS DOUBLE PRECISION)`;
  const axisSql = (name: string) => {
    const value = `(scores -> '${name}' -> 'v')`;
    const cast = `CAST((scores -> '${name}' ->> 'v') AS DOUBLE PRECISION)`;
    // Nested CASE prevents casts of historical strings/objects/bools/null; numeric JSON only.
    return `(CASE WHEN ${value} IN ('1'::JSONB,'2'::JSONB,'3'::JSONB,'4'::JSONB,'5'::JSONB) THEN ${cast} ELSE NULL END)`;
  };
  const render = (expr: Expression): string => {
    if ("axis" in expr) return axisSql(expr.axis);
    if ("constant" in expr) return number(expr.constant);
    if ("iterations" in expr)
      return `(CASE ${render(expr.iterations)} ${Object.entries(EASE_ITERATIONS)
        .map(([ease, iterations]) => `WHEN ${ease} THEN ${number(iterations)}`)
        .join(" ")} ELSE NULL END)`;
    return `(${render(expr.left)} ${expr.op} ${render(expr.right)})`;
  };
  return `(CASE WHEN ${axisSql("agent")} IS NOT NULL THEN ${render(POLICY)} ELSE NULL END)`;
}
