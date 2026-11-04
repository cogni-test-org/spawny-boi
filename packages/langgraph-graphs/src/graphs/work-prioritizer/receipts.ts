// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Per-run observations from the authorized ToolRunner, shared by parent and children. */
import { createHash } from "node:crypto";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";

const Goal = z.object({
  id: z.string(),
  content: z.string(),
  sourceUrl: z.string().url().optional(),
});
const Item = z.object({
  id: z.string(),
  status: z.string(),
  revision: z.number().int(),
  labels: z.array(z.string()),
  type: z.string(),
  createdAt: z.string(),
  branch: z.string().optional(),
  pr: z.string().optional(),
  blockedBy: z.string().optional(),
  outcome: z.string().optional(),
  summary: z.string().optional(),
  specRefs: z.array(z.string()).optional(),
  sourceUrl: z.string().url().optional(),
  scores: z
    .record(
      z.string(),
      z.object({ v: z.number().int(), ev: z.string().optional() }),
    )
    .optional(),
});
const Guidance = z.object({ id: z.string(), content: z.string() });

export type ObservedItem = z.infer<typeof Item>;
export interface ReadReceipt {
  readonly id: string;
  readonly sourceId: string;
  readonly url: string;
  readonly sha256: string;
  readonly content: string;
}

export class RunReceipts {
  readonly goals = new Map<string, z.infer<typeof Goal>>();
  readonly items = new Map<string, ObservedItem>();
  readonly sources = new Map<string, ReadReceipt>();
  readonly guidance = new Set<string>();
  readonly reportMessages: BaseMessage[] = [];
  denied = false;

  constructor(private readonly origin: string) {}

  recordTool(name: string, args: unknown, value: unknown, toolCallId?: string) {
    const id = toolCallId ?? `observed-${this.reportMessages.length}`;
    const parsedArgs = z.record(z.string(), z.unknown()).safeParse(args);
    this.reportMessages.push(
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id,
            name,
            args: parsedArgs.success ? parsedArgs.data : {},
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({
        name,
        tool_call_id: id,
        content: JSON.stringify(value),
      }),
    );
  }

  private addSource(id: string, url: string | undefined, content: string) {
    if (!url || new TextEncoder().encode(content).length > 65_536) return;
    const sha256 = createHash("sha256").update(content).digest("hex");
    this.sources.set(url, {
      id: `${id}:${sha256}`,
      sourceId: id,
      url,
      sha256,
      content,
    });
  }

  observe(name: string, args: unknown, value: unknown) {
    if (name === "core__goal_list") {
      const parsed = z.object({ goals: z.array(Goal) }).safeParse(value);
      if (!parsed.success) {
        this.denied = true;
        return;
      }
      for (const goal of parsed.data.goals) {
        this.goals.set(goal.id, goal);
        this.addSource(goal.id, goal.sourceUrl, goal.content);
      }
    }
    if (name === "core__work_item_read") {
      const parsed = z.object({ item: Item.nullable() }).safeParse(value);
      if (!parsed.success || !parsed.data.item) {
        this.denied = true;
        return;
      }
      const item = parsed.data.item;
      this.items.set(item.id, item);
      this.addSource(item.id, item.sourceUrl, JSON.stringify(item));
    }
    if (name === "core__knowledge_read") {
      const input = z.object({ id: z.string() }).safeParse(args);
      const output = z
        .object({ mode: z.literal("get"), entries: z.array(Guidance) })
        .safeParse(value);
      if (!input.success || !output.success) return;
      const entry = output.data.entries.find((row) => row.id === input.data.id);
      if (
        !entry?.content.trim() ||
        new TextEncoder().encode(entry.content).length > 65_536
      ) {
        this.denied = true;
        return;
      }
      this.guidance.add(entry.id);
      this.addSource(
        entry.id,
        `${this.origin.replace(/\/$/, "")}/knowledge/${encodeURIComponent(entry.id)}`,
        entry.content,
      );
    }
  }
}
