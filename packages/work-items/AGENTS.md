# work-items · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-02

## Purpose

Work item port interfaces, domain types, and storage adapters for structured work item management. Root entry (`@cogni/work-items`) exports types/interfaces and database-neutral content/lease composition. Adapter entries expose the legacy markdown implementation and the shared Doltgres implementation used by every node-owned work-item store.

## Pointers

- [Development Lifecycle](../../docs/spec/development-lifecycle.md): Status enum and transition rules
- [Identity Model](../../docs/spec/identity-model.md): Actor kinds for SubjectRef alignment
- [Packages Architecture](../../docs/spec/packages-architecture.md): Package conventions

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

**External deps:** `zod` (canonical wire schema), `type-fest` (Tagged branded types), `yaml` (frontmatter parsing — adapter only). Doltgres adapter alone bundles `@cogni-dao/doltgres-admission` for the shared engine writer protocol; root/content/lease ports stay database-neutral.

## Public Surface

- **Exports (root `@cogni/work-items`):**
  - `WorkItemId`, `Revision`, `WorkItemType`, `WorkItemStatus`, `ActorKind` — identity and enum types
  - `SubjectRef`, `ExternalRef`, `RelationType`, `WorkRelation` — structured domain types
  - `toWorkItemDto` — spread-first read serializer with actor omission and derived rank
  - `WorkItem`, `WorkQuery` — full work item type and query filter; rank bounds are inclusive and exclude unknown rank when set; projectIds is any-of
  - `WORK_ITEM_SORT_FIELDS`, `WORK_ITEM_SORT_DIRECTIONS`, `normalizeWorkItemOrder`, `compareWorkItems` — canonical ordering; default rankScore DESC, unknown last, id ASC
  - `WorkItemSortBy`, `WorkItemSortDirection`, `WorkItemOrder` — shared order types
  - `toWorkItemId(raw: string): WorkItemId` — boundary constructor
  - `WorkItemQueryPort`, `WorkItemCommandPort` — read/write interfaces
  - `VALID_TRANSITIONS`, `isValidTransition(from, to): boolean` — transition table
  - `WorkItemScore(s)`, `parseWorkItemScores(input)`, `rankScore(scores)`, `WorkItemScoresInvalidError` — the only `scores` bounds and WSJF rank (story.5111); every write path calls the parser, nobody re-states the rules
- **Exports (adapter `@cogni/work-items/markdown`):**
  - `MarkdownWorkItemAdapter` — implements QueryPort + CommandPort against markdown files
  - `StaleRevisionError` — thrown on optimistic concurrency conflict
  - `InvalidTransitionError` — thrown on invalid status transition
  - `UnsupportedWorkItemFieldError` — thrown when create/patch names `scores` (Doltgres-only); nothing is written
- **Exports (adapter `@cogni/work-items/adapters/doltgres`):**
  - `DoltgresWorkItemAdapter` — node-local content query/create/patch; hard delete fails with a typed retirement error
  - `WorkItemRevisionConflictError` — `patch` with a stale `expectedRevision`; nothing committed
  - `DoltgresWorkItemAdapterOptions` — per-store allocator configuration (`idFloor`) (create/patch reject invalid `scores` with `WorkItemScoresInvalidError` before any SQL)
  - cursor codec + Doltgres port/error types
- **Files considered API:** `src/index.ts`, `src/adapters/markdown/index.ts`, `src/adapters/doltgres/index.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** `WorkItemQueryPort`, `WorkItemCommandPort` (via MarkdownWorkItemAdapter and DoltgresWorkItemAdapter)

## Responsibilities

- This directory **does**: Define port interfaces, domain types, transition rules, and the markdown adapter
- This directory **does not**: Import from `@/` or `src/`, depend on app-layer or service code

## Usage

```bash
pnpm --filter @cogni/work-items typecheck
pnpm --filter @cogni/work-items build
pnpm vitest run packages/work-items/tests/
```

## Standards

- Root entry: no environment/pool/framework imports; orchestration delegates to injected ports.
- Adapter entries: I/O allowed, but no `@/` or app `src/` imports
- No `as WorkItemId` casts outside test fixtures — use `toWorkItemId()` at boundaries

## Dependencies

- **Internal:** none
- **External:** `type-fest` (Tagged branded types), `yaml` (YAML parse/stringify)

## Change Protocol

- Update this file when types, ports, or transition rules change
- Coordinate with development-lifecycle.md for status/transition changes
- Coordinate with identity-model.md for SubjectRef kind changes

## Notes

- `toWorkItemId()` does no format validation — WorkItemIds include both numeric (`task.0149`) and slug-based (`proj.agentic-project-management`) formats
- `MarkdownWorkItemAdapter` constructor takes `workDir` (repo root) — scans `work/items/` and `work/projects/`
- `blocked` can transition to any `needs_*` status — adapters may enforce stricter return-to-previous-status logic
- Dolt ID allocation is inside the common per-database writer scope; never move it before admission.

## Operational leases

Work-item leases live in PostgreSQL `work_item_leases`; shared package `@cogni-dao/work-items/adapters/postgres` owns atomic principal/run/token predicates. Heartbeat and release return lease-only data and never call Dolt. Runtime uses the service-role pool; RLS denies app-role SQL. Content get/list project this authority via `withWorkItemLeases`. Old Dolt lease columns are historical evidence, never current authority.

## Reader fault containment

A read has its own deadline and never enters writer admission. Reader timeout retires only the captured generation, gracefully drains siblings and permits at most one replacement; maximum two generations. Runtime factories must budget the overlap. Explicit `readConnectionBudget` fails closed on unknown or invalid public pool widths. The template uses max 1 per reader generation, at most two reader connections plus one writer. See [README](README.md) for cutover and fault proof limits.

- PATCH_CAS (task.5284): Doltgres `patch` with `expectedRevision` adds `AND revision = <expected>` to its UPDATE; a mismatch throws `WorkItemRevisionConflictError` and drops the empty op branch with no commit. Omitted = unconditioned, as before.
- COLLABORATOR_TRIAGE (task.5284): any non-blank principal may `patch` only `priority`, `rank`, `labels`, `scores` on items it did not create. A `set` naming any other field is creator-bound as a whole (`created_by_principal_id IS NULL OR = principal`); the patch transition proof admits a non-creator only when the row diff touches nothing beyond those columns + `revision`/`updated_at`.

- Query cursors bind version, normalized result filters and sort; decoder callers pass the identity from `queryIdentity`; unbound old versions require restart; old/order-mismatched cursors require restart. Native SQL owns exact cursor keys. Timestamp ordering, projection and seek use the engine's public microsecond precision; hidden NOW() nanoseconds do not survive native text I/O. Text uses bounded ordered batches sharing one read deadline.
