// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Versioned order-bound keyset. The native SQL projection owns the exact key. */
import { createHash } from "node:crypto";
import {
  normalizeWorkItemOrder,
  type WorkItemOrder,
} from "../../query-order.js";
import type { WorkQuery } from "../../types.js";

export function queryIdentity(query: WorkQuery = {}): string {
  if ((query.rankMin !== undefined && !Number.isFinite(query.rankMin)) || (query.rankMax !== undefined && !Number.isFinite(query.rankMax)) || (query.rankMin !== undefined && query.rankMax !== undefined && query.rankMin > query.rankMax)) throw new Error("invalid rank range");
  const anyOf = (v: readonly string[] | undefined) =>
    v?.length ? [...new Set(v)].sort() : undefined;
  const node = typeof query.node === "string" ? (query.node ? [query.node] : undefined) : query.node;
  const normalized = {
    ids: anyOf(query.ids),
    types: anyOf(query.types),
    statuses: anyOf(query.statuses),
    projectId: query.projectId || undefined,
    projectIds: anyOf(query.projectIds),
    node: anyOf(node),
    labels: anyOf(query.labels),
    labelPrefix: query.labelPrefix || undefined,
    text: query.text?.toLowerCase() || undefined,
    actor: query.actor === "either" ? undefined : query.actor,
    scored: query.scored,
    rankMin: query.rankMin,
    rankMax: query.rankMax,
    assignee: query.assignee && (query.assignee.kind === "user" ? { kind: "user", userId: query.assignee.userId } : query.assignee.kind === "agent" ? { kind: "agent", agentId: query.assignee.agentId } : { kind: "system", serviceId: query.assignee.serviceId }),
    relatedTo: query.relatedTo,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
export class InvalidCursorError extends Error {
  constructor(message = "invalid_cursor: restart pagination without a cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}
export type WorkItemCursor = WorkItemOrder & {
  v: 2;
  filter: string;
  key: string | null;
  keyRef?: string;
  id: string;
};
export function encodeCursor(cursor: WorkItemCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
export function decodeCursor(
  raw: string,
  order: WorkItemOrder | undefined,
  filter: string,
): WorkItemCursor {
  try {
    if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw))
      throw new Error();
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      !value ||
      value.v !== 2 ||
      typeof value.filter !== "string" ||
      value.filter !== filter ||
      typeof value.id !== "string" ||
      !value.id ||
      value.id.length > 200 ||
      !(value.key === null || typeof value.key === "string") ||
      value.key?.length > 1000 ||
      (value.keyRef !== undefined && (value.sortBy !== "projectId" || value.key !== null || typeof value.keyRef !== "string" || !/^[a-f0-9]{64}$/.test(value.keyRef)))
    )
      throw new Error();
    const normalized = normalizeWorkItemOrder(value);
    if (
      normalized.sortBy !== value.sortBy ||
      normalized.sortDirection !== value.sortDirection
    )
      throw new Error();
    if (
      order &&
      (order.sortBy !== value.sortBy ||
        order.sortDirection !== value.sortDirection)
    )
      throw new Error();
    if (value.key !== null) {
      if (value.sortBy === "createdAt" || value.sortBy === "updatedAt") {
        if (
          !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)?$/.test(
            value.key,
          ) ||
          !Number.isFinite(Date.parse(value.key))
        )
          throw new Error();
      } else if (["type", "status", "projectId"].includes(value.sortBy)) {
        if (!value.key || value.key.length > 1000) throw new Error();
      } else if (
        !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.key) ||
        !Number.isFinite(Number(value.key))
      )
        throw new Error();
    }
    return {
      v: 2,
      filter: value.filter,
      ...normalized,
      key: value.key,
      ...(value.keyRef !== undefined && { keyRef: value.keyRef }),
      id: value.id,
    };
  } catch {
    throw new InvalidCursorError();
  }
}
