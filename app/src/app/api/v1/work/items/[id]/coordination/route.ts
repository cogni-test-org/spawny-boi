// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/coordination/route`
 * Purpose: Authenticated work-item coordination-state endpoint.
 * Scope: HTTP validation and facade delegation only.
 * Invariants: VALIDATE_IO, PORT_VIA_FACADE.
 * Side-effects: IO (HTTP response, Doltgres read through facade)
 * @public
 */

import { workItemsCoordinationOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  getWorkItemCoordination,
  WorkItemNotFoundError,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.coordination",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const parsed = workItemsCoordinationOperation.input.safeParse({ id });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const result = await getWorkItemCoordination(parsed.data.id);
      ctx.log.info({ workItemId: id }, "work.items.coordination_success");
      return NextResponse.json(
        workItemsCoordinationOperation.output.parse(result)
      );
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  }
);
