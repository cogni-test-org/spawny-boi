# node-contracts · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Shared Zod route contracts and HTTP router definitions for all node apps. PURE_LIBRARY — no env vars, no process lifecycle, no framework deps. Contains operation contracts (Zod input/output schemas), ts-rest HTTP router, and OpenAPI generation.

## Pointers

- [Packages Architecture](../../docs/spec/packages-architecture.md)
- [Architecture — Contracts Layer](../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

## Public Surface

All contract files re-exported via `src/index.ts`. Selective re-export for `ai.chat.v1.contract` to avoid `ChatMessage` name collision with `ai.completions.v1.contract`.

- `work.items.list.v1.contract` — optional sortBy/sortDirection use work-items canonical allowlists; rankMin/rankMax are inclusive; projectIds is any-of; DTO exposes derived read-only rankScore
- `work.items.{list,create,patch}.v1.contract` — evaluation scores outline (`scores.<axis>.v/ev`); shared work-items adapter validates bounds, PATCH null clears scores
- `identity.attestation.v1.contract` — frozen operator↔node identity protocol, canonical HTTPS-origin schema, and cross-repository protocol fingerprint

**Schedule contracts:** create/update/list/history files reexport the published scheduling package. Owned detail and paginated metadata retain nullable thread correlation and existing wire shapes.

**Attribution lifecycle contracts:**

- `attribution.settlement-lifecycle.v1.contract` — authenticated read of live/latest settlement revisions and per-epoch publication coverage

**Internal scheduler-worker → node-app contracts (task.0280):**

- `graphs.run.internal.v1.contract` — `POST /api/internal/graphs/{graphId}/runs` (executeGraphActivity)
- `graph-runs.create.internal.v1.contract` — `POST /api/internal/graph-runs` (createGraphRunActivity)
- `graph-runs.update.internal.v1.contract` — `PATCH /api/internal/graph-runs/{runId}` (updateGraphRunActivity)
- `grants.validate.internal.v1.contract` — `POST /api/internal/grants/{grantId}/validate` (validateGrantActivity)

All require `Authorization: Bearer ${SCHEDULER_API_TOKEN}`.

**Poly contracts moved out (task.0421):** the 13 `poly.*.v1.contract.ts` files now live in `@cogni/poly-node-contracts` (`nodes/poly/packages/node-contracts/`). This package exports cross-node shapes only.

## Responsibilities

- This directory **does**: Define Zod schemas for API request/response shapes, HTTP router contracts, OpenAPI specs
- This directory **does not**: Make I/O calls, read env vars, contain business logic, define ports or adapters

## Dependencies

- **Internal:** `@cogni/ai-core`, `@cogni/aragon-osx`, `@cogni/node-core`, `@cogni/scheduling` (published readback/contracts alias), `@cogni/work-items` (sort allowlists).
- **External:** `zod`, `@ts-rest/core`

## Notes

- Extracted from `apps/operator/src/contracts/` (task.0248 Phase 1)
- `ChatMessage` exported from `ai.completions.v1.contract` (OpenAI-compatible format); chat contract's `ChatMessage` excluded from barrel to avoid TS2308
