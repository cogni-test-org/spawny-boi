// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared work query ordering; unknown keys last, id ASC resolves every tie. */
import { rankScore } from "./scores.js";
import type { WorkItem } from "./types.js";

export const WORK_ITEM_SORT_FIELDS = [
  "rankScore",
  "priority",
  "rank",
  "createdAt",
  "updatedAt",
  "type",
  "status",
  "projectId",
  "estimate",
] as const;
export const WORK_ITEM_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type WorkItemSortBy = (typeof WORK_ITEM_SORT_FIELDS)[number];
export type WorkItemSortDirection = (typeof WORK_ITEM_SORT_DIRECTIONS)[number];
export type WorkItemOrder = {
  sortBy: WorkItemSortBy;
  sortDirection: WorkItemSortDirection;
};

export function normalizeWorkItemOrder(
  input: {
    sortBy?: WorkItemSortBy;
    sortDirection?: WorkItemSortDirection;
  } = {},
): WorkItemOrder {
  const sortBy = input.sortBy ?? "rankScore";
  const sortDirection =
    input.sortDirection ??
    (sortBy === "priority" || sortBy === "rank" ? "asc" : "desc");
  if (
    !WORK_ITEM_SORT_FIELDS.includes(sortBy) ||
    !WORK_ITEM_SORT_DIRECTIONS.includes(sortDirection)
  )
    throw new Error("invalid work-item sort");
  return { sortBy, sortDirection };
}

export type WorkItemOrderKey = { value: string | number | undefined; id: string };

export function workItemOrderKey(item: WorkItem, order: WorkItemOrder): WorkItemOrderKey {
  return { value: order.sortBy === "rankScore" ? rankScore(item.scores) : item[order.sortBy], id: item.id };
}

export function compareWorkItemKeys(a: WorkItemOrderKey, b: WorkItemOrderKey, order: WorkItemOrder): number {
  const av = a.value, bv = b.value;
  if (av === undefined && bv !== undefined) return 1;
  if (av !== undefined && bv === undefined) return -1;
  if (av !== undefined && bv !== undefined && av !== bv)
    return (av < bv ? -1 : 1) * (order.sortDirection === "asc" ? 1 : -1);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compareWorkItems(a: WorkItem, b: WorkItem, order: WorkItemOrder): number {
  return compareWorkItemKeys(workItemOrderKey(a, order), workItemOrderKey(b, order), order);
}
