// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-capability`
 * Purpose: The AI work-item capability queries the live (Doltgres) backlog when wired, and refuses AI patches
 *   to priority <= 1.
 * Scope: Factory with fake ports. No Doltgres.
 * Invariants: QUERY_READS_THE_LIVE_BACKLOG, COMPLETE_SNAPSHOT (queryPage), WRITES_NOT_WIDENED, P0P1_IS_NODE_ADMIN,
 *   PATCH_ON_THE_LIVE_BACKLOG, PATCH_CAS_PASSTHROUGH.
 * Side-effects: none
 * Links: src/bootstrap/capabilities/work-item.ts, story.5101
 * @internal
 */

import { WorkItemPatchConflictError } from "@cogni/ai-tools";
import { toWorkItemId, type WorkItem, type WorkItemCommandPort, type WorkItemQueryPort } from "@cogni/work-items";
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";
import { describe, expect, it, vi } from "vitest";

import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";

const storedItem: WorkItem = {
  id: toWorkItemId("task.5001"),
  type: "task",
  title: "t",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  labels: [],
  assignees: [],
  externalRefs: [],
  specRefs: [],
  revision: 3,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
  deployVerified: false,
};

const empty = { items: [], pageInfo: { endCursor: null, hasMore: false } };

describe("createWorkItemCapability", () => {
  it("query reads the backlogReader (live backlog), not the markdown port", async () => {
    const markdown = { list: vi.fn().mockResolvedValue(empty), get: vi.fn() };
    const backlog = { list: vi.fn().mockResolvedValue(empty) };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    await cap.query({ statuses: ["needs_implement"] });
    expect(backlog.list).toHaveBeenCalledTimes(1);
    expect(backlog.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
    expect(markdown.list).not.toHaveBeenCalled();
  });

  it("query falls back to the query port when no backlogReader is wired", async () => {
    const markdown = { list: vi.fn().mockResolvedValue(empty), get: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
    });
    await cap.query({ statuses: ["needs_implement"] });
    expect(markdown.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
  });

  it("queryPage pages the live backlog: forwards cursor, returns nextCursor (COMPLETE_SNAPSHOT)", async () => {
    const backlog = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ ...empty, nextCursor: "c1" })
        .mockResolvedValueOnce(empty),
    };
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    if (!cap.queryPage) throw new Error("queryPage missing");
    expect((await cap.queryPage({ limit: 50 })).nextCursor).toBe("c1");
    expect(
      (await cap.queryPage({ limit: 50, cursor: "c1" })).nextCursor
    ).toBeUndefined();
    expect(backlog.list).toHaveBeenLastCalledWith({ limit: 50, cursor: "c1" });
  });

  it("an AI patch to priority <= 1 is refused before any write", async () => {
    const command = { patch: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
    });
    await expect(
      cap.patch({ id: "task.5001", set: { priority: 0 } })
    ).rejects.toThrow("authz_denied");
    expect(command.patch).not.toHaveBeenCalled();
  });

  it("WRITES_NOT_WIDENED: transitionStatus/patch stay on workItemQuery + workItemCommand, never the backlogReader", async () => {
    const item = storedItem;
    const markdown = { list: vi.fn(), get: vi.fn().mockResolvedValue(item) };
    const command = {
      transitionStatus: vi
        .fn()
        .mockResolvedValue({ ...item, status: "done", revision: 4 }),
      patch: vi.fn().mockResolvedValue({
        ...item,
        type: "task",
        title: "t",
        labels: [],
        assignees: [],
      }),
    };
    const backlog = { list: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    await cap.transitionStatus({ id: "task.5001", toStatus: "done" });
    await cap.patch({ id: "task.5001", set: { priority: 3 } });
    expect(markdown.get).toHaveBeenCalledTimes(2);
    expect(command.transitionStatus).toHaveBeenCalledTimes(1);
    expect(command.patch).toHaveBeenCalledTimes(1);
    expect(backlog.list).not.toHaveBeenCalled();
  });

  it("PATCH_CAS_PASSTHROUGH: the backlogWriter gets expectedRevision + rank; its conflict becomes WorkItemPatchConflictError", async () => {
    const row = {
      ...storedItem,
      id: "task.5001",
      type: "task",
      title: "t",
      status: "needs_implement",
      labels: [],
      assignees: [],
      revision: 8,
    };
    const store = {
      patch: vi
        .fn()
        .mockResolvedValueOnce(row)
        .mockRejectedValueOnce(
          new WorkItemRevisionConflictError("task.5001", 7, 9)
        ),
    };
    const command = { patch: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
      backlogWriter: { store, principalId: "system" },
    });
    expect(
      (
        await cap.patch({
          id: "task.5001",
          expectedRevision: 7,
          set: { rank: 2 },
        })
      ).revision
    ).toBe(8);
    expect(store.patch).toHaveBeenLastCalledWith(
      { id: "task.5001", expectedRevision: 7, set: { rank: 2 } },
      "system"
    );
    const lost = cap.patch({
      id: "task.5001",
      expectedRevision: 7,
      set: { rank: 3 },
    });
    await expect(lost).rejects.toBeInstanceOf(WorkItemPatchConflictError);
    await expect(lost).rejects.toMatchObject({
      expectedRevision: 7,
      currentRevision: 9,
    });
    expect(command.patch).not.toHaveBeenCalled();
  });

  it("the markdown fallback refuses a caller expectedRevision instead of dropping it", async () => {
    const command = { patch: vi.fn() };
    const markdown = { list: vi.fn(), get: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
    });
    await expect(
      cap.patch({ id: "task.5001", expectedRevision: 7, set: { rank: 2 } })
    ).rejects.toThrow("expectedRevision requires the Doltgres backlog writer");
    expect(markdown.get).not.toHaveBeenCalled();
    expect(command.patch).not.toHaveBeenCalled();
  });
  it("attributes score writes to each invocation's actor and reads every score back", async () => {
    const scores = Object.fromEntries(
      ["goal", "time", "unblocks", "ease", "confidence", "agent"].map(
        (axis) => [axis, { v: 4, ev: "https://external.example/proof" }]
      )
    );
    const row = {
      ...storedItem,
      id: "task.5001",
      type: "task",
      title: "t",
      status: "needs_implement",
      labels: [],
      assignees: [],
      revision: 8,
      scores,
    };
    const store = { patch: vi.fn().mockResolvedValue(row) };
    let actor = "authenticated-user-a";
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogReader: {
        list: vi.fn().mockResolvedValue({ ...empty, items: [row] }),
      } as unknown as Pick<WorkItemQueryPort, "list">,
      backlogWriter: { store, principalId: () => actor },
    });
    expect(
      (await cap.patch({ id: row.id, expectedRevision: 7, set: { scores } }))
        .scores
    ).toEqual(scores);
    expect(store.patch).toHaveBeenLastCalledWith(
      { id: row.id, expectedRevision: 7, set: { scores } },
      "authenticated-user-a"
    );
    actor = "scheduled-grant-user-b";
    await cap.patch({ id: row.id, set: { scores } });
    expect(store.patch).toHaveBeenLastCalledWith(
      { id: row.id, set: { scores } },
      "scheduled-grant-user-b"
    );
    const readback = (await cap.query({ ids: [row.id] }))[0];
    expect(readback?.scores).toEqual(scores);
    expect(readback?.rankScore).toBe(6.4);
  });

  it("a missing authenticated run actor fails before the live store writes", async () => {
    const store = { patch: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: {} as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogWriter: {
        store,
        principalId: () => {
          throw new Error("authenticated run actorUserId is required");
        },
      },
    });
    await expect(
      cap.patch({ id: "task.5001", set: { scores: { goal: { v: 3 } } } })
    ).rejects.toThrow("actorUserId is required");
    expect(store.patch).not.toHaveBeenCalled();
  });
});
