// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import type {
  WorkItemCapability,
  WorkItemInfo,
} from "../src/capabilities/work-item";
import { createWorkItemReadImplementation, workItemReadContract } from "../src/tools/work-item-read";

const item: WorkItemInfo = {
  id: "task.0018",
  type: "task",
  title: "Review",
  status: "needs_closeout",
  labels: ["goal:one"],
  assignees: [{ kind: "agent", id: "agent-1" }],
  externalRefs: [],
  specRefs: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deployVerified: true,
  revision: 12,
  outcome: "x".repeat(1000),
};

function reader(current: WorkItemInfo) {
  const capability: WorkItemCapability = {
    query: async ({ ids }) => (ids?.includes(current.id) ? [current] : []),
    transitionStatus: async () => {
      throw new Error("unexpected write");
    },
    patch: async () => {
      throw new Error("unexpected write");
    },
  };
  return createWorkItemReadImplementation({
    workItemCapability: capability,
    nodePublicOrigin: "https://node.example",
  });
}

describe("full work item read", () => {
  it("returns complete long outcomes and exact revisions, or fails when oversized", async () => {
    const result = await reader(item).execute({ id: item.id });
    expect(result.item?.outcome).toBe(item.outcome);
    expect(result.item?.revision).toBe(12);
    expect(workItemReadContract.outputSchema.safeParse(result).success).toBe(true);
    expect(result.item?.assignees).toEqual([{ kind: "agent", id: "agent-1", agentId: "agent-1" }]);
    expect(result.item?.sourceUrl).toBe(
      "https://node.example/work/items/task.0018",
    );
    await expect(
      reader({ ...item, outcome: "x".repeat(65537) }).execute({ id: item.id }),
    ).rejects.toThrow("work_item_read_exceeds_limit");
    expect(
      (await reader(item).execute({ id: "task.missing" })).item,
    ).toBeNull();
  });
});
