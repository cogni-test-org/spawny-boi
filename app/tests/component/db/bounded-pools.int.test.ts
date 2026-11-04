// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/bounded-pools`
 * Purpose: Prove capped runtime pools preserve tenant and harness persistence progress.
 * Scope: Owns a disposable Postgres container and isolated login roles, never shared CI roles.
 * Invariants: Real RLS authentication; app max1; service reservation leaves query capacity.
 * Side-effects: IO (testcontainer, migrations, isolated fixture rows).
 * Links: bug.5529, app/src/adapters/server/db
 * @internal
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createAppDbClient,
  DrizzleExecutionRequestAdapter,
  withTenantScope,
} from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";
import { toUserId, userActor } from "@cogni/ids";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleThreadPersistenceAdapter } from "@/adapters/server/ai/thread-persistence.adapter";
import { serverSchema } from "@/shared/env/server-env";

const poolSchema = serverSchema.pick({
  DB_POOL_MAX: true,
  DB_SERVICE_POOL_MAX: true,
});

describe("bounded runtime pools", () => {
  let container: StartedPostgreSqlContainer;
  let admin: ReturnType<typeof postgres>;
  let app: ReturnType<typeof createAppDbClient>;
  let service: ReturnType<typeof createServiceDbClient>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:15-alpine").start();
    admin = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(admin), {
      migrationsFolder: resolve("src/adapters/server/db/migrations"),
    });
    // This entire cluster belongs to this file. Do not alter the global fixture's roles.
    await admin.unsafe(
      "CREATE ROLE pool_app LOGIN PASSWORD 'test_app_only' CONNECTION LIMIT 2 NOSUPERUSER NOBYPASSRLS"
    );
    await admin.unsafe(
      "CREATE ROLE pool_service LOGIN PASSWORD 'test_service_only' CONNECTION LIMIT 4 NOSUPERUSER BYPASSRLS"
    );
    await admin.unsafe(
      "GRANT USAGE ON SCHEMA public TO pool_app, pool_service"
    );
    await admin.unsafe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pool_app, pool_service"
    );
    const appUrl = new URL(container.getConnectionUri());
    appUrl.username = "pool_app";
    appUrl.password = "test_app_only";
    const serviceUrl = new URL(container.getConnectionUri());
    serviceUrl.username = "pool_service";
    serviceUrl.password = "test_service_only";
    const limits = poolSchema.parse({});
    app = createAppDbClient(appUrl.toString(), { max: limits.DB_POOL_MAX });
    service = createServiceDbClient(serviceUrl.toString(), {
      max: limits.DB_SERVICE_POOL_MAX,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.$client.end({ timeout: 1 });
    await service?.$client.end({ timeout: 1 });
    await admin?.end({ timeout: 1 });
    await container?.stop();
  });

  it("validates node policy and preserves configurable, finite factory limits", () => {
    expect(poolSchema.parse({})).toEqual({
      DB_POOL_MAX: 1,
      DB_SERVICE_POOL_MAX: 2,
    });
    expect(
      poolSchema.parse({ DB_POOL_MAX: "3", DB_SERVICE_POOL_MAX: "4" })
    ).toEqual({ DB_POOL_MAX: 3, DB_SERVICE_POOL_MAX: 4 });
    for (const invalid of [
      "0",
      "-1",
      "1.5",
      "Infinity",
      "NaN",
      "",
      "9007199254740992",
    ]) {
      expect(poolSchema.safeParse({ DB_POOL_MAX: invalid }).success).toBe(
        false
      );
    }
    expect(poolSchema.safeParse({ DB_SERVICE_POOL_MAX: "1" }).success).toBe(
      false
    );
    expect(
      serverSchema.safeParse({ ...BASE_VALID_ENV, DB_POOL_MAX: "0" }).success
    ).toBe(false);
    expect(() =>
      createAppDbClient("postgres://unused:unused@localhost/unused", { max: 0 })
    ).toThrow("positive safe integer");
  });

  it("queues concurrent RLS thread operations, idempotency reads and heartbeats within one app session", async () => {
    const alice = toUserId(randomUUID());
    const bob = toUserId(randomUUID());
    const a = new DrizzleThreadPersistenceAdapter(app, userActor(alice));
    const b = new DrizzleThreadPersistenceAdapter(app, userActor(bob));
    const messages = [
      {
        id: "answer",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "verified" }],
      },
    ];
    await a.saveThread(alice, "poolproof", messages, 0);
    expect(await b.loadThread(alice, "poolproof")).toEqual([]);
    const executions = new DrizzleExecutionRequestAdapter(app);
    const key = `pool:${randomUUID()}`;
    await executions.createPendingRequest(
      key,
      "hash",
      randomUUID(),
      null,
      new Date(Date.now() + 60_000).toISOString()
    );
    const held = await app.$client.reserve();
    const operations = Promise.all(
      Array.from({ length: 8 }, async (_, n) => {
        const actor = n % 2 === 0 ? alice : bob;
        const scoped = await withTenantScope(app, userActor(actor), (tx) =>
          tx.execute(
            sql`select current_setting('app.current_user_id') as actor`
          )
        );
        expect(scoped[0]?.actor).toBe(actor);
        await executions.heartbeatRequest(
          key,
          new Date(Date.now() + 60_000).toISOString()
        );
        expect((await executions.checkIdempotency(key, "hash")).status).toBe(
          "pending"
        );
        expect(await a.loadThread(alice, "poolproof")).toEqual(messages);
      })
    );
    try {
      const sessions =
        await admin`select count(*)::int as count from pg_stat_activity where usename = 'pool_app'`;
      expect(sessions[0]?.count).toBe(1);
    } finally {
      held.release();
    }
    await operations;
    const identity =
      await app.$client`select current_user as role, current_setting('application_name') as name`;
    expect(identity[0]).toEqual({
      role: "pool_app",
      name: "cogni_template_app",
    });
    const sessions =
      await admin`select count(*)::int as count from pg_stat_activity where usename = 'pool_app'`;
    expect(sessions[0]?.count).toBe(1);
  }, 10_000);

  it("makes service queries progress while one session is reserved", async () => {
    const held = await service.$client.reserve();
    try {
      const rows = await service.$client`select current_user as role`;
      expect(rows[0]?.role).toBe("pool_service");
      const sessions =
        await admin`select count(*)::int as count from pg_stat_activity where usename = 'pool_service'`;
      expect(sessions[0]?.count).toBe(2);
    } finally {
      held.release();
    }
  }, 5_000);
});
