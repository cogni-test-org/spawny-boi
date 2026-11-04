// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/api/v1/schedules/[scheduleId]/runs
 * Purpose: Read a page of owned schedule execution metadata.
 * Scope: Auth and contract validation; delegates ownership and readback to service.
 * Invariants: No output fanout; bounded page; no-store; no system impersonation.
 * Side-effects: IO (database reads)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import { toUserId } from "@cogni/ids";
import {
  ScheduleParamsSchema,
  schedulesHistoryOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import {
  invalidScheduleRead,
  scheduleReadback,
  scheduleReadError,
  scheduleReadHeaders,
} from "../../readback.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ scheduleId: string }>;
}>(
  { routeId: "schedules.history", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, context) => {
    const startedAt = performance.now();
    if (!context) throw new Error("Route context required");
    const params = ScheduleParamsSchema.safeParse(await context.params);
    const search = new URL(request.url).searchParams;
    const query = schedulesHistoryOperation.input.safeParse({
      limit: search.get("limit") ?? undefined,
      cursor: search.get("cursor") ?? undefined,
    });
    if (!params.success || !query.success)
      return invalidScheduleRead(
        ctx,
        EVENT_NAMES.SCHEDULE_HISTORY_READ,
        startedAt
      );
    try {
      const result = await scheduleReadback().history(
        toUserId(sessionUser.id),
        params.data.scheduleId,
        {
          limit: query.data.limit,
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        }
      );
      const response = NextResponse.json(
        schedulesHistoryOperation.output.parse(result),
        {
          headers: scheduleReadHeaders,
        }
      );
      logEvent(ctx.log, EVENT_NAMES.SCHEDULE_HISTORY_READ, {
        reqId: ctx.reqId,
        status: 200,
        outcome: "success",
        durationMs: performance.now() - startedAt,
        routeId: "schedules.history",
        scheduleId: params.data.scheduleId,
        count: result.runs.length,
      });
      return response;
    } catch (error) {
      return scheduleReadError(
        error,
        ctx,
        EVENT_NAMES.SCHEDULE_HISTORY_READ,
        startedAt
      );
    }
  }
);
