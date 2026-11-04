// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/_api/readHistory
 * Purpose: Contract-validated schedule and run history reads.
 * Scope: Browser transport only; no persistence or execution.
 * Invariants: Same-origin credentials; no-store; error responses are not empty results.
 * Side-effects: IO
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
import {
  schedulesGetOperation,
  schedulesHistoryOperation,
} from "@cogni/node-contracts";

async function read(path: string): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      typeof body.error === "string" ? body.error : "Unable to load schedule"
    );
  return body;
}
export async function fetchSchedule(id: string) {
  return schedulesGetOperation.output.parse(
    await read(`/api/v1/schedules/${encodeURIComponent(id)}`)
  );
}
export async function fetchScheduleHistory(id: string, cursor: string | null) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return schedulesHistoryOperation.output.parse(
    await read(`/api/v1/schedules/${encodeURIComponent(id)}/runs${query}`)
  );
}
