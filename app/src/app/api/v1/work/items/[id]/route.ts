// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for getting, patching, and deleting a single work item by ID.
 * Scope: Auth-protected GET (node-local Doltgres first, markdown fallback), PATCH (Doltgres only), and DELETE (retired, HTTP 410).
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, PATCH_ALLOWLIST, DURABLE_IDENTITY_NEVER_REUSED.
 * Evaluation: shared score validation failures return HTTP400 with typed issues.
 * Side-effects: IO (HTTP response, filesystem read via port, Doltgres read/write/delete)
 * Links: contracts/work.items.{get,patch,delete}.v1.contract
 * @public
 */

import {
  workItemsDeleteOperation,
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  getWorkItem,
  NodeAdminRequiredError,
  patchWorkItem,
  WorkItemForbiddenError,
  WorkItemNotFoundError,
  WorkItemRevisionConflictError,
  WorkItemScoresInvalidError,
  WorkItemsBackendNotReadyError,
  WorkItemWriteOutcomeUnknownError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items/:id — Get a single work item by ID from node-local
 * Doltgres, falling back to the legacy markdown port when not imported.
 */
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.get", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    let item: Awaited<ReturnType<typeof getWorkItem>>;
    try {
      item = await getWorkItem(id);
    } catch (e) {
      if (e instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: e.message }, { status: 503 });
      }
      throw e;
    }

    if (!item) {
      return NextResponse.json(
        { error: `Work item not found: ${id}` },
        { status: 404 }
      );
    }

    ctx.log.info({ workItemId: id }, "work.items.get_success");

    return NextResponse.json(workItemsGetOperation.output.parse(item));
  }
);

/**
 * PATCH /api/v1/work/items/:id — Patch a work item (Doltgres only).
 *
 * The immutable authenticated principal must match the creator stamped when
 * the row was inserted. The path id remains authoritative over request data.
 */
export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.patch", auth: { mode: "required", getSessionUser } },
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

    const parseResult = workItemsPatchOperation.input.safeParse({
      ...(typeof body === "object" && body !== null ? body : {}),
      id,
    });
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parseResult.error.issues },
        { status: 400 }
      );
    }

    try {
      const patched = await patchWorkItem(parseResult.data, {
        id: sessionUser.id,
        walletAddress: sessionUser.walletAddress,
      });
      ctx.log.info({ workItemId: id }, "work.items.patch_success");
      return NextResponse.json(workItemsPatchOperation.output.parse(patched));
    } catch (e) {
      if (e instanceof WorkItemScoresInvalidError) {
        return NextResponse.json(
          { error: "invalid input", errorCode: e.code, issues: e.issues },
          { status: 400 }
        );
      }
      if (e instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: e.message }, { status: 404 });
      }
      if (e instanceof WorkItemForbiddenError) {
        return NextResponse.json({ error: e.message }, { status: 403 });
      }
      if (e instanceof WorkItemRevisionConflictError) {
        return NextResponse.json(
          {
            error: "revision_conflict",
            expectedRevision: e.expectedRevision,
            currentRevision: e.currentRevision,
          },
          { status: 409 }
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
          { status: 409 }
        );
      }
      if (e instanceof NodeAdminRequiredError) {
        return NextResponse.json(
          { error: e.message, errorCode: e.errorCode, action: e.action },
          { status: e.status }
        );
      }
      if (e instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: e.message }, { status: 503 });
      }
      throw e;
    }
  }
);

/** Retired hard-delete: preserve versioned identity and provenance. */
export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.delete", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const parsed = workItemsDeleteOperation.input.safeParse({ id });
    if (!parsed.success)
      return NextResponse.json({ error: "invalid input" }, { status: 400 });
    return NextResponse.json(
      workItemsDeleteOperation.output.parse({
        error: "work_item_deletion_retired",
        message:
          "PATCH status=cancelled to preserve work-item identity and provenance",
      }),
      { status: 410 }
    );
  }
);
