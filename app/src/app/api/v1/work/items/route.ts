// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/route`
 * Purpose: HTTP endpoints for listing and creating work items.
 * Scope: Auth-protected GET (list — one authoritative backend) and POST (create — node-local Doltgres only).
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, NODE_STORE_IS_LOCAL.
 * Evaluation: shared score validation failures return HTTP400 with typed issues.
 * Side-effects: IO (HTTP response, filesystem read via port, Doltgres read/write)
 * Links: contracts/work.items.{list,create}.v1.contract
 * @public
 */

import {
  workItemsCreateOperation,
  workItemsListOperation,
} from "@cogni/node-contracts";
import { normalizeWorkItemOrder, type WorkItemOrder } from "@cogni/work-items";
import { NextResponse } from "next/server";

import {
  createWorkItem,
  InvalidCursorError,
  listWorkItems,
  NodeAdminRequiredError,
  WorkItemScoresInvalidError,
  WorkItemsBackendNotReadyError,
  WorkItemWriteOutcomeUnknownError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  EVENT_NAMES,
  logEvent,
  WORK_ITEMS_LIST_ERROR_CODES,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items — List work items with optional query filters.
 *
 * Query params: types, statuses (comma-separated), text, projectId, node (single
 * or comma-separated), limit, cursor, sortBy, sortDirection. Configured Dolt is
 * authoritative; genuinely unconfigured nodes use Markdown alone.
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "work.items.list", auth: { mode: "required", getSessionUser } },
  async (ctx, request) => {
    const startedAt = performance.now();
    let status = 500;
    let count = 0;
    let hasMore = false;
    let order: WorkItemOrder | undefined;
    let errorCode:
      | (typeof WORK_ITEMS_LIST_ERROR_CODES)[keyof typeof WORK_ITEMS_LIST_ERROR_CODES]
      | undefined = WORK_ITEMS_LIST_ERROR_CODES.INTERNAL_ERROR;
    try {
      const url = new URL(request.url);

      const typesParam = url.searchParams.get("types");
      const statusesParam = url.searchParams.get("statuses");
      const textParam = url.searchParams.get("text");
      const actorParam = url.searchParams.get("actor");
      const projectIdParam = url.searchParams.get("projectId");
      const nodeParam = url.searchParams.get("node");
      const labelsParam = url.searchParams.get("labels");
      const labelPrefixParam = url.searchParams.get("labelPrefix");
      const scoredParam = url.searchParams.get("scored");
      const limitParam = url.searchParams.get("limit");
      const cursorParam = url.searchParams.get("cursor");

      const parsed = workItemsListOperation.input.safeParse({
        sortBy: url.searchParams.get("sortBy") ?? undefined,
        sortDirection: url.searchParams.get("sortDirection") ?? undefined,
        types: typesParam ? typesParam.split(",") : undefined,
        statuses: statusesParam ? statusesParam.split(",") : undefined,
        text: textParam ?? undefined,
        actor: actorParam ?? undefined,
        projectId: projectIdParam ?? undefined,
        projectIds: url.searchParams.get("projectIds")?.split(","),
        rankMin: url.searchParams.has("rankMin")
          ? Number(url.searchParams.get("rankMin"))
          : undefined,
        rankMax: url.searchParams.has("rankMax")
          ? Number(url.searchParams.get("rankMax"))
          : undefined,
        node: nodeParam
          ? nodeParam.includes(",")
            ? nodeParam.split(",")
            : nodeParam
          : undefined,
        labels: labelsParam ? labelsParam.split(",") : undefined,
        labelPrefix: labelPrefixParam ?? undefined,
        scored:
          scoredParam === null
            ? undefined
            : scoredParam === "true"
              ? true
              : scoredParam === "false"
                ? false
                : scoredParam,
        limit: limitParam ? Number(limitParam) : undefined,
        cursor: cursorParam ?? undefined,
      });

      if (!parsed.success) {
        status = 400;
        errorCode = WORK_ITEMS_LIST_ERROR_CODES.INVALID_INPUT;
        return NextResponse.json(
          { error: "invalid input", issues: parsed.error.issues },
          { status },
        );
      }
      const input = parsed.data;
      if (
        input.rankMin !== undefined &&
        input.rankMax !== undefined &&
        input.rankMin > input.rankMax
      ) {
        status = 400;
        errorCode = WORK_ITEMS_LIST_ERROR_CODES.INVALID_INPUT;
        return NextResponse.json({ error: "invalid rank range" }, { status });
      }
      order = normalizeWorkItemOrder({
        ...(input.sortBy !== undefined && { sortBy: input.sortBy }),
        ...(input.sortDirection !== undefined && {
          sortDirection: input.sortDirection,
        }),
      });
      let result: Awaited<ReturnType<typeof listWorkItems>>;
      try {
        result = await listWorkItems(input);
      } catch (e) {
        if (e instanceof InvalidCursorError) {
          status = 400;
          errorCode = WORK_ITEMS_LIST_ERROR_CODES.INVALID_CURSOR;
          return NextResponse.json(
            {
              error: "invalid cursor",
              code: "invalid_cursor",
              message: e.message,
            },
            { status: 400 },
          );
        }
        if (e instanceof WorkItemsBackendNotReadyError) {
          status = 503;
          errorCode = WORK_ITEMS_LIST_ERROR_CODES.BACKEND_UNAVAILABLE;
          return NextResponse.json({ error: e.message }, { status });
        }
        throw e;
      }

      const response = NextResponse.json(
        workItemsListOperation.output.parse(result),
      );
      status = 200;
      errorCode = undefined;
      count = result.items.length;
      hasMore = result.pageInfo?.hasMore ?? false;
      return response;
    } catch {
      status = 500;
      errorCode = WORK_ITEMS_LIST_ERROR_CODES.INTERNAL_ERROR;
      // Keep one safe terminal event instead of duplicating wrapper errors.
      return NextResponse.json({ error: "Internal server error" }, { status });
    } finally {
      logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: performance.now() - startedAt,
        outcome: errorCode ? "error" : "success",
        count,
        hasMore,
        ...order,
        ...(errorCode && { errorCode }),
      });
    }
  },
);

/**
 * POST /api/v1/work/items — Create a new work item in Doltgres.
 *
 * Server allocates an ID in this node's own store. Author is derived from
 * `getSessionUser` and embedded in
 * the dolt_log commit message (AUTHOR_ATTRIBUTED).
 */
export const POST = wrapRouteHandlerWithLogging(
  { routeId: "work.items.create", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parseResult = workItemsCreateOperation.input.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parseResult.error.issues },
        { status: 400 },
      );
    }

    try {
      const created = await createWorkItem(parseResult.data, {
        id: sessionUser.id,
        walletAddress: sessionUser.walletAddress,
      });
      ctx.log.info(
        { workItemId: created.id, node: created.node },
        "work.items.create_success",
      );
      return NextResponse.json(workItemsCreateOperation.output.parse(created), {
        status: 201,
      });
    } catch (e) {
      if (e instanceof WorkItemScoresInvalidError) {
        return NextResponse.json(
          { error: "invalid input", errorCode: e.code, issues: e.issues },
          { status: 400 },
        );
      }
      if (e instanceof WorkItemWriteOutcomeUnknownError) {
        return NextResponse.json(
          {
            error: e.code,
            retryable: false,
            lookup: e.receipt.lookup,
            message: e.message,
          },
          { status: 409 },
        );
      }
      if (e instanceof NodeAdminRequiredError) {
        return NextResponse.json(
          { error: e.message, errorCode: e.errorCode, action: e.action },
          { status: e.status },
        );
      }
      if (e instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: e.message }, { status: 503 });
      }
      if ((e as Error)?.name === "WorkItemAlreadyExistsError") {
        return NextResponse.json(
          { error: (e as Error).message },
          { status: 409 },
        );
      }
      throw e;
    }
  },
);
