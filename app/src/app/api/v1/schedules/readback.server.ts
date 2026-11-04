// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/api/v1/schedules/readback.server
 * Purpose: Compose schedule readback and map its typed errors to HTTP.
 * Scope: Delivery wiring only; no database access or authorization policy.
 * Invariants: Unknown failures propagate; not-found does not disclose ownership.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
import type { EventName } from "@cogni/node-shared";
import { InvalidScheduleRunCursorError } from "@cogni/scheduler-core";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import {
  createScheduleHistoryService,
  ScheduleHistoryNotFoundError,
} from "@/features/scheduling/services/schedule-history";
import { logEvent, type RequestContext } from "@/shared/observability";

export function scheduleReadback() {
  const container = getContainer();
  return createScheduleHistoryService({
    schedules: container.scheduleManager,
    reader: container.scheduleRunReader,
  });
}
export const scheduleReadHeaders = { "Cache-Control": "no-store" };
export function scheduleReadError(
  error: unknown,
  ctx: RequestContext,
  event: EventName,
  startedAt: number
) {
  if (error instanceof ScheduleHistoryNotFoundError) {
    logEvent(ctx.log, event, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      status: 404,
      outcome: "error",
      errorCode: "SCHEDULE_READ_NOT_FOUND",
      durationMs: performance.now() - startedAt,
    });
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: scheduleReadHeaders }
    );
  }
  if (error instanceof InvalidScheduleRunCursorError) {
    logEvent(ctx.log, event, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      status: 400,
      outcome: "error",
      errorCode: "SCHEDULE_CURSOR_INVALID",
      durationMs: performance.now() - startedAt,
    });
    return NextResponse.json(
      { error: error.message },
      { status: 400, headers: scheduleReadHeaders }
    );
  }
  throw error;
}

export function invalidScheduleRead(
  ctx: RequestContext,
  event: EventName,
  startedAt: number
) {
  logEvent(ctx.log, event, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: 400,
    outcome: "error",
    errorCode: "SCHEDULE_READ_INVALID",
    durationMs: performance.now() - startedAt,
  });
  return NextResponse.json(
    { error: "Invalid schedule request" },
    { status: 400, headers: scheduleReadHeaders }
  );
}
