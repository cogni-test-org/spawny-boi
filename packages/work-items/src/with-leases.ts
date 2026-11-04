// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Compose versioned content with one operational lease authority; no dual writers. */
import type { WorkItemLease, WorkItemLeasePort } from "./leases.js";
import type { WorkItem } from "./types.js";
import type { WorkItemsContentPort, WorkItemsPort } from "./content.js";

function project(item: WorkItem, lease: WorkItemLease | undefined): WorkItem {
  const {
    claimedByRun: _run,
    claimedAt: _at,
    lastCommand: _command,
    ...content
  } = item;
  return {
    ...content,
    ...(lease?.active
      ? {
          claimedByRun: lease.runId,
          claimedAt: lease.claimedAt,
          lastCommand: lease.lastCommand,
        }
      : {}),
  };
}

export function withWorkItemLeases(
  content: WorkItemsContentPort,
  leases: WorkItemLeasePort
): WorkItemsPort {
  const projectOne = async (item: WorkItem): Promise<WorkItem> =>
    project(item, (await leases.getMany([item.id])).get(item.id));
  return {
    async get(id) {
      const item = await content.get(id);
      return item ? projectOne(item) : null;
    },
    async list(query) {
      const result = await content.list(query);
      const claims = await leases.getMany(result.items.map((item) => item.id));
      return {
        ...result,
        items: result.items.map((item) => project(item, claims.get(item.id))),
      };
    },
    async create(input, principalId) {
      return content.create(input, principalId);
    },
    async patch(input, principalId) {
      return content.patch(input, principalId);
    },
    delete: (id, principalId) => content.delete(id, principalId),
    async claim(input) {
      if (!(await content.get(input.id)))
        throw new Error(`Work item not found: ${input.id}`);
      return leases.claim(input);
    },
    // These two paths MUST NOT call the content adapter, even on a conflict.
    heartbeat: (input) => leases.heartbeat(input),
    release: (input) => leases.release(input),
  };
}
