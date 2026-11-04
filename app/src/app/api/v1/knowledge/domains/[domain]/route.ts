// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/[domain]/route`
 * Purpose: HTTP endpoints for one knowledge domain — GET read, PATCH name/description, DELETE if empty.
 * Scope: All verbs accept any authenticated principal (cookie-session human OR bearer agent), the same auth as POST /domains. Does not contain business logic; delegates to ../_handlers.ts and the container's KnowledgeStorePort.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, DOMAIN_READ_REQUIRES_PRINCIPAL,
 *   DOMAIN_MUTATION_BEARER_OR_SESSION, DOMAIN_ID_IS_IMMUTABLE, DOMAIN_DELETE_REFUSES_NONEMPTY.
 *   PUT is not supported (405): PATCH is the partial update.
 * Side-effects: IO (HTTP response, Doltgres read/write via container port; one Dolt commit per mutation)
 * Links: contracts/knowledge.domains.v1.contract, hub `knowledge-domain-crud-design`
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleDelete, handleGet, handleUpdate } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DomainRouteContext = { params: Promise<{ domain: string }> };

export const GET = wrapRouteHandlerWithLogging<DomainRouteContext>(
  {
    routeId: "knowledge.domains.get",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { domain } = await context.params;
    return handleGet(domain, sessionUser);
  }
);

export const PATCH = wrapRouteHandlerWithLogging<DomainRouteContext>(
  {
    routeId: "knowledge.domains.update",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { domain } = await context.params;
    return handleUpdate(request, domain, sessionUser, ctx.log);
  }
);

export const DELETE = wrapRouteHandlerWithLogging<DomainRouteContext>(
  {
    routeId: "knowledge.domains.delete",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { domain } = await context.params;
    return handleDelete(domain, sessionUser, ctx.log);
  }
);
