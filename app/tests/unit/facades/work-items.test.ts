// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-items`
 * Purpose: Unit test for work items facade — verifies DTO mapping and port delegation.
 * Scope: Mocks container and WorkItemQueryPort. Tests listWorkItems and getWorkItem.
 * Invariants: PORT_VIA_CONTAINER, CONTRACTS_ARE_TRUTH
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts
 * @internal
 */

import {
  WorkItemDtoSchema,
  workItemsListOperation
} from "@cogni/node-contracts";
import type { WorkItem, WorkItemQueryPort } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the container
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn()
}));

import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  NodeAdminRequiredError,
  patchWorkItem,
  WorkItemWriteOutcomeUnknownError
} from "@/app/_facades/work/items.server";
import { getContainer } from "@/bootstrap/container";

const mockGetContainer = vi.mocked(getContainer);

const SAMPLE_WORK_ITEM: WorkItem = {
  id: toWorkItemId("task.0001"),
  type: "task",
  title: "Sample task",
  status: "needs_implement",
  priority: 1,
  rank: 5,
  estimate: 3,
  summary: "A test summary",
  outcome: "Expected outcome",
  projectId: toWorkItemId("proj.test"),
  parentId: undefined,
  assignees: [{ kind: "user", userId: "u1" }],
  externalRefs: [{ system: "github", kind: "pr" }],
  labels: ["test", "api"],
  specRefs: ["architecture-spec"],
  branch: "feat/task-0001",
  pr: undefined,
  reviewer: undefined,
  revision: 2,
  blockedBy: undefined,
  deployVerified: false,
  claimedByRun: undefined,
  claimedAt: undefined,
  lastCommand: undefined,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02"
};

function createMockPort(): WorkItemQueryPort {
  return {
    list: vi.fn(),
    get: vi.fn()
  };
}

type DoltgresMock = {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

function createDoltgresMock(): DoltgresMock {
  // Default is genuinely unconfigured, so Markdown owns this fixture.
  return {
    list: vi.fn().mockRejectedValue(
      Object.assign(new Error("unconfigured"), {
        name: "DoltgresNotConfiguredError"
      })
    ),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn()
  };
}

describe("app/_facades/work/items.server", () => {
  let mockPort: ReturnType<typeof createMockPort>;
  let mockDoltgres: DoltgresMock;

  beforeEach(() => {
    vi.resetAllMocks();
    mockPort = createMockPort();
    mockDoltgres = createDoltgresMock();
    mockGetContainer.mockReturnValue({
      workItemQuery: mockPort,
      doltgresWorkItems: mockDoltgres
    } as never);
  });

  it("preserves the current write uncertainty receipt instead of converting it to backend busy", async () => {
    const error = Object.assign(new Error("inspect current branch"), {
      name: "WorkItemWriteOutcomeUnknownError",
      operationId: "operation-1",
      branch: "work-item-op/one",
      commitHash: "hash-1",
      itemId: "task.0001"
    });
    mockDoltgres.create.mockRejectedValue(error);
    await expect(
      createWorkItem(
        { type: "task", title: "unknown result" },
        { id: "principal-1" }
      )
    ).rejects.toMatchObject({
      name: "WorkItemWriteOutcomeUnknownError",
      code: "work_item_write_outcome_unknown",
      retryable: false,
      receipt: {
        lookup: {
          operationId: "operation-1",
          branch: "work-item-op/one",
          commitHash: "hash-1",
          itemId: "task.0001"
        }
      }
    });
    const receipt = new WorkItemWriteOutcomeUnknownError(
      "operation-1",
      "work-item-op/one"
    );
    expect(receipt.receipt.lookup.commitHash).toBeNull();
  });

  describe("listWorkItems", () => {
    it("uses configured Dolt alone, including an empty result", async () => {
      mockDoltgres.list.mockResolvedValue({
        items: [],
        pageInfo: { endCursor: null, hasMore: false }
      });
      await expect(
        listWorkItems({ sortBy: "rankScore", sortDirection: "desc" })
      ).resolves.toMatchObject({ items: [] });
      expect(mockPort.list).not.toHaveBeenCalled();
      expect(mockDoltgres.list).toHaveBeenCalledWith({
        sortBy: "rankScore",
        sortDirection: "desc",
        limit: 100
      });
    });
    it("never masks configured outages with markdown", async () => {
      mockDoltgres.list.mockRejectedValue(
        Object.assign(new Error("busy"), { name: "WorkItemsBusyError" })
      );
      await expect(listWorkItems({})).rejects.toThrow("busy");
      expect(mockPort.list).not.toHaveBeenCalled();
    });

    it("returns items mapped to contract-compliant DTOs", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined
      });

      const result = await listWorkItems({});

      expect(result.items).toHaveLength(1);
      // Verify contract compliance
      expect(() => workItemsListOperation.output.parse(result)).not.toThrow();
    });

    it("maps WorkItem fields to DTO fields correctly", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined
      });

      const result = await listWorkItems({});
      const dto = result.items[0];

      expect(dto).toBeDefined();
      expect(dto?.id).toBe("task.0001");
      expect(dto?.type).toBe("task");
      expect(dto?.title).toBe("Sample task");
      expect(dto?.status).toBe("needs_implement");
      expect(dto?.priority).toBe(1);
      expect(dto?.rank).toBe(5);
      expect(dto?.estimate).toBe(3);
      expect(dto?.projectId).toBe("proj.test");
      expect(dto?.assignees).toEqual([{ kind: "user", userId: "u1" }]);
      expect(dto?.labels).toEqual(["test", "api"]);
      expect(dto?.revision).toBe(2);
      expect(dto?.deployVerified).toBe(false);
      expect(dto?.createdAt).toBe("2026-01-01");
      expect(dto?.updatedAt).toBe("2026-01-02");
    });

    it("DTO passes schema validation", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined
      });

      const result = await listWorkItems({});
      const dto = result.items[0];
      expect(dto).toBeDefined();
      expect(() => WorkItemDtoSchema.parse(dto)).not.toThrow();
    });

    it("passes filter params to port", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined
      });

      await listWorkItems({
        types: ["task", "bug"],
        statuses: ["needs_implement"],
        text: "search",
        projectId: "proj.test",
        limit: 50
      });

      expect(mockPort.list).toHaveBeenCalledWith({
        types: ["task", "bug"],
        statuses: ["needs_implement"],
        text: "search",
        projectId: toWorkItemId("proj.test"),
        limit: 50
      });
    });

    it("omits undefined filter params from port query", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined
      });

      await listWorkItems({});

      expect(mockPort.list).toHaveBeenCalledWith({ limit: 100 });
    });

    it("keeps the default 100-row Markdown page and its continuation", async () => {
      const rows = Array.from({length: 101}, (_, i) => ({...SAMPLE_WORK_ITEM, id: toWorkItemId(`task.${i}`)}));
      vi.mocked(mockPort.list).mockImplementation(async query => {
        const offset = query?.cursor === "md-next" ? 100 : 0;
        const limit = query?.limit ?? rows.length;
        return {items: rows.slice(offset, offset + limit), ...(offset + limit < rows.length && {nextCursor: "md-next"})};
      });
      const first = await listWorkItems({});
      expect(first.items).toHaveLength(100);
      expect(first.pageInfo).toEqual({endCursor: "md-next", hasMore: true});
      const second = await listWorkItems({cursor: first.nextCursor});
      expect(second.items).toHaveLength(1);
      expect(second.pageInfo).toEqual({endCursor: null, hasMore: false});
    });

    it("returns empty items for empty result", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined
      });

      const result = await listWorkItems({});
      expect(result.items).toEqual([]);
    });

    it("passes through nextCursor and pageInfo from doltgres", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined
      });
      mockDoltgres.list.mockResolvedValue({
        items: [],
        pageInfo: { endCursor: "cursor-xyz", hasMore: true }
      });

      const result = await listWorkItems({});
      expect(result.pageInfo).toEqual({
        endCursor: "cursor-xyz",
        hasMore: true
      });
      expect(result.nextCursor).toBe("cursor-xyz");
    });

    it("forwards cursor to doltgres and skips markdown source", async () => {
      mockDoltgres.list.mockResolvedValue({
        items: [],
        pageInfo: { endCursor: null, hasMore: false }
      });

      await listWorkItems({ cursor: "encoded-cursor" });

      expect(mockPort.list).not.toHaveBeenCalled();
      expect(mockDoltgres.list).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "encoded-cursor" })
      );
    });
  });

  describe("getWorkItem", () => {
    it("returns DTO for existing item", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(SAMPLE_WORK_ITEM);

      const result = await getWorkItem("task.0001");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("task.0001");
      expect(result?.title).toBe("Sample task");
      expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    });

    it("omits scores when the item has none (story.5111)", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(SAMPLE_WORK_ITEM);

      const result = await getWorkItem("task.0001");

      expect(result && "scores" in result).toBe(false);
    });

    it("passes scores through to the DTO (story.5111)", async () => {
      const scores = {
        goal: { v: 5, ev: "https://cognidao.org/work/items/story.5108" },
        ease: { v: 3 }
      };
      vi.mocked(mockPort.get).mockResolvedValue({
        ...SAMPLE_WORK_ITEM,
        scores
      });

      const result = await getWorkItem("task.0001");

      expect(result?.scores).toEqual(scores);
      expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    });

    it("returns null for non-existent item", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(null);

      const result = await getWorkItem("task.9999");

      expect(result).toBeNull();
    });

    it("calls port with branded WorkItemId", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(null);

      await getWorkItem("task.0001");

      expect(mockPort.get).toHaveBeenCalledWith(toWorkItemId("task.0001"));
    });
  });
});

describe("P0P1_IS_NODE_ADMIN — priority <= 1 needs node admin (story.5101)", () => {
  const doltgres = () => ({
    create: vi.fn().mockResolvedValue(SAMPLE_WORK_ITEM),
    patch: vi.fn().mockResolvedValue(SAMPLE_WORK_ITEM)
  });
  const withAuthority = (ok: boolean) => {
    const store = doltgres();
    mockGetContainer.mockReturnValue({
      doltgresWorkItems: store,
      log: { warn: vi.fn() },
      nodeAdmin: {
        check: async () =>
          ok ? { ok: true } : { ok: false, errorCode: "authz_denied" }
      }
    } as never);
    return store;
  };

  it("a non-admin patch to p0 (or p1) is refused 403 before the store write", async () => {
    for (const priority of [0, 1]) {
      const store = withAuthority(false);
      const err = await patchWorkItem(
        { id: "task.5001", set: { priority } } as never,
        { id: "agent-1", walletAddress: null }
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeAdminRequiredError);
      expect((err as NodeAdminRequiredError).status).toBe(403);
      expect(store.patch).not.toHaveBeenCalled();
    }
  });

  it("a non-admin create at p1 is refused; p2 is open", async () => {
    const store = withAuthority(false);
    await expect(
      createWorkItem({ type: "task", title: "t", priority: 1 } as never, {
        id: "agent-1"
      })
    ).rejects.toBeInstanceOf(NodeAdminRequiredError);
    expect(store.create).not.toHaveBeenCalled();
    await createWorkItem({ type: "task", title: "t", priority: 2 } as never, {
      id: "agent-1"
    });
    expect(store.create).toHaveBeenCalledTimes(1);
  });

  it("the node admin may set p0", async () => {
    const store = withAuthority(true);
    await patchWorkItem({ id: "task.5001", set: { priority: 0 } } as never, {
      id: "u1",
      walletAddress: "0xabc"
    });
    expect(store.patch).toHaveBeenCalledTimes(1);
  });
});
