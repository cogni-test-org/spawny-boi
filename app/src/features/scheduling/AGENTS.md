# scheduling · AGENTS.md

> Scope: this directory only.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Node identity binding for the published scheduling package's owned configuration, run history and existing thread correlation.

## Boundaries

Features inject local branded-ID schedule lookup into shared readback. No bootstrap, adapter, or app imports.

## Public Surface

- `createScheduleHistoryService` — schedule and history reads
- `ScheduleHistoryNotFoundError` — missing or foreign schedule

## Invariants

- Schedule ownership is required independently of run requester identity.
- Metadata projects nullable stateKey without loading any thread content.
- Existing chat routes authorize and display linked conversations.
- Runtime status is not task success. No execution or persistence side effects.
