// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/ai/durable-chat-terminal`
 * Purpose: Bind this node's collaborators to the shared durable-terminal policy.
 * Scope: Adapter only. The policy — persist the transcript, then publish terminal — lives in `@cogni/graph-execution-host`; this file supplies the node-owned functions it cannot import.
 * Invariants:
 *   - POLICY_IS_SHARED: the ordering rule has exactly one implementation, in the package, so forks cannot drift from it
 *   - Call sites keep this import path, so extraction changed no behavior and no caller
 * Side-effects: none of its own; delegates to injected persistence and publication
 * Links: packages/graph-execution-host/src/durable-chat-terminal.ts
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import {
  type DurableChatTerminalResult,
  persistAssistantThenPublishTerminal as persistThenPublish,
} from "@cogni/graph-execution-host";
import { toUserId } from "@cogni/ids";
import {
  assembleAssistantMessage,
  redactSecretsInMessages,
} from "@/features/ai/public.server";
import { ThreadConflictError, type ThreadPersistencePort } from "@/ports";

export { TerminalPublicationError } from "@cogni/graph-execution-host";

type AssistantMessage = Awaited<
  ReturnType<ThreadPersistencePort["loadThread"]>
>[number];

interface DurableChatTerminalInput {
  readonly runId: string;
  readonly stateKey?: string;
  readonly actorUserId?: string;
  readonly accumulatedEvents: readonly AiEvent[];
  readonly threadPersistenceForUser: (
    actorId: ReturnType<typeof toUserId>
  ) => ThreadPersistencePort;
  readonly publishTerminal: () => Promise<void>;
  readonly onPersisted?: (result: {
    messageCount: number;
    attempt: number;
  }) => void;
  readonly maxAttempts?: number;
}

/**
 * Node-side entry point. Keeps the original signature — including the
 * `toUserId`-typed persistence factory — so every existing call site is
 * untouched, and forwards the node's own assembler, redactor, and conflict
 * predicate into the shared policy.
 */
export async function persistAssistantThenPublishTerminal(
  input: DurableChatTerminalInput
): Promise<DurableChatTerminalResult> {
  return persistThenPublish<AiEvent, AssistantMessage>(
    {
      runId: input.runId,
      ...(input.stateKey !== undefined && { stateKey: input.stateKey }),
      ...(input.actorUserId !== undefined && {
        actorUserId: input.actorUserId,
      }),
      accumulatedEvents: input.accumulatedEvents,
      threadPersistenceForUser: (actorUserId: string) =>
        input.threadPersistenceForUser(toUserId(actorUserId)),
      publishTerminal: input.publishTerminal,
      ...(input.onPersisted !== undefined && { onPersisted: input.onPersisted }),
      ...(input.maxAttempts !== undefined && {
        maxAttempts: input.maxAttempts,
      }),
    },
    {
      assembleAssistantMessage,
      redactSecretsInMessages,
      isThreadConflictError: (error: unknown) =>
        error instanceof ThreadConflictError,
    }
  );
}
