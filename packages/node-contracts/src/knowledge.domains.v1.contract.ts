// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/knowledge.domains.v1.contract`
 * Purpose: HTTP contract for the knowledge domain registry — list, register, and the item-scoped read / update / delete-if-empty operations.
 * Scope: Zod schemas for the wire format. Does not contain business logic, I/O, or auth policy.
 * Invariants:
 *   - DOMAIN_HTTP_REQUIRES_PRINCIPAL (route enforces, contract does not): GET list
 *     and GET item accept any authenticated principal (DOMAIN_READ_REQUIRES_PRINCIPAL);
 *     POST register accepts bearer or session (DOMAIN_REGISTER_BEARER_OR_SESSION).
 *   - DOMAIN_MUTATION_BEARER_OR_SESSION (route enforces): PATCH and DELETE accept
 *     any authenticated principal, exactly like POST register. No extra authority.
 *   - DOMAIN_ID_IS_IMMUTABLE: the update input has no `id` change; rename is `name` only.
 *   - DOMAIN_DELETE_REFUSES_NONEMPTY: delete returns 409 `domain_not_empty`; never cascades.
 *   - DOMAIN_BASELINE_IS_PROTECTED: delete of a baseline domain (meta, mission, strategy) returns 409 `domain_protected`.
 *   - DOMAIN_ERRORS_ARE_TYPED: domain errors and shared middleware/wrapper error bodies parse as `DomainsErrorResponseSchema`.
 *   - CONTRACTS_ARE_TRUTH: every type here is `z.infer`; tools that surface a domain derive from `DomainSchema`.
 *   - id is short, slug-shaped (alnum, dash, underscore).
 * Side-effects: none
 * Links: hub `cogni-domain-taxonomy`, hub design `knowledge-domain-crud-design`
 * @internal
 */

import { z } from "zod";

export const DomainIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "domain id must start with [a-z0-9] and contain only [a-z0-9_-]",
  });

export const DomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  confidencePct: z.number().int(),
  entryCount: z.number().int(),
  createdAt: z.string(),
});
export type DomainRow = z.infer<typeof DomainSchema>;

export const DomainsListResponseSchema = z.object({
  domains: z.array(DomainSchema),
});
export type DomainsListResponse = z.infer<typeof DomainsListResponseSchema>;

export const DomainsCreateRequestSchema = z.object({
  id: DomainIdSchema,
  name: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
});
export type DomainsCreateRequest = z.infer<typeof DomainsCreateRequestSchema>;

export const DomainsCreateResponseSchema = DomainSchema;
export type DomainsCreateResponse = z.infer<typeof DomainsCreateResponseSchema>;

// ---------------------------------------------------------------------------
// Item-scoped operations: GET / PATCH / DELETE /api/v1/knowledge/domains/{domain}
// ---------------------------------------------------------------------------

/**
 * Every `errorCode` an item-scoped domain handler can emit. Handlers build
 * their error bodies through `DomainsErrorResponseSchema`, so a code not listed
 * here cannot reach the wire. The write-failure codes mirror the typed
 * knowledge-store errors (`KnowledgeWriteOutcomeUnknownError`,
 * `KnowledgeWriteScopeRequiredError`, `KnowledgeWriteConflictError`,
 * `KnowledgeBusyError`).
 */
export const DomainsErrorCodeSchema = z.enum([
  "unauthorized",
  "invalid_json",
  "invalid_input",
  "domain_not_found",
  "domain_not_empty",
  "domain_protected",
  "store_not_configured",
  "knowledge_write_outcome_unknown",
  "knowledge_write_scope_required",
  "knowledge_write_conflict",
  "knowledge_busy",
]);
export type DomainsErrorCode = z.infer<typeof DomainsErrorCodeSchema>;

const DomainHandlerErrorResponseSchema = z.object({
  error: z.string(),
  errorCode: DomainsErrorCodeSchema,
  retryable: z.boolean().optional(),
  /** `domain_not_empty`: how many entries still use the domain. */
  entryCount: z.number().int().optional(),
  /** `invalid_input`: zod issues. */
  issues: z.array(z.unknown()).optional(),
  /** `knowledge_write_outcome_unknown`: the write receipt. Inspect; never replay. */
  operationId: z.string().optional(),
  branch: z.string().optional(),
  commitHash: z.string().nullable().optional(),
  /** `knowledge_write_conflict`: the conflicting entry. */
  entryId: z.string().optional(),
});
/**
 * Shared perimeter responses: proxy Unauthorized, wrapper Session required,
 * bootstrap 503, and production-converted 500. Keep these exact wire shapes;
 * domain handler errors still require errorCode. Runtime/auth policy is unchanged.
 */
export const DomainsErrorResponseSchema = z.union([
  DomainHandlerErrorResponseSchema,
  z.strictObject({ error: z.enum(["Unauthorized", "Session required"]) }),
  z.strictObject({
    status: z.literal("error"),
    reason: z.literal("CONTAINER_INIT_FAILED"),
    message: z.string(),
  }),
  z.strictObject({ error: z.literal("Internal server error") }),
]);
export type DomainsErrorResponse = z.infer<typeof DomainsErrorResponseSchema>;

export const domainsGetOperation = {
  id: "knowledge.domains.get.v1",
  summary: "Get one knowledge domain",
  description:
    "Returns one registered domain with its entry count, or 404 domain_not_found. Any authenticated principal.",
  input: z.object({ domain: DomainIdSchema }),
  output: DomainSchema,
} as const;
export type DomainsGetInput = z.infer<typeof domainsGetOperation.input>;
export type DomainsGetOutput = z.infer<typeof domainsGetOperation.output>;

/** Wire body of PATCH: a strict partial. `description: null` clears it. */
export const DomainsUpdateBodySchema = z
  .strictObject({
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(512).nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined, {
    message: "patch must set at least one of: name, description",
  });
export type DomainsUpdateBody = z.infer<typeof DomainsUpdateBodySchema>;

export const domainsUpdateOperation = {
  id: "knowledge.domains.update.v1",
  summary: "Update a domain's name or description",
  description:
    "Partial update. `id` never changes. Any authenticated principal, like register. One Dolt commit per change.",
  // `domain` comes from the path and is the only id; the strict body cannot carry one.
  input: z.object({ domain: DomainIdSchema, body: DomainsUpdateBodySchema }),
  output: DomainSchema,
} as const;
export type DomainsUpdateInput = z.infer<typeof domainsUpdateOperation.input>;
export type DomainsUpdateOutput = z.infer<typeof domainsUpdateOperation.output>;

export const DomainsDeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});

export const domainsDeleteOperation = {
  id: "knowledge.domains.delete.v1",
  summary: "Delete an empty domain",
  description:
    "Removes a domain that has zero entries. A non-empty domain returns 409 domain_not_empty and a baseline domain returns 409 domain_protected; nothing changes. Any authenticated principal, like register.",
  input: z.object({ domain: DomainIdSchema }),
  output: DomainsDeleteResponseSchema,
} as const;
export type DomainsDeleteInput = z.infer<typeof domainsDeleteOperation.input>;
export type DomainsDeleteOutput = z.infer<typeof domainsDeleteOperation.output>;
