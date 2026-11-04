// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/services/syncGovernanceSchedules`
 * Purpose: Unit tests for governance schedule sync logic.
 * Scope: Tests sync function with mocked ScheduleControlPort; verifies create/update/resume/skip/prune behavior. Does not test Temporal integration or DB operations.
 * Invariants: Prune pauses (never deletes); conflict = update or skip or resume; idempotent on repeat.
 * Side-effects: none (all deps mocked)
 * Links: src/features/governance/services/syncGovernanceSchedules.ts
 * @public
 */

import {
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleDescription,
} from "../../../../../../packages/scheduler-core/src/ports/schedule-control.port";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GovernanceScheduleSyncDeps,
  governanceScheduleId,
  syncGovernanceSchedules,
} from "../../../../../../packages/scheduler-core/src/services/syncGovernanceSchedules";
import type { GovernanceConfig } from "@/shared/config";

const GRANT_ID = "test-grant-id-001";
const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";
const MOCK_DB_SCHEDULE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Counter-based mock to return unique dbScheduleIds per call */
let upsertCallCount = 0;

function makeMockDeps(
  overrides?: Partial<GovernanceScheduleSyncDeps>
): GovernanceScheduleSyncDeps {
  upsertCallCount = 0;
  return {
    ensureGovernanceGrant: vi.fn().mockResolvedValue(GRANT_ID),
    upsertGovernanceScheduleRow: vi.fn().mockImplementation(() => {
      upsertCallCount++;
      return Promise.resolve(`${MOCK_DB_SCHEDULE_ID}-${upsertCallCount}`);
    }),
    systemUserId: SYSTEM_USER_ID,
    scheduleControl: {
      createSchedule: vi.fn().mockResolvedValue(undefined),
      updateSchedule: vi.fn().mockResolvedValue(undefined),
      pauseSchedule: vi.fn().mockResolvedValue(undefined),
      resumeSchedule: vi.fn().mockResolvedValue(undefined),
      deleteSchedule: vi.fn().mockResolvedValue(undefined),
      describeSchedule: vi.fn().mockResolvedValue(null),
      listScheduleIds: vi.fn().mockResolvedValue([]),
    },
    listGovernanceScheduleIds: vi.fn().mockResolvedValue([]),
    disableSchedule: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function makeConfig(
  charters: Array<{
    charter: string;
    cron: string;
    entrypoint: string;
    timezone?: string;
  }>
): GovernanceConfig {
  return {
    schedules: charters.map((c) => ({
      charter: c.charter,
      cron: c.cron,
      timezone: c.timezone ?? "UTC",
      entrypoint: c.entrypoint,
    })),
  };
}

/** Helper: build a ScheduleDescription matching the desired config (no drift) */
function makeMatchingDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; timezone?: string; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: opts?.timezone ?? "UTC",
    input: { message: entrypoint, model: "kimi-k2.5" },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

/** Helper: build a ScheduleDescription with stale config (drift) */
function makeDriftedDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: "UTC",
    // Stale: missing model field (the bug we're fixing)
    input: { message: entrypoint },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

describe("syncGovernanceSchedules", () => {
  let deps: GovernanceScheduleSyncDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  it("creates schedules for each charter in config", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      { charter: "GOVERN", cron: "0 * * * *", entrypoint: "GOVERN" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([
      "governance:community",
      "governance:govern",
    ]);
    // Upsert called for each schedule before Temporal creation
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledTimes(2);
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        temporalScheduleId: "governance:community",
        ownerUserId: SYSTEM_USER_ID,
        graphId: "sandbox:openclaw",
      })
    );
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledTimes(2);
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "governance:community",
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
        cron: "0 */6 * * *",
        timezone: "UTC",
        graphId: "sandbox:openclaw",
        executionGrantId: GRANT_ID,
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
        overlapPolicy: "skip",
        catchupWindowMs: 0,
      })
    );
  });

  it("ensures governance grant before creating schedules", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    await syncGovernanceSchedules(config, deps);

    expect(deps.ensureGovernanceGrant).toHaveBeenCalledOnce();
  });

  it("skips when schedule exists, is running, and config matches", async () => {
    const matchingDesc = makeMatchingDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(matchingDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.skipped).toEqual(["governance:community"]);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when config has changed (model drift)", async () => {
    const driftedDesc = makeDriftedDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual(["governance:community"]);
    expect(result.skipped).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:community",
      expect.objectContaining({
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
      })
    );
    // Running schedule — should not be resumed
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when dbScheduleId link drift detected", async () => {
    // Temporal schedule has dbScheduleId: null (legacy), DB row returns a UUID
    const descWithNullLink = makeMatchingDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY",
      { dbScheduleId: null }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(descWithNullLink);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual(["governance:community"]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:community",
      expect.objectContaining({
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
      })
    );
  });

  it("updates and resumes a paused schedule with changed config", async () => {
    const driftedPaused = makeDriftedDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedPaused);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual(["governance:community"]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledOnce();
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      "governance:community"
    );
  });

  it("resumes paused schedule when config matches", async () => {
    const pausedDesc = makeMatchingDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(pausedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.resumed).toEqual(["governance:community"]);
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      "governance:community"
    );
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
  });

  it("pauses stale governance schedules not in config", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:community", "governance:old-charter"]),
    });

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.paused).toEqual(["governance:old-charter"]);
    expect(deps.scheduleControl.pauseSchedule).toHaveBeenCalledWith(
      "governance:old-charter"
    );
  });

  // CROSS_TENANT_PRUNE (bug.5009): the shared Temporal namespace also holds the
  // operator's node-scoped `governance:{nodeId}:{charter}` dispatch schedules. A
  // node's flat prune MUST NOT pause them — doing so stopped forks' prod epochs
  // from self-sustaining (a paused schedule skips its cron).
  const DISPATCH_ID = "governance:11111111-2222-4333-8444-555555555555:ledger_ingest";

  it("does NOT pause the operator's node-scoped dispatch schedule", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:community", DISPATCH_ID]),
    });

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.paused).toEqual([]);
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalledWith(
      DISPATCH_ID
    );
  });

  it("still prunes its own stale flat id while ignoring a dispatch schedule", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([
          "governance:community",
          "governance:old-charter",
          DISPATCH_ID,
        ]),
    });

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.paused).toEqual(["governance:old-charter"]);
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalledWith(
      DISPATCH_ID
    );
  });

  it("handles externally deleted schedules during prune gracefully", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:deleted-charter"]),
    });
    deps.scheduleControl.pauseSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlNotFoundError("governance:deleted-charter")
      );

    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    // Should not throw, and should not list as paused
    expect(result.paused).toEqual([]);
  });

  it("is idempotent: no-op on repeat call with same config", async () => {
    // Use a stable dbScheduleId for both calls
    const stableDbId = "stable-db-id-for-idempotency";
    deps.upsertGovernanceScheduleRow = vi.fn().mockResolvedValue(stableDbId);

    // First call: all schedules created
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result1 = await syncGovernanceSchedules(config, deps);
    expect(result1.created).toEqual(["governance:community"]);

    // Second call: schedule exists now with matching config + same dbScheduleId
    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue(
      makeMatchingDesc("governance:community", "0 */6 * * *", "COMMUNITY", {
        dbScheduleId: stableDbId,
      })
    );

    const result2 = await syncGovernanceSchedules(config, deps);
    expect(result2.skipped).toEqual(["governance:community"]);
    expect(result2.created).toEqual([]);
    expect(result2.updated).toEqual([]);
  });

  it("returns empty result for config with no schedules", async () => {
    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.resumed).toEqual([]);
    expect(result.paused).toEqual([]);
  });
});

const LEDGER: NonNullable<GovernanceConfig["ledger"]> = {
  scopeId: "scope-uuid-001",
  scopeKey: "default",
  epochLengthDays: 7,
  activitySources: {
    github: {
      attributionPipeline: "cogni-v0.0",
      sourceRefs: ["cogni-dao/cogni"],
    },
  },
  poolConfig: { baseIssuanceCredits: 10000n },
  baseIssuanceCredits: "10000",
  approvers: ["0x070075F1389Ae1182aBac722B36CA12285d0c949"],
};

describe("GRAPH_CHARTER — governance schedule `graph:` (task.5282)", () => {
  const GRAPH_GRANT_ID = "test-graph-grant-id-001";
  const DECIDE = {
    charter: "COGNI_DECIDE",
    cron: "*/30 * * * *",
    timezone: "UTC",
    entrypoint: "DECIDE",
    graph: "langgraph:cogni-decide",
    model: "gpt-oss-120b",
  };
  const created = (deps: GovernanceScheduleSyncDeps) =>
    vi
      .mocked(deps.scheduleControl.createSchedule)
      .mock.calls.map(([params]) => params);

  it("runs the declared langgraph graph via GraphRunWorkflow with a messages + platform modelRef input", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });

    const result = await syncGovernanceSchedules({ schedules: [DECIDE] }, deps);

    expect(result.created).toEqual(["governance:cogni_decide"]);
    const [params] = created(deps);
    expect(params).toMatchObject({
      scheduleId: "governance:cogni_decide",
      graphId: "langgraph:cogni-decide",
      executionGrantId: GRAPH_GRANT_ID,
      cron: "*/30 * * * *",
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: "DECIDE" }],
        modelRef: { providerKey: "platform", modelId: "gpt-oss-120b" },
      },
    });
    // undefined workflowType ⇒ adapter default GraphRunWorkflow; default queue.
    expect(params?.workflowType).toBeUndefined();
    expect(params?.taskQueueOverride).toBeUndefined();
    expect(deps.ensureGraphGrant).toHaveBeenCalledWith(
      "langgraph:cogni-decide",
    );
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "langgraph:cogni-decide",
        executionGrantId: GRAPH_GRANT_ID,
      }),
    );
  });

  it.each([
    { change: "graph only", graph: "langgraph:ponderer", grant: GRAPH_GRANT_ID, cron: DECIDE.cron, paused: false },
    { change: "rotated grant", graph: DECIDE.graph, grant: "replacement-grant", cron: DECIDE.cron, paused: false },
    { change: "cadence sharing the next tick", graph: DECIDE.graph, grant: GRAPH_GRANT_ID, cron: "15 * * * *", paused: false },
    { change: "paused cadence", graph: DECIDE.graph, grant: GRAPH_GRANT_ID, cron: "15 * * * *", paused: true },
    { change: "unchanged desired state", graph: DECIDE.graph, grant: GRAPH_GRANT_ID, cron: DECIDE.cron, paused: false },
  ])("reapplies full graph action for $change", async ({ graph, grant, cron, paused }) => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(grant),
    });
    deps.scheduleControl.createSchedule = vi.fn().mockRejectedValue(
      new ScheduleControlConflictError("governance:cogni_decide")
    );
    deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue({
      scheduleId: "governance:cogni_decide",
      nextRunAtIso: "2026-10-21T12:15:00.000Z",
      lastRunAtIso: null,
      isPaused: paused,
      cron: null,
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: DECIDE.entrypoint }],
        modelRef: { providerKey: "platform", modelId: DECIDE.model },
      },
      dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
    });
    const result = await syncGovernanceSchedules(
      { schedules: [{ ...DECIDE, graph, cron }] }, deps
    );
    expect(result.updated).toEqual(["governance:cogni_decide"]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:cogni_decide",
      expect.objectContaining({ graphId: graph, executionGrantId: grant, cron })
    );
    if (paused) {
      expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith("governance:cogni_decide");
      expect(vi.mocked(deps.scheduleControl.updateSchedule).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(deps.scheduleControl.resumeSchedule).mock.invocationCallOrder[0]!
      );
    } else {
      expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
    }
  });

  it("keeps a charter WITHOUT graph on sandbox:openclaw byte-for-byte (governance grant, message+model input)", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });

    await syncGovernanceSchedules(
      makeConfig([
        { charter: "HEARTBEAT", cron: "0 * * * *", entrypoint: "HEARTBEAT" },
      ]),
      deps,
    );

    const [params] = created(deps);
    expect(params?.graphId).toBe("sandbox:openclaw");
    expect(params?.executionGrantId).toBe(GRANT_ID);
    expect(params?.input).toEqual({ message: "HEARTBEAT", model: "kimi-k2.5" });
    expect(params?.workflowType).toBeUndefined();
    expect(deps.ensureGraphGrant).not.toHaveBeenCalled();
  });

  it("LEDGER_PRESERVED: adding a graph charter leaves the ledger schedule exactly as before", async () => {
    const ledgerCharter = {
      charter: "LEDGER_INGEST",
      cron: "0 0 * * *",
      timezone: "UTC",
      entrypoint: "LEDGER_INGEST",
    };
    const ledgerOnly = makeMockDeps();
    await syncGovernanceSchedules(
      { schedules: [ledgerCharter], ledger: LEDGER },
      ledgerOnly,
    );
    const [ledgerBefore] = created(ledgerOnly);

    const withGraph = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    const result = await syncGovernanceSchedules(
      { schedules: [DECIDE, ledgerCharter], ledger: LEDGER },
      withGraph,
    );
    const ledgerAfter = created(withGraph).find(
      (p) => p.scheduleId === "governance:ledger_ingest",
    );

    expect(result.created).toEqual([
      "governance:cogni_decide",
      "governance:ledger_ingest",
    ]);
    expect(ledgerAfter).toBeDefined();
    // Same schedule id, workflow, queue, grant, input — only the per-call dbScheduleId differs.
    const strip = (p: typeof ledgerAfter) => ({ ...p, dbScheduleId: "x" });
    expect(strip(ledgerAfter)).toEqual(strip(ledgerBefore));
    expect(ledgerAfter?.workflowType).toBe("CollectEpochWorkflow");
    expect(ledgerAfter?.executionGrantId).toBe(GRANT_ID);
    expect(result.paused).toEqual([]);
  });

  it("ignores `graph` on LEDGER_INGEST (always the epoch-collect workflow)", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    await syncGovernanceSchedules(
      {
        schedules: [
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            timezone: "UTC",
            entrypoint: "LEDGER_INGEST",
            graph: "langgraph:cogni-decide",
            model: "gpt-oss-120b",
          },
        ],
        ledger: LEDGER,
      },
      deps,
    );
    const [params] = created(deps);
    expect(params?.workflowType).toBe("CollectEpochWorkflow");
    expect(params?.graphId).toBe("ledger:ingest");
    expect(deps.ensureGraphGrant).not.toHaveBeenCalled();
  });

  it("skips (and lets prune pause) a graph charter when no graph grant dep is wired", async () => {
    const deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:cogni_decide"]),
    });

    const result = await syncGovernanceSchedules({ schedules: [DECIDE] }, deps);

    expect(deps.scheduleControl.createSchedule).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["governance:cogni_decide"]);
    expect(result.paused).toEqual(["governance:cogni_decide"]);
  });
});

describe("governanceScheduleId", () => {
  it("lowercases charter name", () => {
    expect(governanceScheduleId("COMMUNITY")).toBe("governance:community");
    expect(governanceScheduleId("ENGINEERING")).toBe("governance:engineering");
    expect(governanceScheduleId("GOVERN")).toBe("governance:govern");
  });
});

// Startup is tested at the real job boundary; no HTTP auth or Temporal harness.
describe("governance startup reconciliation", () => {
  it("starts once without an ops token and retries lock contention", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("INTERNAL_OPS_TOKEN", "");
    const job = vi.fn().mockRejectedValueOnce(new Error("lock busy"))
      .mockResolvedValue({ created: 1 });
    vi.doMock("@/bootstrap/jobs/syncGovernanceSchedules.job", () => ({
      runGovernanceSchedulesSyncJob: job,
    }));
    vi.doMock("@/shared/observability", () => ({
      makeLogger: () => ({ warn: vi.fn() }),
    }));
    try {
      const { startGovernanceSyncOnBoot } = await import("@/bootstrap/startup-reconcile");
      startGovernanceSyncOnBoot();
      startGovernanceSyncOnBoot();
      await vi.dynamicImportSettled();
      expect(job).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(job).toHaveBeenCalledTimes(2);
      expect(job).toHaveBeenLastCalledWith({ throwIfLocked: true });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(job).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.doUnmock("@/bootstrap/jobs/syncGovernanceSchedules.job");
      vi.doUnmock("@/shared/observability");
    }
  });

  it("bounds repeated failures to eight attempts", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("VITEST", "false");
    const job = vi.fn().mockRejectedValue(new Error("Temporal unavailable"));
    vi.doMock("@/bootstrap/jobs/syncGovernanceSchedules.job", () => ({
      runGovernanceSchedulesSyncJob: job,
    }));
    vi.doMock("@/shared/observability", () => ({
      makeLogger: () => ({ warn: vi.fn() }),
    }));
    try {
      const { startGovernanceSyncOnBoot } = await import("@/bootstrap/startup-reconcile");
      startGovernanceSyncOnBoot();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(job).toHaveBeenCalledTimes(8);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.doUnmock("@/bootstrap/jobs/syncGovernanceSchedules.job");
      vi.doUnmock("@/shared/observability");
    }
  });
});
