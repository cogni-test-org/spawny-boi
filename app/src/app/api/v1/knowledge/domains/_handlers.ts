// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/_handlers`
 * Purpose: HTTP handlers for the knowledge domain registry — list, register, and the item-scoped get / update / delete-if-empty, mapping typed errors to HTTP statuses.
 * Scope: Operator-side wiring only. Does not contain business logic, validation, or storage I/O — those live in the port/adapter.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, DOMAIN_LIST_REQUIRES_PRINCIPAL
 *   (any authenticated principal — session human or bearer agent — may list
 *   domains, mirroring KNOWLEDGE_READ_REQUIRES_PRINCIPAL on /knowledge),
 *   DOMAIN_REGISTER_BEARER_OR_SESSION (federation: external bearer agents may
 *   register a domain on-demand so that downstream writes — knowledge
 *   contributions, EDO hypothesize/decide/record-outcome — can proceed against
 *   the DOMAIN_FK_ENFORCED_AT_WRITE adapter invariant without requiring a UI
 *   roundtrip), DOMAIN_READ_REQUIRES_PRINCIPAL (item GET mirrors list),
 *   DOMAIN_MUTATION_BEARER_OR_SESSION (item PATCH/DELETE use the same auth as
 *   POST register: any authenticated principal, no extra authority; restrictions
 *   can be added later),
 *   DOMAIN_ID_IS_IMMUTABLE, DOMAIN_DELETE_REFUSES_NONEMPTY (409, never cascade).
 * Side-effects: IO (HTTP response, Doltgres read/write via container port)
 * Links: docs/spec/knowledge-domain-registry.md, docs/spec/knowledge-syntropy.md
 * @internal
 */

import {
  DomainAlreadyRegisteredError,
  DomainNotEmptyError,
  DomainNotRegisteredError,
  KnowledgeBusyError,
  KnowledgeWriteConflictError,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeWriteScopeRequiredError,
} from "@cogni/knowledge-store";
import { BASE_DOMAIN_SEEDS } from "@cogni/knowledge-base";
import {
  DomainsCreateRequestSchema,
  DomainsCreateResponseSchema,
  type DomainsErrorResponse,
  DomainsErrorResponseSchema,
  domainsDeleteOperation,
  domainsGetOperation,
  domainsUpdateOperation,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import { loadDomains } from "@/app/(app)/knowledge/_server/loaders";
import { getContainer } from "@/bootstrap/container";
import type { RequestContext } from "@/shared/observability";

function port() {
  return getContainer().knowledgeStorePort ?? null;
}

export async function handleList(
  _request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Any authenticated principal may list domains (DOMAIN_LIST_REQUIRES_PRINCIPAL).
  // Bearer agents need the registry to recall + target writes, mirroring
  // KNOWLEDGE_READ_REQUIRES_PRINCIPAL on /knowledge.
  const p = port();
  if (!p)
    return NextResponse.json(
      { error: "knowledge store not configured" },
      { status: 503 }
    );
  return NextResponse.json(await loadDomains(p));
}

export async function handleCreate(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Bearer agents may register a domain on-demand to satisfy
  // DOMAIN_FK_ENFORCED_AT_WRITE before downstream writes
  // (knowledge contributions + EDO hypothesize/decide/record-outcome).
  const p = port();
  if (!p)
    return NextResponse.json(
      { error: "knowledge store not configured" },
      { status: 503 }
    );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = DomainsCreateRequestSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  try {
    const domain = await p.registerDomain({
      id: parsed.data.id,
      name: parsed.data.name,
      ...(parsed.data.description != null
        ? { description: parsed.data.description }
        : {}),
    });
    return NextResponse.json(DomainsCreateResponseSchema.parse(domain), {
      status: 201,
    });
  } catch (e: unknown) {
    if (e instanceof DomainAlreadyRegisteredError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    // POST keeps its published busy body byte for byte (no errorCode); only
    // the item routes carry the typed `knowledge_busy` code.
    if (e instanceof KnowledgeBusyError)
      return NextResponse.json(
        { error: e.message, retryable: true },
        { status: 503, headers: { "Retry-After": "2" } }
      );
    return mapDomainWriteError(e);
  }
}

/**
 * Typed knowledge-write failures shared by every domain mutation. Returns the
 * HTTP response for a known write failure, or rethrows an unknown error so the
 * route wrapper reports it as a 500.
 */
function mapDomainWriteError(e: unknown): NextResponse {
  if (e instanceof KnowledgeWriteOutcomeUnknownError)
    return domainError(409, {
      error: e.message,
      errorCode: "knowledge_write_outcome_unknown",
      retryable: false,
      operationId: e.operationId,
      branch: e.branch,
      commitHash: e.commitHash ?? null,
    });
  if (e instanceof KnowledgeWriteScopeRequiredError)
    return domainError(500, {
      error: e.message,
      errorCode: "knowledge_write_scope_required",
      retryable: false,
    });
  if (e instanceof KnowledgeWriteConflictError)
    return domainError(409, {
      error: e.message,
      errorCode: "knowledge_write_conflict",
      retryable: false,
      entryId: e.entryId,
    });
  if (e instanceof KnowledgeBusyError)
    return NextResponse.json(
      DomainsErrorResponseSchema.parse({
        error: e.message,
        errorCode: "knowledge_busy",
        retryable: true,
      }),
      { status: 503, headers: { "Retry-After": "2" } }
    );
  throw e;
}

type DomainLog = Pick<RequestContext["log"], "info">;

/** A typed, contract-checked error body (DOMAIN_ERRORS_ARE_TYPED). */
function domainError(
  status: number,
  body: DomainsErrorResponse
): NextResponse {
  return NextResponse.json(DomainsErrorResponseSchema.parse(body), { status });
}

function notFound(id: string): NextResponse {
  return domainError(404, {
    error: `domain '${id}' not registered`,
    errorCode: "domain_not_found",
  });
}

function badDomainId(issues: unknown[]): NextResponse {
  return domainError(400, {
    error: "invalid domain id",
    errorCode: "invalid_input",
    issues,
  });
}

export async function handleGet(
  domainId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return domainError(401, {
      error: "unauthorized",
      errorCode: "unauthorized",
    });
  // DOMAIN_READ_REQUIRES_PRINCIPAL: any authenticated principal, like the list.
  const p = port();
  if (!p)
    return domainError(503, {
      error: "knowledge store not configured",
      errorCode: "store_not_configured",
    });
  const input = domainsGetOperation.input.safeParse({ domain: domainId });
  if (!input.success) return badDomainId(input.error.issues);
  const domain = await p.getDomain(input.data.domain);
  if (!domain) return notFound(input.data.domain);
  return NextResponse.json(domainsGetOperation.output.parse(domain));
}

export async function handleUpdate(
  request: Request,
  domainId: string,
  sessionUser: SessionUser | null,
  log: DomainLog
): Promise<NextResponse> {
  if (!sessionUser)
    return domainError(401, {
      error: "unauthorized",
      errorCode: "unauthorized",
    });
  const p = port();
  if (!p)
    return domainError(503, {
      error: "knowledge store not configured",
      errorCode: "store_not_configured",
    });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return domainError(400, {
      error: "invalid JSON body",
      errorCode: "invalid_json",
    });
  }
  const input = domainsUpdateOperation.input.safeParse({
    domain: domainId,
    body,
  });
  if (!input.success)
    return domainError(400, {
      error: "invalid input",
      errorCode: "invalid_input",
      issues: input.error.issues,
    });

  const { domain, body: patch } = input.data;
  try {
    const updated = await p.updateDomain(domain, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
    });
    log.info(
      {
        domainId: domain,
        userId: sessionUser.id,
        changedFields: Object.keys(patch),
      },
      "knowledge.domains.update_success"
    );
    return NextResponse.json(domainsUpdateOperation.output.parse(updated));
  } catch (e: unknown) {
    if (e instanceof DomainNotRegisteredError) return notFound(domain);
    return mapDomainWriteError(e);
  }
}

export async function handleDelete(
  domainId: string,
  sessionUser: SessionUser | null,
  log: DomainLog
): Promise<NextResponse> {
  if (!sessionUser)
    return domainError(401, {
      error: "unauthorized",
      errorCode: "unauthorized",
    });
  const p = port();
  if (!p)
    return domainError(503, {
      error: "knowledge store not configured",
      errorCode: "store_not_configured",
    });
  const input = domainsDeleteOperation.input.safeParse({ domain: domainId });
  if (!input.success) return badDomainId(input.error.issues);

  const { domain } = input.data;
  // DOMAIN_BASELINE_IS_PROTECTED: every node inherits these shelves; seeding
  // and orientation writes depend on them (DOMAIN_FK_ENFORCED_AT_WRITE).
  if (BASE_DOMAIN_SEEDS.some((seed) => seed.id === domain))
    return domainError(409, {
      error: `domain '${domain}' is a baseline domain and cannot be deleted`,
      errorCode: "domain_protected",
    });
  try {
    await p.deleteDomain(domain);
    log.info(
      { domainId: domain, userId: sessionUser.id },
      "knowledge.domains.delete_success"
    );
    return NextResponse.json(
      domainsDeleteOperation.output.parse({ id: domain, deleted: true })
    );
  } catch (e: unknown) {
    if (e instanceof DomainNotRegisteredError) return notFound(domain);
    if (e instanceof DomainNotEmptyError)
      return domainError(409, {
        error: e.message,
        errorCode: "domain_not_empty",
        entryCount: e.entryCount,
      });
    return mapDomainWriteError(e);
  }
}
