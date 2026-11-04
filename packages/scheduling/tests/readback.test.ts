// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it, vi } from "vitest";
import {
  createScheduleHistoryService,
  ScheduleHistoryNotFoundError,
  type ScheduleRunSummary,
} from "../src/index.js";
import { presentScheduleRun } from "../src/presentation.js";

const run: ScheduleRunSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  runId: "execution-1",
  stateKey: "conversation-1",
  status: "success",
  scheduledFor: "2026-10-25T00:00:00.000Z",
  startedAt: "2026-10-25T00:00:10.000Z",
  completedAt: "2026-10-25T00:01:15.000Z",
};

describe("published scheduling boundary", () => {
  it("checks schedule ownership before invoking the reader", async () => {
    const listRuns = vi.fn();
    const service = createScheduleHistoryService({
      getSchedule: async () => ({
        id: "schedule",
        ownerUserId: "someone-else",
      }),
      reader: { listRuns },
    });
    await expect(
      service.history("caller", "schedule", { limit: 20 })
    ).rejects.toBeInstanceOf(ScheduleHistoryNotFoundError);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("keeps repeated conversation rows and emits only a bounded page", async () => {
    const rows = [run, { ...run, id: "33333333-3333-4333-8333-333333333333" }];
    const service = createScheduleHistoryService({
      getSchedule: async () => ({ id: "schedule", ownerUserId: "caller" }),
      reader: { listRuns: async () => rows },
    });
    expect(await service.history("caller", "schedule", { limit: 1 })).toEqual({
      runs: [run],
      nextCursor: run.id,
    });
    expect(
      (await service.history("caller", "schedule", { limit: 20 })).runs
    ).toHaveLength(2);
  });

  it.each([0, 51, 1.5, Number.NaN])(
    "rejects limit %s before storage",
    async (limit) => {
      const getSchedule = vi.fn();
      const listRuns = vi.fn();
      const service = createScheduleHistoryService({
        getSchedule,
        reader: { listRuns },
      });
      await expect(
        service.history("caller", "schedule", { limit })
      ).rejects.toThrow();
      expect(getSchedule).not.toHaveBeenCalled();
      expect(listRuns).not.toHaveBeenCalled();
    }
  );

  it("does not turn query errors into empty history", async () => {
    const failure = new Error("database unavailable");
    const service = createScheduleHistoryService({
      getSchedule: async () => ({ id: "schedule", ownerUserId: "caller" }),
      reader: {
        listRuns: async () => {
          throw failure;
        },
      },
    });
    await expect(
      service.history("caller", "schedule", { limit: 20 })
    ).rejects.toBe(failure);
  });

  it("presents actual execution duration, runtime status and nullable correlation", () => {
    expect(
      presentScheduleRun(run, { timezone: "UTC", locale: "en-US" })
    ).toMatchObject({
      id: run.id,
      statusLabel: "Completed",
      durationLabel: "1m 05s",
      exactScheduledFor: run.scheduledFor,
      conversationKey: "conversation-1",
    });
    expect(
      presentScheduleRun(
        {
          ...run,
          stateKey: null,
          startedAt: null,
          completedAt: null,
          status: "skipped",
        },
        { timezone: "UTC" }
      )
    ).toMatchObject({
      statusLabel: "Skipped",
      durationLabel: "—",
      conversationKey: null,
    });
    expect(
      presentScheduleRun(
        { ...run, completedAt: null, status: "running" },
        { timezone: "UTC" }
      ).durationLabel
    ).toBe("…");
  });
});
