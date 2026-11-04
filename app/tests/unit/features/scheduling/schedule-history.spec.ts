// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests/unit/features/scheduling/schedule-history
 * Purpose: Verify owned schedule history and nullable thread correlation.
 * Scope: Public service seams with injected ports; database isolation has component coverage.
 * Invariants: No cross-owner reads; no thread content in metadata.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
import { toUserId } from "@cogni/ids";
import type { ScheduleSpec } from "@cogni/scheduler-core";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduleHistoryService } from "@/features/scheduling/services/schedule-history";
import { EVENT_NAMES } from "@/shared/observability";

const caller = toUserId("11111111-1111-4111-8111-111111111111");
const schedule: ScheduleSpec = {
  id: "22222222-2222-4222-8222-222222222222",
  ownerUserId: caller,
  executionGrantId: "33333333-3333-4333-8333-333333333333",
  graphId: "test:history",
  input: {},
  cron: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: new Date("2026-10-24T00:00:00Z"),
  updatedAt: new Date("2026-10-24T00:00:00Z"),
};
const run = {
  id: "row-a",
  runId: "run-a",
  scheduleId: schedule.id,
  stateKey: "slot-a",
  requestedBy: null,
  status: "success",
  scheduledFor: "2026-10-24T01:00:00.000Z",
  startedAt: null,
  completedAt: null,
  errorCode: null,
} as const;
const getSchedule = vi.fn();
const listRuns = vi.fn();
const loadThread = vi.fn();
const service = createScheduleHistoryService({
  schedules: { getSchedule },
  reader: { listRuns },
});

describe("owned schedule history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSchedule.mockResolvedValue(schedule);
    listRuns.mockResolvedValue([run]);
  });

  it("denies a foreign schedule before querying runs", async () => {
    getSchedule.mockResolvedValue({ ...schedule, ownerUserId: "other" });
    await expect(
      service.history(caller, schedule.id, { limit: 20 })
    ).rejects.toThrow("Schedule not found");
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("preserves nullable thread correlation without returning private run data", async () => {
    listRuns.mockResolvedValue([run, { ...run, id: "row-b", stateKey: null }]);
    const result = await service.history(caller, schedule.id, { limit: 20 });
    expect(result.runs.map((item) => item.stateKey)).toEqual(["slot-a", null]);
    expect(result.runs[0]).not.toHaveProperty("requestedBy");
    expect(result.runs[0]).not.toHaveProperty("errorCode");
    expect(loadThread).not.toHaveBeenCalled();
  });

  it("keeps every run even when multiple runs share a thread", async () => {
    listRuns.mockResolvedValue([run, { ...run, id: "row-b", runId: "run-b" }]);
    const result = await service.history(caller, schedule.id, { limit: 20 });
    expect(result.runs.map((item) => item.runId)).toEqual(["run-a", "run-b"]);
    expect(result.nextCursor).toBeNull();
  });

  it("paginates metadata with an extra row and leaves output unloaded", async () => {
    listRuns.mockResolvedValue([run, { ...run, id: "row-b" }]);
    const result = await service.history(caller, schedule.id, { limit: 1 });
    expect(result.runs).toHaveLength(1);
    expect(result.nextCursor).toBe("row-a");
    expect(loadThread).not.toHaveBeenCalled();
  });
});

const session = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: session }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: logger,
    config: { unhandledErrorPolicy: "respond_500" },
    scheduleManager: { getSchedule },
    scheduleRunReader: { listRuns },
    threadPersistenceForUser: () => ({ loadThread }),
  }),
}));

describe("schedule history HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.mockResolvedValue({
      id: caller,
      walletAddress: "0x0000000000000000000000000000000000000001",
    });
    getSchedule.mockResolvedValue(schedule);
    listRuns.mockResolvedValue([]);
  });
  it("requires authentication", async () => {
    session.mockResolvedValue(null);
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        expect((await fetch()).status).toBe(401);
        expect(getSchedule).not.toHaveBeenCalled();
      },
    });
  });
  it("rejects malformed pagination before reading storage", async () => {
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      url: "http://localhost/api/v1/schedules/x/runs?limit=99",
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        expect((await fetch()).status).toBe(400);
        expect(getSchedule).not.toHaveBeenCalled();
      },
    });
  });
  it("returns no-store metadata without fanout to output", async () => {
    listRuns.mockResolvedValue([
      { ...run, id: "44444444-4444-4444-8444-444444444444" },
    ]);
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json();
        expect(body.nextCursor).toBeNull();
        expect(body.runs).toHaveLength(1);
        expect(body.runs[0]).toMatchObject({
          runId: run.runId,
          stateKey: "slot-a",
        });
        expect(body.runs[0]).not.toHaveProperty("messages");
        expect(loadThread).not.toHaveBeenCalled();
      },
    });
  });
  it.each([
    "history",
    "detail",
  ] as const)("rejects invalid %s output without a false success event", async (kind) => {
    listRuns.mockResolvedValue([run]); // Invalid persisted row UUID.
    getSchedule.mockResolvedValue({ ...schedule, graphId: null });
    const appHandler =
      kind === "history"
        ? await import("@/app/api/v1/schedules/[scheduleId]/runs/route")
        : await import("@/app/api/v1/schedules/[scheduleId]/route");
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "Internal server error",
        });
        expect(logger.info).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "success" }),
          expect.anything()
        );
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: "INTERNAL_SERVER_ERROR" }),
          "request failed"
        );
        expect(
          logger.info.mock.calls.length +
            logger.warn.mock.calls.length +
            logger.error.mock.calls.length
        ).toBe(3);
      },
    });
  });
  it("reports history storage failure as an error instead of an empty result", async () => {
    listRuns.mockRejectedValue(new Error("Storage unavailable"));
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id, runId: run.runId },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "Internal server error",
        });
        expect(logger.info).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "success" }),
          expect.anything()
        );
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: "INTERNAL_SERVER_ERROR" }),
          "request failed"
        );
        expect(
          logger.info.mock.calls.length +
            logger.warn.mock.calls.length +
            logger.error.mock.calls.length
        ).toBe(3);
      },
    });
  });
  it("returns the same 404 for unknown and foreign history", async () => {
    getSchedule.mockResolvedValue(null);
    const appHandler = await import(
      "@/app/api/v1/schedules/[scheduleId]/runs/route"
    );
    await testApiHandler({
      appHandler,
      params: { scheduleId: schedule.id },
      test: async ({ fetch }) => {
        expect((await fetch()).status).toBe(404);
        expect(listRuns).not.toHaveBeenCalled();
      },
    });
  });

  it.each([
    { messages: [] },
    {
      messages: [
        {
          id: "assistant-run-a",
          role: "assistant",
          parts: [{ type: "text", text: "Saved result" }],
        },
      ],
    },
  ])("logs validated linked-conversation reads without content", async ({
    messages,
  }) => {
    loadThread.mockResolvedValue(messages);
    const appHandler = await import("@/app/api/v1/ai/threads/[stateKey]/route");
    await testApiHandler({
      appHandler,
      params: { stateKey: "slot-a" },
      test: async ({ fetch }) => {
        const response = await fetch();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ stateKey: "slot-a", messages });
        expect(loadThread).toHaveBeenCalledWith(caller, "slot-a");
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            event: EVENT_NAMES.AI_THREAD_READ,
            messageCount: messages.length,
            outcome: "success",
            stateKey: "slot-a",
          }),
          EVENT_NAMES.AI_THREAD_READ
        );
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
          "Saved result"
        );
      },
    });
  });
});
