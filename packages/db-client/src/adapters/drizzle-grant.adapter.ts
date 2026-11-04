// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/scheduling/grant`
 * Purpose: Execution grant adapters split by trust boundary — user (appDb, RLS enforced) and worker (serviceDb, BYPASSRLS).
 * Scope: Implements ExecutionGrantUserPort and ExecutionGrantWorkerPort with Drizzle ORM. Does not contain business logic.
 * Invariants:
 * - Per GRANT_NOT_SESSION: Grants are durable, not session-based
 * - Per GRANT_SCOPES_CONSTRAIN_ACTIONS (M2, task.5029): scopes are generalized strings — "graph:execute:{graphId}" (graphs) or "task:dispatch:{nodeId}:{route}" (node tasks)
 * - Per GRANT_NODE_BINDING (M1, task.5029): validation asserts the grant is bound to the dispatched nodeId — a node-task scope embeds its nodeId, so a grant minted for node A cannot authorize a dispatch to node B
 * - ensureGrant selects non-revoked, unexpired scope-compatible rows before findFirst
 * - withTenantScope called on every method (uniform invariant, no-op on serviceDb)
 * Side-effects: IO (database operations)
 * Links: ports/scheduling/execution-grant.port.ts, docs/spec/scheduler.md
 * @public
 */

import { executionGrants } from "@cogni/db-schema/scheduling";
import { type ActorId, type UserId, userActor } from "@cogni/ids";
import {
  type ExecutionGrant,
  type ExecutionGrantUserPort,
  type ExecutionGrantWorkerPort,
  GrantExpiredError,
  GrantNotFoundError,
  GrantRevokedError,
  GrantScopeMismatchError,
} from "@cogni/scheduler-core";
import { and, arrayContains, eq, gt, isNull, or } from "drizzle-orm";
import type { Database, LoggerLike } from "../client";
import { withTenantScope } from "../tenant-scope";

// ── Shared helpers ───────────────────────────────────────────────

const defaultLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function toGrant(row: typeof executionGrants.$inferSelect): ExecutionGrant {
  return {
    id: row.id,
    userId: row.userId,
    billingAccountId: row.billingAccountId,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

function validateGrantFields(
  grantId: string,
  row: typeof executionGrants.$inferSelect
): ExecutionGrant {
  const now = new Date();

  if (row.revokedAt) {
    throw new GrantRevokedError(grantId, row.revokedAt);
  }

  if (row.expiresAt && row.expiresAt < now) {
    throw new GrantExpiredError(grantId, row.expiresAt);
  }

  return toGrant(row);
}

/**
 * Generalized scope check (M2, task.5029). Accepts a grant when its scopes
 * carry ANY of:
 *  - the exact `requiredScope`,
 *  - the node-task wildcard `task:dispatch:{nodeId}:*` (when `requiredScope`
 *    is a node-task dispatch for `nodeId`), or
 *  - the graph wildcard `graph:execute:*`.
 *
 * `nodeId` is the node the worker is dispatching for. For node-task scopes the
 * nodeId is embedded in `requiredScope` (`task:dispatch:{nodeId}:{route}`), so
 * a grant minted for node A can never authorize a dispatch to node B. On
 * mismatch throw `GrantScopeMismatchError` (unchanged from the graph-only path).
 */
function checkGrantScope(
  grant: ExecutionGrant,
  nodeId: string,
  requiredScope: string
): ExecutionGrant {
  const hasExact = grant.scopes.includes(requiredScope);

  const nodeTaskPrefix = `task:dispatch:${nodeId}:`;
  const hasNodeTaskWildcard =
    requiredScope.startsWith(nodeTaskPrefix) &&
    grant.scopes.includes(`${nodeTaskPrefix}*`);

  const hasGraphWildcard = grant.scopes.includes("graph:execute:*");

  if (!hasExact && !hasNodeTaskWildcard && !hasGraphWildcard) {
    throw new GrantScopeMismatchError(grant.id, requiredScope, grant.scopes);
  }

  return grant;
}

// ── User-facing adapter (appDb, RLS enforced) ────────────────────

export class DrizzleExecutionGrantUserAdapter
  implements ExecutionGrantUserPort
{
  private readonly logger: LoggerLike;

  constructor(
    private readonly db: Database,
    logger?: LoggerLike
  ) {
    this.logger = logger ?? defaultLogger;
  }

  async createGrant(input: {
    userId: UserId;
    billingAccountId: string;
    scopes: readonly string[];
    expiresAt?: Date;
  }): Promise<ExecutionGrant> {
    const actorId = userActor(input.userId);
    return withTenantScope(this.db, actorId, async (tx) => {
      const [row] = await tx
        .insert(executionGrants)
        .values({
          userId: input.userId,
          billingAccountId: input.billingAccountId,
          scopes: [...input.scopes],
          expiresAt: input.expiresAt ?? null,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to create execution grant");
      }

      this.logger.info(
        { grantId: row.id, userId: input.userId },
        "Created execution grant"
      );

      return toGrant(row);
    });
  }

  async revokeGrant(callerUserId: UserId, grantId: string): Promise<void> {
    const actorId = userActor(callerUserId);
    await withTenantScope(this.db, actorId, async (tx) => {
      await tx
        .update(executionGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(executionGrants.id, grantId),
            isNull(executionGrants.revokedAt)
          )
        );
    });

    this.logger.info({ grantId }, "Revoked execution grant");
  }

  async deleteGrant(callerUserId: UserId, grantId: string): Promise<void> {
    const actorId = userActor(callerUserId);
    await withTenantScope(this.db, actorId, async (tx) => {
      await tx.delete(executionGrants).where(eq(executionGrants.id, grantId));
    });

    this.logger.info({ grantId }, "Deleted execution grant");
  }

  async ensureGrant(input: {
    userId: UserId;
    billingAccountId: string;
    scopes: readonly string[];
  }): Promise<ExecutionGrant> {
    const actorId = userActor(input.userId);
    return withTenantScope(this.db, actorId, async (tx) => {
      // Match validity and every required scope BEFORE findFirst: another
      // graph's grant must not hide a later compatible grant on this account.
      const existing = await tx.query.executionGrants.findFirst({
        where: and(
          eq(executionGrants.userId, input.userId),
          eq(executionGrants.billingAccountId, input.billingAccountId),
          isNull(executionGrants.revokedAt),
          or(isNull(executionGrants.expiresAt), gt(executionGrants.expiresAt, new Date())),
          input.scopes.length > 0
            ? arrayContains(executionGrants.scopes, [...input.scopes])
            : undefined
        ),
      });

      if (existing) {
        this.logger.info(
          { grantId: existing.id, userId: input.userId },
          "Found existing valid grant"
        );
        return toGrant(existing);
      }

      // Create new grant
      const [row] = await tx
        .insert(executionGrants)
        .values({
          userId: input.userId,
          billingAccountId: input.billingAccountId,
          scopes: [...input.scopes],
          expiresAt: null,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to create execution grant");
      }

      this.logger.info(
        { grantId: row.id, userId: input.userId },
        "Created execution grant (ensureGrant)"
      );

      return toGrant(row);
    });
  }
}

// ── Worker adapter (serviceDb, BYPASSRLS — withTenantScope is no-op) ─

export class DrizzleExecutionGrantWorkerAdapter
  implements ExecutionGrantWorkerPort
{
  private readonly logger: LoggerLike;

  constructor(
    private readonly db: Database,
    logger?: LoggerLike
  ) {
    this.logger = logger ?? defaultLogger;
  }

  async validateGrant(
    actorId: ActorId,
    grantId: string
  ): Promise<ExecutionGrant> {
    return withTenantScope(this.db, actorId, async (tx) => {
      const row = await tx.query.executionGrants.findFirst({
        where: eq(executionGrants.id, grantId),
      });

      if (!row) {
        throw new GrantNotFoundError(grantId);
      }

      this.logger.info({ grantId }, "Validated execution grant");
      return validateGrantFields(grantId, row);
    });
  }

  async validateGrantForScope(
    actorId: ActorId,
    nodeId: string,
    grantId: string,
    requiredScope: string
  ): Promise<ExecutionGrant> {
    const grant = await this.validateGrant(actorId, grantId);
    this.logger.info(
      { grantId, nodeId, requiredScope },
      "Validated execution grant for scope"
    );
    return checkGrantScope(grant, nodeId, requiredScope);
  }

  async validateGrantForGraph(
    actorId: ActorId,
    grantId: string,
    graphId: string
  ): Promise<ExecutionGrant> {
    // Back-compat: graph scopes carry no node binding, so pass an empty nodeId
    // (the node-task wildcard branch never matches a `graph:execute:*` scope).
    return this.validateGrantForScope(
      actorId,
      "",
      grantId,
      `graph:execute:${graphId}`
    );
  }
}
