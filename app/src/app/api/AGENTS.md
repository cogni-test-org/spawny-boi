# api · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-10-02
- **Status:** draft

## Purpose

HTTP API endpoints using Next.js App Router. Contract-validated entry points that delegate to feature services.

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [Feature Development Guide](../../../../../docs/guides/feature-development.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "contracts", "shared"],
  "must_not_import": [
    "adapters/server",
    "adapters/worker",
    "core",
    "ports",
    "components"
  ]
}
```

## Public Surface

- **Exports:** none
- **Routes (if any):**
  - `/api/auth/[...nextauth]` [GET, POST]
  - `/api/setup/verify` [POST] - DAO formation verification
  - `/api/internal/billing/ingest` [POST] - LiteLLM generic_api callback receiver (bearer auth, Docker-internal only)
  - `/api/internal/ops/governance/schedules/sync` [POST] - deploy-time governance sync trigger (bearer auth)
  - `/api/v1/chat/completions` [POST] - OpenAI-compatible chat completions (streaming + non-streaming, `cogni_status` extension); see [completions spec](../../../docs/spec/completions-api.md)
  - `/api/v1/ai/chat` [POST] - streaming chat with server-authoritative thread persistence
  - `/api/v1/activity` [GET]
  - `/api/v1/identity/bindings/import/start` [POST] - mint a session-owned nonce and return the pinned operator broker URL
  - `/api/v1/identity/bindings/import` [POST] - verify and consume an operator identity attestation into this node's binding ledger
  - `/api/v1/public/attribution/epochs` [GET] - closed epochs list (public, no auth)
  - `/api/v1/public/attribution/epochs/[id]/user-projections` [GET] - closed epoch user projections (public)
  - `/api/v1/public/attribution/epochs/[id]/claimants` [GET] - closed epoch claimant attribution (public)
  - `/api/v1/public/attribution/epochs/[id]/statement` [GET] - epoch statement (public)
  - `/api/v1/attribution/epochs` [GET] - all epochs (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/activity` [GET] - epoch activity events (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/claimants` [GET] - claimant-aware finalized attribution (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/user-projections` [GET, PATCH=410] - read per-user unsigned projections; edits are deprecated
  - `/api/v1/attribution/epochs/[id]/review-subject-overrides` [GET, PATCH, DELETE] - review-time subject overrides (SIWE + approver)
  - `/api/v1/attribution/settlement-lifecycle` [GET] - settlement and chain-proven publication lifecycle (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/pool-components` [POST] - record pool component (SIWE + approver)
  - `/api/v1/users/me` [GET, PATCH] - current profile
  - `/api/v1/users/me/ownership` [GET] - current ownership summary derived from linked identities
  - `/api/v1/work/items` [GET, POST] - list or create node-local Dolt work items (SIWE or agent bearer auth)
  - `/api/v1/work/items/[id]` [GET, PATCH, DELETE] - read/update a node-local Dolt work item; DELETE returns 410 (use status=cancelled) (SIWE or agent bearer auth)
  - `/api/v1/work/items/[id]/claims` [POST, DELETE] - acquire or release an authenticated principal+run lease
  - `/api/v1/work/items/[id]/heartbeat` [POST] - refresh an authenticated principal+run lease
  - `/api/v1/work/items/[id]/coordination` [GET] - read lease and next-action coordination state
  - `/api/v1/knowledge/index` [GET] - content-free retrieval-trigger projection with optional `useWhen` substring filter
  - `/api/v1/agent/register` [POST] - unauthenticated machine actor registration (returns Bearer API key)
  - `/api/v1/agent/runs` [GET] - machine-authenticated run list
  - `/api/v1/agent/runs/[runId]/stream` [GET] - machine-authenticated run stream SSE
  - `/api/v1/ai/runs/[runId]/ui-stream` [GET] - session-authenticated AI SDK chat replay stream
- **Files considered API:** v1/_/route.ts, admin/_/route.ts

## Responsibilities

- This directory **does**: validate HTTP requests/responses with contracts; delegate to features
- This directory **does not**: contain business logic, direct port usage, or data transformations

## Usage

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Standards

- All routes must validate with contract schemas
- Parse input before processing, parse output before responding
- Use NextResponse for consistent HTTP responses

## Dependencies

- **Internal:** contracts (for validation), shared (for types)
- **External:** next (NextResponse)

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date
- Ensure contract tests pass

## Notes

- v1 API prefix for versioned product routes
