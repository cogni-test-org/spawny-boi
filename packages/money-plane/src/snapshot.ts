// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/snapshot`
 * Purpose: Run every plane reader concurrently under one timeout and return one row per reader plus the worst grade.
 * Scope: Orchestration only. Does not decide alerts, write work items, log, or render.
 * Invariants: READERS_NEVER_THROW — a reader that throws becomes UNKNOWN `unreadable`, one that outlives the timeout becomes UNKNOWN `timeout` (its signal is aborted); takeSnapshot itself never rejects. Rows keep reader order. UNREADABLE_IS_UNKNOWN via applyGradingFloor.
 * Side-effects: time (setTimeout)
 * Links: src/row.ts, https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

import { worstGrade } from "./grade";
import { applyGradingFloor, unknownRow } from "./row";
import type { MoneyPlaneRow, MoneyPlaneSnapshot, PlaneReader } from "./types";

export interface SnapshotOptions {
  /** Per-reader budget; a slower reader is reported UNKNOWN `timeout`. */
  timeoutMs: number;
  now?: () => Date;
}

const TIMED_OUT = Symbol("timed-out");

function fallback(
  reader: PlaneReader,
  reasonCode: "unreadable" | "timeout",
  observedAt: string,
  detail?: string
): MoneyPlaneRow {
  return {
    ...unknownRow({
      plane: reader.plane,
      label: reader.label ?? reader.plane,
      kind: reader.kind ?? "prepaid",
      reasonCode,
      observedAt,
      ...(detail === undefined ? {} : { detail }),
      ...(reader.payAction === undefined ? {} : { payAction: reader.payAction }),
    }),
    ...(reader.rail === undefined ? {} : { rail: reader.rail }),
    ...(reader.wallet === undefined ? {} : { wallet: reader.wallet }),
  };
}

async function settle(
  reader: PlaneReader,
  timeoutMs: number,
  now: () => Date
): Promise<MoneyPlaneRow> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => reader.read(controller.signal)),
      deadline,
    ]);
    if (result === TIMED_OUT) {
      return fallback(
        reader,
        "timeout",
        now().toISOString(),
        `no answer in ${timeoutMs} ms`
      );
    }
    return applyGradingFloor(result);
  } catch {
    return fallback(reader, "unreadable", now().toISOString(), "reader failed");
  } finally {
    // A reader can settle before all of its parallel child requests finish.
    // Release those requests as well as the deadline on every exit path.
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function takeSnapshot(
  readers: readonly PlaneReader[],
  options: SnapshotOptions
): Promise<MoneyPlaneSnapshot> {
  const now = options.now ?? (() => new Date());
  const takenAt = now().toISOString();
  const rows = await Promise.all(
    readers.map((r) => settle(r, options.timeoutMs, now))
  );
  const treeGrade = (row: MoneyPlaneRow): MoneyPlaneRow["grade"] =>
    worstGrade([row.grade, ...(row.children ?? []).map(treeGrade)]);
  return { takenAt, rows, worst: worstGrade(rows.map(treeGrade)) };
}
