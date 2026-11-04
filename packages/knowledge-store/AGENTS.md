# knowledge-store · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Shared ports, contribution workflow, and adapters for versioned domain knowledge backed by Doltgres. Generic schema lives in `@cogni/knowledge-base`; each node may add companion tables and niche seeds.

## Pointers

- [Spec](../../docs/spec/knowledge-data-plane.md) — authoritative design
- [task.0231](../../work/items/task.0231.knowledge-data-plane.md) — port + adapter
- [task.0311](../../work/items/task.0311.poly-knowledge-syntropy-seed.md) — candidate-a wiring, clean-slate seeds, Doltgres 0.56 RBAC workaround
- [Design doc](../../docs/design/knowledge-data-plane-prototype.md) — spike results + agent tooling roadmap
- [proj.poly-prediction-bot](../../work/projects/proj.poly-prediction-bot.md) — parent project

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

**External deps:** `@cogni-dao/doltgres-admission` (bundled engine protocol), `zod` (schema validation), `postgres` (Doltgres wire protocol — adapter subpath only).

## Public Surface

**Root barrel** (`@cogni/knowledge-store`):

- Read serialization: `toKnowledgeRow` — canonical wire fields with Date/null/default normalization
- Types: `KnowledgeStorePort`, `KnowledgeWriteSession` (closed callback scope), `Knowledge`, `NewKnowledge`, `DoltCommit`, `DoltDiffEntry`, `SourceType`
- Schemas: `KnowledgeSchema`, `NewKnowledgeSchema`, `DoltCommitSchema`, `DoltDiffEntrySchema`, `SourceTypeSchema`
- Goal layer (story.5101): `KnowledgeStorePort.listActiveGoals()` (required port method, NO_GOAL_CAP), `ActiveGoal`, `GOAL_ENTRY_TYPE`, `GOAL_ID_PREFIX`, `GOAL_RETIRING_EDGE`, `isGoalRowId`, `selectActiveGoals`, `resolveGoals`, `renderGoalsLines`, `GOALS_BOOTSTRAP_INSTRUCTION`, `GoalsSection`, `GoalRequiresContributionError` (direct writes never touch goals), `createKnowledgeCapability(...).listActiveGoals` (for `core__goal_list`)
- Governing discovery: `listGoverningIndex()`, `GOVERNING_ENTRY_TYPES`, `isGoverningEntryType`, `selectGoverningIndex`, `GoverningIndexRow` — content-free, uncapped, nonblank triggers, no superseded targets. Doltgres and fake adapters use this same selector.
- Node-admin seam: `NodeAdminAuthority`, `NodeAdminActor`, `NodeAdminDecision`, `checkNodeAdmin`, `isPrivilegedPriority` (priority <= 1), `NodeAdminRequiredError`, `touchesGoalLayer`, `TouchedCitation`

**Pure subpath** (`@cogni/knowledge-store/contracts`):

- Canonical `KnowledgeRowSchema` / `KnowledgeRow`, knowledge and EDO capability contracts, parameters and results. No adapters or capability implementations.

**Subpath** (`@cogni/knowledge-store/adapters/doltgres`):

- `DoltgresKnowledgeStoreAdapter` (`withWrite` required for mutations), `DoltgresAdapterConfig` (injected shared writer session), `buildDoltgresClient`, `DoltgresClientConfig`
- `DomainSql`, `getDoltgresDomain`, `updateDoltgresDomain`, `deleteDoltgresDomain`: domain SQL operations for caller-owned query callbacks; mutations require the caller's existing admitted write scope and do not admit or commit.
- `DoltgresKnowledgeContributionAdapter`, `DoltgresKnowledgeContributionAdapterConfig` (contribution-branch lifecycle)
- `createDoltgresPusher`, `DoltgresPusher`, `DoltgresPushConfig` (post-merge mirror to a Dolt remote; lazy `dolt_remote add` + `dolt_push`)
- `wrapPushSafe`, `PushOutcomeListener` (fire-and-forget wrapper with injectable success/failure callbacks — keeps logging out of the adapter)

**Subpath** (`@cogni-dao/knowledge-store/migrations`):

- `createDoltgresMigrationRunner`, `isDoltgresMigrationOutcomeUncertain`: bounded owned-session execution for the node-owned migrator; bundles the private engine with its guard. Journals, DDL, schema checks, identity and process lifecycle stay node-owned.

**Service** (`@cogni/knowledge-store/service/contribution-service`):

- `createContributionService`, `ContributionService`, `ContributionServiceDeps`
- `ContributionServiceDeps.pushMainOnMerge?: () => Promise<void>` — optional post-merge mirror hook; caller owns error handling (service does not await + does not catch)
- `ContributionServiceDeps.nodeAdmin?: NodeAdminAuthority` — goal-layer merge gate (raw diff ids via the required port method `KnowledgeContributionPort.touchedIds`, merge pinned with `expectedHeadCommit`); absent ⇒ goal-layer merges fail closed 503

## Ports

- **Implements:** `KnowledgeStorePort`
- **Uses:** none

## Responsibilities

- This directory **does**: define port interface, Zod domain schemas, Doltgres adapter (CRUD + commit/log/diff), connection factory with Doltgres-compatible settings.
- This directory **does not**: define schema (node packages own that), load env vars, own database provisioning or process lifecycle. Shared engine admission/branch mutation is delegated to `@cogni-dao/doltgres-admission`.

## Notes

- **postgres.js parameterized queries don't work on Doltgres** — adapter uses `sql.unsafe()` + `escapeValue()` for all queries.
- **`ON CONFLICT ... EXCLUDED` unsupported** — `upsertKnowledge` uses try-INSERT / catch-duplicate / fallback-UPDATE.
- **JSONB `@>` and ILIKE not supported** — fallbacks: `CAST(tags AS TEXT) LIKE` and `LOWER(col) LIKE`.
- **Doltgres 0.56 RBAC is non-functional** — GRANT reports success but roles can't even `SELECT current_user`. Runtime `DOLTGRES_URL_*` must connect as `postgres` superuser until upstream lands working role access.
- **`fetch_types: false` required** on all postgres.js connections (pg_type grants missing).
- Schema lives in node packages (`nodes/{node}/packages/doltgres-schema/`) because nodes may add companion tables and fork takes schema with it.
- `core__knowledge_search` / `core__knowledge_read` / `core__knowledge_write` BoundTools shipped in `@cogni/ai-tools`; brain graph uses them via tool runtime.

Contribution adapters require an explicit independent `writerSession` or `branchSql`; no write path falls back to its read client. The existing session runner registers each reader and rejects both initial and replacement writer aliases before SQL; rejected replacement factories never destroy a reader. Pure read-only store construction remains supported.
