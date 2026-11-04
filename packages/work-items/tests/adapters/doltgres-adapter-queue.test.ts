// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Reads have no writer admission path; leases cannot call versioned content. */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { toWorkItemId, type WorkItemLeasePort } from "../../src/index.js";
import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import { withWorkItemLeases } from "../../src/with-leases.js";
import type { WorkItemsContentPort } from "../../src/adapters/doltgres/ports.js";

it("rejects a shared read/write pool before executing SQL", () => {
  const pool = { unsafe: vi.fn() } as unknown as Sql;
  expect(() => new DoltgresWorkItemAdapter(pool, { readClient: pool })).toThrow(
    /separate pools/
  );
  expect(pool.unsafe).not.toHaveBeenCalled();
});

it("derived/recreated readers cannot return the writer pool", async () => {
  const writer = { unsafe: vi.fn() } as unknown as Sql;
  const adapter = new DoltgresWorkItemAdapter(writer, {
    recreateReadClient: () => writer,
  });
  await expect(adapter.get(toWorkItemId("task.0001"))).rejects.toMatchObject({
    name: "WorkItemsBusyError",
  });
  expect(writer.unsafe).not.toHaveBeenCalled();
});

it("all concurrent read methods never reserve, lock, checkout, reconcile, or query writer", async () => {
  const write = {
    unsafe: vi.fn(() => {
      throw new Error("writer must stay untouched");
    }),
    reserve: vi.fn(),
  } as unknown as Sql;
  const read = {
    options: { max: 1 },
    unsafe: vi.fn(async () => []),
  } as unknown as Sql;
  const adapter = new DoltgresWorkItemAdapter(write, { readClient: read });
  // Keep each healthy fanout within the declared bounded reader queue; all
  // 300 method calls still prove the independent, lock-free reader surface.
  for (let batch = 0; batch < 10; batch++)
    await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.all([
          adapter.list(),
          adapter.get(toWorkItemId("task.0001")),
          adapter.listRelations(toWorkItemId("task.0001")),
        ])
      )
    );
  expect(write.unsafe).not.toHaveBeenCalled();
  expect(write.reserve).not.toHaveBeenCalled();
  expect(read.unsafe).toHaveBeenCalledTimes(300);
  expect(read.unsafe).not.toHaveBeenCalledWith(
    expect.stringMatching(/dolt_|advisory/)
  );
});

describe("lease/content composition", () => {
  it("heartbeat and release never read Dolt, including errors", async () => {
    const content = {
      get: vi.fn(() => {
        throw new Error("Dolt unavailable");
      }),
    } as unknown as WorkItemsContentPort;
    const leases = {
      heartbeat: vi.fn(async () => {
        throw new Error("conflict");
      }),
      release: vi.fn(async () => ({ active: false })),
    } as unknown as WorkItemLeasePort;
    const adapter = withWorkItemLeases(content, leases);
    const input = {
      id: toWorkItemId("task.0001"),
      principalId: "p",
      runId: "r",
      leaseToken: "token",
    };
    await expect(adapter.heartbeat(input)).rejects.toThrow("conflict");
    await expect(adapter.release(input)).resolves.toMatchObject({
      active: false,
    });
    expect(content.get).not.toHaveBeenCalled();
  });

  it("ignores legacy Dolt claims and projects PostgreSQL authority in one page batch", async () => {
    const item = {
      id: toWorkItemId("task.0001"),
      claimedByRun: "obsolete",
      claimedAt: "old",
      lastCommand: "old",
    };
    const content = {
      list: vi.fn(async () => ({
        items: [item],
        pageInfo: { endCursor: null, hasMore: false },
      })),
    } as unknown as WorkItemsContentPort;
    const leases = {
      getMany: vi.fn(async () => new Map()),
    } as unknown as WorkItemLeasePort;
    const page = await withWorkItemLeases(content, leases).list();
    expect(page.items[0]?.claimedByRun).toBeUndefined();
    expect(page.items[0]?.lastCommand).toBeUndefined();
    expect(leases.getMany).toHaveBeenCalledExactlyOnceWith([item.id]);
  });
  it("content mutation success never depends on PostgreSQL hydration", async () => {
    const item = { id: toWorkItemId("task.0001"), title: "committed" };
    const content = {
      create: vi.fn(async () => item),
      patch: vi.fn(async () => item),
    } as unknown as WorkItemsContentPort;
    const leases = {
      getMany: vi.fn(async () => {
        throw new Error("PostgreSQL unavailable");
      }),
    } as unknown as WorkItemLeasePort;
    const adapter = withWorkItemLeases(content, leases);
    await expect(
      adapter.create({ type: "task", title: "committed" }, "p")
    ).resolves.toBe(item);
    await expect(
      adapter.patch({ id: item.id, set: { title: "committed" } }, "p")
    ).resolves.toBe(item);
    expect(leases.getMany).not.toHaveBeenCalled();
  });
});

it("a timed-out reader retains real native capacity and cannot spawn a third generation", async () => {
  vi.useFakeTimers();
  try {
    const writer = { unsafe: vi.fn() } as unknown as Sql;
    const closes: Array<() => void> = [];
    const outcomes: Array<(rows: []) => void> = [];
    const builds: Sql[] = [];
    const factory = () => {
      const reader = {
        options: { max: 1 },
        unsafe: vi.fn(
          () => new Promise<[]>((resolve) => outcomes.push(resolve))
        ),
        end: vi.fn(() => new Promise<void>((resolve) => closes.push(resolve))),
      } as unknown as Sql;
      builds.push(reader);
      return reader;
    };
    const adapter = new DoltgresWorkItemAdapter(writer, {
      readClient: factory(),
      recreateReadClient: factory,
      queryTimeoutMs: 100,
      readConnectionBudget: 2,
    });
    const first = adapter.list().catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ name: "WorkItemsBusyError" });
    expect(builds[0]?.end).not.toHaveBeenCalled();
    const second = adapter.list().catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toMatchObject({ name: "WorkItemsBusyError" });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "work_items_native_capacity_held",
    });
    expect(builds).toHaveLength(2);
    expect(builds[1]?.end).not.toHaveBeenCalled();
    outcomes[0]?.([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(builds[0]?.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    // Even a completed query does not free a generation until idle shutdown
    // has completed; neither timeout nor end invocation is a capacity receipt.
    await expect(adapter.list()).rejects.toMatchObject({
      code: "work_items_native_capacity_held",
    });
    closes[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    const third = adapter.list().catch((error) => error);
    expect(builds).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(100);
    await third;
    for (const resolve of outcomes) resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    for (const close of closes) close();
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.unsafe).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("validates declared generation connection budgets using public pool options", () => {
  const writer = { unsafe: vi.fn() } as unknown as Sql;
  const read = { unsafe: vi.fn(), options: { max: 5 } } as unknown as Sql;
  expect(
    () =>
      new DoltgresWorkItemAdapter(writer, {
        readClient: read,
        readConnectionBudget: 4,
      })
  ).toThrow(/readConnectionBudget/);
});

it("rejects unknown widths under an explicit budget and destroys only a fresh rejected factory candidate", async () => {
  const writer = { unsafe: vi.fn(), end: vi.fn() } as unknown as Sql;
  expect(
    () =>
      new DoltgresWorkItemAdapter(writer, {
        readClient: { unsafe: vi.fn() } as unknown as Sql,
        readConnectionBudget: 2,
      })
  ).toThrow(/readConnectionBudget/);
  const candidate = {
    unsafe: vi.fn(),
    end: vi.fn(async () => undefined),
    options: { max: 3 },
  } as unknown as Sql;
  const adapter = new DoltgresWorkItemAdapter(writer, {
    recreateReadClient: () => candidate,
    readConnectionBudget: 2,
  });
  await expect(adapter.list()).rejects.toMatchObject({
    name: "WorkItemsBusyError",
  });
  expect(candidate.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
  await expect(adapter.list()).rejects.toMatchObject({
    name: "WorkItemsBusyError",
  });
  expect(candidate.end).toHaveBeenCalledTimes(1);
  expect(writer.end).not.toHaveBeenCalled();
});
