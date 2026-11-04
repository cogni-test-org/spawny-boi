// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/durable-chat-terminal`
 * Purpose: Enforce assistant transcript durability before exposing terminal chat success.
 * Scope: Idempotent bounded persistence followed by a caller-provided terminal publication.
 * Invariants:
 *   - TERMINAL_AFTER_PERSIST: a stateful successful run cannot publish terminal done before its transcript is durable; headless runs publish directly
 *   - PURE_LIBRARY: no env vars, no process lifecycle, no `@/` imports — every node-owned concern arrives as an injected function
 * Side-effects: thread persistence and terminal publication, both via injected callbacks
 * Links: docs/spec/packages-architecture.md, https://cognidao.org/knowledge/graph-execution-package-design
 * @public
 */

import type {
  AssembleAssistantMessageFn,
  IsThreadConflictErrorFn,
  PersistedThreadMessage,
  RedactMessagesFn,
  ThreadPersistenceLike,
} from "./ports/thread-persistence.port";

/**
 * Raised when the terminal publication itself fails after a durable persist.
 *
 * `cause` is attached with `defineProperty` rather than the two-argument `Error`
 * constructor: this package compiles standalone at `target: ES2020` with no
 * `lib` override, so `ErrorOptions` is not in scope here even though it is in
 * the app. The runtime shape is identical.
 */
export class TerminalPublicationError extends Error {
  constructor(cause: unknown) {
    super("Terminal stream publication failed");
    this.name = "TerminalPublicationError";
    Object.defineProperty(this, "cause", {
      value: cause,
      configurable: true,
      writable: true,
    });
  }
}

/** Outcome of the durability step. `persisted` is false for a headless run. */
export interface DurableChatTerminalResult {
  readonly persisted: boolean;
  readonly messageCount?: number;
  readonly attempt?: number;
}

export interface DurableChatTerminalInput<TEvent, TMessage extends PersistedThreadMessage> {
  readonly runId: string;
  /** Absent for a headless run, which skips persistence and publishes directly. */
  readonly stateKey?: string;
  readonly actorUserId?: string;
  readonly accumulatedEvents: readonly TEvent[];
  readonly threadPersistenceForUser: (
    actorUserId: string
  ) => ThreadPersistenceLike<TMessage>;
  readonly publishTerminal: () => Promise<void>;
  readonly onPersisted?: (result: {
    messageCount: number;
    attempt: number;
  }) => void;
  /** Optimistic-concurrency retry budget. Defaults to 3. */
  readonly maxAttempts?: number;
}

/** Node-owned collaborators the policy cannot own without importing app code. */
export interface DurableChatTerminalDeps<TEvent, TMessage extends PersistedThreadMessage> {
  readonly assembleAssistantMessage: AssembleAssistantMessageFn<TEvent, TMessage>;
  readonly redactSecretsInMessages: RedactMessagesFn<TMessage>;
  readonly isThreadConflictError: IsThreadConflictErrorFn;
}

async function publishTerminalConfirmed(
  publish: () => Promise<void>
): Promise<void> {
  try {
    await publish();
  } catch (cause) {
    throw new TerminalPublicationError(cause);
  }
}

/**
 * Persists the assistant transcript, then publishes the terminal event.
 *
 * The ordering is the invariant: a client must never observe terminal success
 * for a stateful run whose transcript is not yet durable. Persistence is
 * idempotent on the assistant message id, so a retried or redelivered run
 * converges instead of duplicating, and a write conflict from a concurrent
 * writer is retried against a freshly loaded thread.
 */
export async function persistAssistantThenPublishTerminal<
  TEvent,
  TMessage extends PersistedThreadMessage,
>(
  input: DurableChatTerminalInput<TEvent, TMessage>,
  deps: DurableChatTerminalDeps<TEvent, TMessage>
): Promise<DurableChatTerminalResult> {
  let result: DurableChatTerminalResult = { persisted: false };

  if (input.stateKey && input.actorUserId) {
    const assistant = deps.assembleAssistantMessage(
      input.runId,
      input.accumulatedEvents
    );
    if (!assistant) {
      throw new Error(
        "Stateful successful run completed without assistant_final"
      );
    }
    const persistence = input.threadPersistenceForUser(input.actorUserId);
    const maxAttempts = input.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const existing = await persistence.loadThread(
        input.actorUserId,
        input.stateKey
      );
      if (existing.some((message) => message.id === assistant.id)) {
        result = { persisted: true, messageCount: existing.length, attempt };
        break;
      }
      try {
        await persistence.saveThread(
          input.actorUserId,
          input.stateKey,
          deps.redactSecretsInMessages([...existing, assistant]),
          existing.length
        );
        result = {
          persisted: true,
          messageCount: existing.length + 1,
          attempt,
        };
        break;
      } catch (error) {
        if (!deps.isThreadConflictError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }
    if (result.persisted && result.messageCount && result.attempt) {
      input.onPersisted?.({
        messageCount: result.messageCount,
        attempt: result.attempt,
      });
    }
  }

  await publishTerminalConfirmed(input.publishTerminal);
  return result;
}
