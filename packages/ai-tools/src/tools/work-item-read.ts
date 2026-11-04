// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Complete bounded work-item read through the host-injected capability. */
import { z } from "zod";
import type { WorkItemCapability } from "../capabilities/work-item";
import { readSourceProvenance, withoutSourceProvenance } from "../source-url";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";
import { toToolAssignee, WorkItemOutputSchema } from "./work-item-query";

export const WORK_ITEM_READ_NAME = "core__work_item_read" as const;
const Input = z.object({ id: z.string().min(1).max(200) });
const Output = z.object({ item: WorkItemOutputSchema.nullable() });
type Input = z.infer<typeof Input>;
type Output = z.infer<typeof Output>;

export const workItemReadContract: ToolContract<
  typeof WORK_ITEM_READ_NAME,
  Input,
  Output,
  Output
> = {
  name: WORK_ITEM_READ_NAME,
  description:
    "Read one work item completely by exact id. Oversized items fail rather than returning truncated evidence.",
  effect: "read_only",
  inputSchema: Input,
  outputSchema: Output,
  redact: (output) => output,
  allowlist: ["item"] as const,
};

export function createWorkItemReadImplementation(deps: {
  readonly workItemCapability: WorkItemCapability;
  readonly nodePublicOrigin?: string | undefined;
}): ToolImplementation<Input, Output> {
  return {
    async execute({ id }) {
      const items = await deps.workItemCapability.query({
        ids: [id],
        limit: 1,
      });
      const item = items.find((entry) => entry.id === id);
      if (!item) return { item: null };
      const result = {
        ...withoutSourceProvenance(item),
        labels: [...item.labels],
        assignees: item.assignees.map(toToolAssignee),
        specRefs: [...item.specRefs],
        ...readSourceProvenance(deps.nodePublicOrigin, "work/items", item.id),
      };
      if (new TextEncoder().encode(JSON.stringify(result)).length > 65536)
        throw new Error("work_item_read_exceeds_limit");
      return { item: result };
    },
  };
}

export const workItemReadBoundTool: BoundTool<
  typeof WORK_ITEM_READ_NAME,
  Input,
  Output,
  Output
> = {
  contract: workItemReadContract,
  implementation: {
    async execute() {
      throw new Error("WorkItemCapability not configured.");
    },
  },
};
