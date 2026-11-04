// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-substrate.contract`
 * Purpose: Prove the shallow/deep readiness contract for async substrate dependencies.
 * Scope: Exercises the /readyz route with isolated Temporal and scheduler-worker probes. Does not perform network or database IO.
 * Invariants: Default readiness stays healthy while emitting critical dependency events; `?deep=1` returns 503 for either missing dependency.
 *             Default readiness runs checks concurrently: slow non-fatal checks are bounded and degrade, a slow system tenant is a 503, and only tenant success is cached (task.5298).
 * Side-effects: none
 * Links: src/app/(infra)/readyz/route.ts, Cogni-DAO/cogni#1860
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertEvmRpcConfig: vi.fn(),
  assertRuntimeSecrets: vi.fn(),
  assertSchedulerWorkerConnectivity: vi.fn(),
  assertTemporalConnectivity: vi.fn(),
  checkEvmRpcConnectivity: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  serverEnv: vi.fn(),
  setBuildInfo: vi.fn(),
  debug: vi.fn(),
  verifySystemTenant: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    evmOnchainClient: {},
    paymentRailsActive: false,
    scheduleControl: {},
    serviceAccountService: {},
  }),
}));

vi.mock("@/bootstrap/healthchecks", () => ({
  verifySystemTenant: (...args: unknown[]) =>
    mocks.verifySystemTenant(...args),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: {
          log: {
            debug: ReturnType<typeof vi.fn>;
            error: ReturnType<typeof vi.fn>;
            info: ReturnType<typeof vi.fn>;
            warn: ReturnType<typeof vi.fn>;
          };
        },
        request: NextRequest
      ) => Promise<Response>
    ) =>
    async (request: NextRequest) =>
      handler(
        {
          log: {
            debug: mocks.debug,
            error: mocks.error,
            info: mocks.info,
            warn: mocks.warn,
          },
        },
        request
      ),
}));

vi.mock("@/shared/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/env")>();
  return {
    ...actual,
    serverEnv: () => mocks.serverEnv(),
  };
});

vi.mock("@/shared/env/invariants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/env/invariants")>();
  return {
    ...actual,
    assertEvmRpcConfig: (...args: unknown[]) =>
      mocks.assertEvmRpcConfig(...args),
    assertRuntimeSecrets: (...args: unknown[]) =>
      mocks.assertRuntimeSecrets(...args),
    assertSchedulerWorkerConnectivity: (...args: unknown[]) =>
      mocks.assertSchedulerWorkerConnectivity(...args),
    assertTemporalConnectivity: (...args: unknown[]) =>
      mocks.assertTemporalConnectivity(...args),
    checkEvmRpcConnectivity: (...args: unknown[]) =>
      mocks.checkEvmRpcConnectivity(...args),
  };
});

vi.mock("@/shared/observability/server/metrics", () => ({
  setBuildInfo: (...args: unknown[]) => mocks.setBuildInfo(...args),
}));

import {
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";

// Re-imported per test so the route's in-process system-tenant cache starts cold.
let GET: typeof import("@/app/(infra)/readyz/route").GET;

function request(path = "/readyz"): NextRequest {
  return new NextRequest(`http://localhost:3200${path}`);
}

describe("GET /readyz async substrate contract", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    ({ GET } = await import("@/app/(infra)/readyz/route"));
    vi.clearAllMocks();
    mocks.assertEvmRpcConfig.mockReset();
    mocks.serverEnv.mockReturnValue({
      APP_BUILD_SHA: "readyz-contract-sha",
      APP_ENV: "production",
    });
    mocks.assertTemporalConnectivity.mockResolvedValue(undefined);
    mocks.assertSchedulerWorkerConnectivity.mockResolvedValue(undefined);
    mocks.checkEvmRpcConnectivity.mockResolvedValue({ ok: true });
    mocks.verifySystemTenant.mockResolvedValue(undefined);
  });

  it("checks RPC before payment activation while keeping a transient failure non-draining", async () => {
    mocks.checkEvmRpcConnectivity.mockResolvedValue({
      ok: false,
      source: "live",
      errorMessage: "upstream 429",
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.assertEvmRpcConfig).toHaveBeenCalledOnce();
    expect(mocks.checkEvmRpcConnectivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ APP_ENV: "production" }),
      { forceLive: false }
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.evm_rpc.unreachable",
        severity: "degraded",
        dependency: "evm-rpc",
      }),
      expect.stringContaining("returning ready")
    );
  });

  it("returns 503 when the mandatory RPC secret is missing", async () => {
    mocks.assertEvmRpcConfig.mockImplementation(() => {
      throw new RuntimeSecretError("EVM_RPC_URL is required");
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "MISSING_RUNTIME_SECRET",
      message: "EVM_RPC_URL is required",
    });
    expect(mocks.checkEvmRpcConnectivity).not.toHaveBeenCalled();
  });

  it("forces a live RPC read and returns 503 when the deep probe cannot reach Base", async () => {
    mocks.checkEvmRpcConnectivity.mockResolvedValue({
      ok: false,
      source: "live",
      errorMessage: "RPC timeout",
    });

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "EVM RPC connectivity check failed: RPC timeout",
    });
    expect(mocks.checkEvmRpcConnectivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ APP_ENV: "production" }),
      { forceLive: true }
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.evm_rpc.unreachable",
        severity: "critical",
      }),
      "deep readiness: EVM RPC unreachable"
    );
  });

  it("records successful deep RPC proof", async () => {
    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(200);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.evm_rpc.reachable",
        dependency: "evm-rpc",
      }),
      "deep readiness: EVM RPC reachable"
    );
  });

  it("keeps shallow readiness healthy and critically observes both missing dependencies", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable")
    );
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable")
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      buildSha: "readyz-contract-sha",
    });
    expect(mocks.verifySystemTenant).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledTimes(2);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.temporal.unreachable",
        severity: "critical",
        reason: "INFRA_UNREACHABLE",
        dependency: "temporal",
      }),
      expect.stringContaining("MISSION-CRITICAL async substrate down")
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.scheduler_worker.unreachable",
        severity: "critical",
        reason: "INFRA_UNREACHABLE",
        dependency: "scheduler-worker",
      }),
      expect.stringContaining("MISSION-CRITICAL async substrate down")
    );
  });

  it("returns 503 from the deep probe when Temporal is unavailable", async () => {
    mocks.assertTemporalConnectivity.mockRejectedValue(
      new InfraConnectivityError("Temporal is unavailable")
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "Temporal is unavailable",
    });
    expect(mocks.assertSchedulerWorkerConnectivity).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("returns 503 from the deep probe when scheduler-worker is unavailable", async () => {
    mocks.assertSchedulerWorkerConnectivity.mockRejectedValue(
      new InfraConnectivityError("scheduler-worker is unavailable")
    );

    const response = await GET(request("/readyz?deep=1"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "scheduler-worker is unavailable",
    });
    expect(mocks.assertTemporalConnectivity).toHaveBeenCalledOnce();
    expect(mocks.verifySystemTenant).not.toHaveBeenCalled();
  });

  it("does not let a slow non-fatal check block default readiness", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    mocks.checkEvmRpcConnectivity.mockReturnValue(never);
    mocks.assertTemporalConnectivity.mockReturnValue(never);
    mocks.assertSchedulerWorkerConnectivity.mockReturnValue(never);

    const pending = GET(request());
    await vi.advanceTimersByTimeAsync(1500);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(mocks.verifySystemTenant).toHaveBeenCalledOnce();
    for (const event of [
      "substrate.evm_rpc.unreachable",
      "substrate.temporal.unreachable",
      "substrate.scheduler_worker.unreachable",
    ]) {
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event,
          severity: "degraded",
          reason: "CHECK_TIMEOUT",
        }),
        expect.stringContaining("exceeded its budget")
      );
    }
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 1500,
        checks: expect.objectContaining({
          evmRpc: { status: "timeout", durationMs: 1500 },
          temporal: { status: "timeout", durationMs: 1500 },
          schedulerWorker: { status: "timeout", durationMs: 1500 },
          systemTenant: { status: "ok", durationMs: 0 },
        }),
      }),
      "readiness: checks complete"
    );
  });

  it("returns 503 when the system tenant check exceeds its budget", async () => {
    vi.useFakeTimers();
    mocks.verifySystemTenant.mockReturnValue(new Promise<never>(() => {}));

    const pending = GET(request());
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      reason: "INFRA_UNREACHABLE",
      message: "System tenant check exceeded 2000ms budget",
    });
  });

  it("caches only system tenant success, for at most 30s", async () => {
    vi.useFakeTimers();
    mocks.verifySystemTenant.mockRejectedValueOnce(
      new Error("Failed query", {
        cause: Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
        }),
      })
    );

    // Failure is never cached: the next probe re-checks the database.
    expect((await GET(request())).status).toBe(503);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "INTERNAL_ERROR",
        error: "Failed query",
        causeCode: "ECONNREFUSED",
        causeMessage: "connection refused",
      }),
      "readiness check failed: internal error"
    );
    expect((await GET(request())).status).toBe(200);
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(2);

    // Success is reused inside the TTL...
    await vi.advanceTimersByTimeAsync(29_999);
    expect((await GET(request())).status).toBe(200);
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(2);

    // ...and re-proven once it expires.
    await vi.advanceTimersByTimeAsync(1);
    expect((await GET(request())).status).toBe(200);
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(3);
  });

  it("keeps the deep probe uncached and unbounded by the default budgets", async () => {
    vi.useFakeTimers();
    mocks.assertTemporalConnectivity.mockReturnValue(
      new Promise((resolve) => setTimeout(resolve, 4000))
    );

    const pending = GET(request("/readyz?deep=1"));
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).status).toBe(200);
    expect((await GET(request("/readyz?deep=1"))).status).toBe(200);

    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(2);
  });

  it("still raises the critical alert when a non-fatal check fails after its budget", async () => {
    vi.useFakeTimers();
    mocks.assertTemporalConnectivity.mockReturnValue(
      new Promise((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new InfraConnectivityError(
                "Temporal connectivity check failed: Temporal connection timeout"
              )
            ),
          5000
        )
      )
    );

    const pending = GET(request());
    await vi.advanceTimersByTimeAsync(1500);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(mocks.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3500);
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.temporal.unreachable",
        severity: "critical",
        reason: "INFRA_UNREACHABLE",
        dependency: "temporal",
      }),
      expect.stringContaining("MISSION-CRITICAL async substrate down")
    );
    expect(response.status).toBe(200);
  });

  it("shares one in-flight tenant query and caches a success that lands after the budget", async () => {
    vi.useFakeTimers();
    mocks.verifySystemTenant.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 2500))
    );

    const first = GET(request());
    await vi.advanceTimersByTimeAsync(1000);
    const second = GET(request()); // joins the in-flight query
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).status).toBe(503);

    await vi.advanceTimersByTimeAsync(500); // query resolves at 2.5s
    expect((await second).status).toBe(200);
    expect((await GET(request())).status).toBe(200); // served from the cache
    expect(mocks.verifySystemTenant).toHaveBeenCalledOnce();
  });

  it("abandons a tenant query that never settles and retries after 10s", async () => {
    vi.useFakeTimers();
    mocks.verifySystemTenant
      .mockReturnValueOnce(new Promise<never>(() => {}))
      .mockResolvedValue(undefined);

    for (let probe = 0; probe < 5; probe++) {
      const pending = GET(request());
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).status).toBe(503);
    }
    expect(mocks.verifySystemTenant).toHaveBeenCalledOnce(); // probes joined query 1

    await vi.advanceTimersByTimeAsync(1); // query 1 is now older than 10s
    expect((await GET(request())).status).toBe(200);
    expect((await GET(request())).status).toBe(200); // cached
    expect(mocks.verifySystemTenant).toHaveBeenCalledTimes(2);
  });
});
