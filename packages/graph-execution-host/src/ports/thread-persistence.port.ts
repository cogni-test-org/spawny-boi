// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/ports/thread-persistence`
 * Purpose: Minimal thread-persistence surface the durable-terminal policy needs.
 * Scope: Structural port plus the injected app functions it cannot own. Declares no adapter.
 * Invariants:
 *   - PURE_LIBRARY: no env vars, no process lifecycle, no `@/` imports
 *   - Structural by design: a node's richer ThreadPersistencePort satisfies this without a cast
 * Side-effects: none
 * Links: docs/spec/packages-architecture.md
 * @public
 */

/** One persisted chat message, narrowed to what durability needs. */
export interface PersistedThreadMessage {
  readonly id: string;
}

/**
 * The two thread operations the durable-terminal policy performs.
 * `saveThread` takes the loaded length as an optimistic-concurrency guard; a
 * concurrent writer makes it reject, which the policy retries.
 */
export interface ThreadPersistenceLike<TMessage extends PersistedThreadMessage> {
  loadThread(actorUserId: string, stateKey: string): Promise<TMessage[]>;
  saveThread(
    actorUserId: string,
    stateKey: string,
    messages: TMessage[],
    expectedLength: number
  ): Promise<void>;
}

/**
 * Assembles the assistant message from a run's accumulated events, or null when
 * the run produced no `assistant_final`. Owned by the node: it knows its own
 * event shapes and message model.
 */
export type AssembleAssistantMessageFn<TEvent, TMessage> = (
  runId: string,
  events: readonly TEvent[]
) => TMessage | null;

/** Redacts secrets before a transcript is written. Owned by the node. */
export type RedactMessagesFn<TMessage> = (messages: TMessage[]) => TMessage[];

/**
 * True when the error is the node's thread write-conflict error. Injected as a
 * predicate rather than a class so the package never imports app error types —
 * the same idiom as the grant and credit error guards.
 */
export type IsThreadConflictErrorFn = (error: unknown) => boolean;
