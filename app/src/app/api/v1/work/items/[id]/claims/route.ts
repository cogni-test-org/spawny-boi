// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/claims/route`
 * Purpose: Authenticated work-item claim and release endpoints.
 * Scope: HTTP validation and facade delegation only.
 * Invariants: VALIDATE_IO, CLAIM_AUTH_BINDS_PRINCIPAL_AND_RUN.
 * Side-effects: IO (HTTP response, Doltgres mutation through facade)
 * @public
 */

import {
  workItemsClaimOperation,
  workItemsReleaseOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  claimWorkItem,
  releaseWorkItem,
  WorkItemLeaseConflictError,
  WorkItemNotFoundError,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.claim", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    if (
      typeof body === "object" &&
      body !== null &&
      "id" in body &&
      body.id !== undefined &&
      body.id !== id
    ) {
      return NextResponse.json(
        { error: "body id must match path id" },
        { status: 400 }
      );
    }

    const parsed = workItemsClaimOperation.input.safeParse({
      ...(typeof body === "object" && body !== null ? body : {}),
      id,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const result = await claimWorkItem({
        ...parsed.data,
        principalId: sessionUser.id,
      });
      ctx.log.info(
        { workItemId: id, runId: parsed.data.runId },
        "work.items.claim_success"
      );
      return NextResponse.json(workItemsClaimOperation.output.parse(result));
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof WorkItemLeaseConflictError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  }
);

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.release",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;
    const url = new URL(request.url);
    const parsed = workItemsReleaseOperation.input.safeParse({
      id,
      runId: url.searchParams.get("runId") ?? undefined,
      leaseToken: url.searchParams.get("leaseToken") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const result = await releaseWorkItem({
        ...parsed.data,
        principalId: sessionUser.id,
      });
      ctx.log.info(
        { workItemId: id, runId: parsed.data.runId },
        "work.items.release_success"
      );
      return NextResponse.json(workItemsReleaseOperation.output.parse(result));
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof WorkItemLeaseConflictError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  }
);
