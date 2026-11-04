// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/heartbeat/route`
 * Purpose: Authenticated work-item lease heartbeat endpoint.
 * Scope: HTTP validation and facade delegation only.
 * Invariants: VALIDATE_IO, CLAIM_AUTH_BINDS_PRINCIPAL_AND_RUN.
 * Side-effects: IO (HTTP response, Doltgres mutation through facade)
 * @public
 */

import { workItemsHeartbeatOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  heartbeatWorkItem,
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
  {
    routeId: "work.items.heartbeat",
    auth: { mode: "required", getSessionUser },
  },
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

    const parsed = workItemsHeartbeatOperation.input.safeParse({
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
      const result = await heartbeatWorkItem({
        id: parsed.data.id,
        runId: parsed.data.runId,
        leaseToken: parsed.data.leaseToken,
        ...(parsed.data.command !== undefined && {
          command: parsed.data.command,
        }),
        principalId: sessionUser.id,
      });
      ctx.log.info(
        { workItemId: id, runId: parsed.data.runId },
        "work.items.heartbeat_success"
      );
      return NextResponse.json(
        workItemsHeartbeatOperation.output.parse(result)
      );
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
