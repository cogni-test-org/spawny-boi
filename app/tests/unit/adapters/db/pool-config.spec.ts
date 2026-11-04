// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/db/pool-config`
 * Purpose: Verify node pool policy reaches each lazy role-specific client once.
 * Scope: Constructor wiring/configuration only; real database semantics have component coverage.
 * Invariants: App/service DSNs remain separate, service max1 fails validation.
 * Side-effects: none (mocked factories/logger).
 * Links: bug.5529, bounded-pools.int.test.ts
 * @internal
 */
import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverSchema } from "@/shared/env/server-env";

const fakes = vi.hoisted(() => ({
  app: vi.fn(() => ({ role: "app" })),
  service: vi.fn(() => ({ role: "service" })),
  info: vi.fn(),
}));
vi.mock("@cogni/db-client", () => ({ createAppDbClient: fakes.app }));
vi.mock("@cogni/db-client/service", () => ({
  createServiceDbClient: fakes.service,
}));
vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeId: () => "test-node",
}));
vi.mock("@/shared/observability", () => ({
  EVENT_NAMES: { DB_POOL_CONFIGURED: "adapter.db_pool.configured" },
  makeLogger: () => ({ info: fakes.info }),
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    DATABASE_URL: "app-dsn",
    DATABASE_SERVICE_URL: "service-dsn",
    DB_POOL_MAX: 1,
    DB_SERVICE_POOL_MAX: 2,
  }),
}));

describe("node runtime pool configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("constructs each bounded role once and logs only safe configuration", async () => {
    const { getAppDb } = await import("@/adapters/server/db/drizzle.client");
    const { getServiceDb } = await import(
      "@/adapters/server/db/drizzle.service-client"
    );
    expect(getAppDb()).toBe(getAppDb());
    expect(getServiceDb()).toBe(getServiceDb());
    expect(fakes.app).toHaveBeenCalledExactlyOnceWith("app-dsn", { max: 1 });
    expect(fakes.service).toHaveBeenCalledExactlyOnceWith("service-dsn", {
      max: 2,
    });
    expect(fakes.info.mock.calls).toEqual([
      [
        {
          event: "adapter.db_pool.configured",
          role: "app",
          max: 1,
          pid: process.pid,
        },
        "adapter.db_pool.configured",
      ],
      [
        {
          event: "adapter.db_pool.configured",
          role: "service",
          max: 2,
          pid: process.pid,
        },
        "adapter.db_pool.configured",
      ],
    ]);
  });

  it("defaults to app1/service2 and rejects unsafe or nonprogressing configuration", () => {
    const schema = serverSchema.pick({
      DB_POOL_MAX: true,
      DB_SERVICE_POOL_MAX: true,
    });
    expect(schema.parse({})).toEqual({
      DB_POOL_MAX: 1,
      DB_SERVICE_POOL_MAX: 2,
    });
    expect(
      schema.parse({ DB_POOL_MAX: "3", DB_SERVICE_POOL_MAX: "4" })
    ).toEqual({ DB_POOL_MAX: 3, DB_SERVICE_POOL_MAX: 4 });
    for (const value of [
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "",
      "9007199254740992",
    ]) {
      expect(schema.safeParse({ DB_POOL_MAX: value }).success).toBe(false);
      expect(schema.safeParse({ DB_SERVICE_POOL_MAX: value }).success).toBe(
        false
      );
    }
    expect(schema.safeParse({ DB_SERVICE_POOL_MAX: "1" }).success).toBe(false);
    expect(
      serverSchema.safeParse({ ...BASE_VALID_ENV, DB_SERVICE_POOL_MAX: "1" })
        .success
    ).toBe(false);
  });
});
