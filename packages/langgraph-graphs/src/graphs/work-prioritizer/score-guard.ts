// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Scores-only guard; domain authority remains the host-bound ToolRunner writer. */
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import type { ObservedItem, RunReceipts } from "./receipts";

const axes = [
  "goal",
  "time",
  "unblocks",
  "ease",
  "confidence",
  "agent",
] as const;
const proposal = z.object({
  id: z.string().min(1),
  expectedRevision: z.number().int().min(0),
  scores: z.record(
    z.enum(axes),
    z.object({ v: z.number().int().min(0).max(5), ev: z.string().optional() }),
  ),
});

function constrained(axis: string, value: number, item: ObservedItem): number {
  if (axis === "agent" && (item.status === "blocked" || item.blockedBy))
    return 1;
  if (axis === "ease" && item.status === "needs_merge") return 5;
  if (
    axis === "ease" &&
    (item.pr || item.branch || item.status === "needs_closeout")
  )
    return Math.max(value, 4);
  if (
    axis === "confidence" &&
    ["task", "bug"].includes(item.type) &&
    item.status.startsWith("needs_") &&
    !item.pr &&
    !item.branch &&
    Date.now() - Date.parse(item.createdAt) > 14 * 86_400_000
  )
    return Math.min(value, 2);
  return value;
}

export function createScoresGuard(
  receipts: RunReceipts,
  writer: StructuredToolInterface,
  requiredGuidance: readonly string[],
) {
  let attempts = 0;
  const completed = new Set<string>();
  const inFlight = new Set<string>();
  const retryAfter = new Map<string, ObservedItem>();
  return new DynamicStructuredTool({
    name: "work_item_scores_write",
    description:
      "Propose only changed scores for one fully read open goal-cited item. Required guidance and exact observed source evidence are checked before the host writes.",
    schema: proposal,
    func: async (input, _manager, config) => {
      if (
        receipts.denied ||
        requiredGuidance.some((id) => !receipts.guidance.has(id))
      )
        return "guard_rejected: incomplete_guidance_or_read";
      const item = receipts.items.get(input.id);
      if (
        !item ||
        item.revision !== input.expectedRevision ||
        ["done", "cancelled"].includes(item.status) ||
        completed.has(input.id) ||
        inFlight.has(input.id) ||
        retryAfter.get(input.id) === item
      )
        return "guard_rejected: item_or_revision";
      const goal = [...receipts.goals.values()].find(
        (g) =>
          item.labels.includes(`goal:${g.id.replace(/^goal-/, "")}`) ||
          item.labels.includes(`goal:${g.id}`),
      );
      if (!goal) return "guard_rejected: goal_citation";
      const merged = { ...item.scores };
      let changed = 0;
      for (const axis of axes) {
        const next = input.scores[axis];
        const previous = item.scores?.[axis];
        const oldValue = previous?.v ?? 0;
        const desired = constrained(axis, next?.v ?? oldValue, item);
        const edge = constrained(axis, oldValue, item) !== oldValue;
        if (
          desired === oldValue ||
          (!edge &&
            (!next || (oldValue !== 0 && Math.abs(desired - oldValue) < 2)))
        )
          continue;
        const ev = next?.ev ?? previous?.ev;
        if (desired >= 4) {
          if (!ev) return "guard_rejected: missing_evidence";
          let url: URL;
          try {
            url = new URL(ev);
          } catch {
            return "guard_rejected: invalid_evidence";
          }
          const source = receipts.sources.get(ev);
          const linked =
            goal.sourceUrl === ev ||
            [
              item.summary,
              item.outcome,
              ...(item.specRefs ?? []),
              goal.content,
            ].some((text) => text?.includes(ev));
          if (
            url.protocol !== "https:" ||
            ev === item.sourceUrl ||
            !source ||
            !linked
          )
            return "guard_rejected: unobserved_or_unlinked_evidence";
        }
        merged[axis] = { v: desired, ...(ev ? { ev } : {}) };
        changed++;
      }
      if (!changed) return "no_change";
      if (attempts >= 5) return "guard_rejected: write_budget";
      attempts++;
      inFlight.add(item.id);
      retryAfter.set(item.id, item);
      try {
        const result = await writer.invoke(
          {
            action: "patch",
            id: item.id,
            expectedRevision: item.revision,
            scores: merged,
          },
          config,
        );
        const text =
          typeof result === "string" ? result : JSON.stringify(result);
        try {
          const parsed: unknown = JSON.parse(text);
          if (z.object({ success: z.literal(true) }).safeParse(parsed).success)
            completed.add(item.id);
        } catch {
          /* Unknown response requires a fresh read. */
        }
        return text;
      } catch {
        return "write_result_uncertain: reread before proposing again";
      } finally {
        if (!completed.has(item.id))
          retryAfter.set(item.id, receipts.items.get(item.id) ?? item);
        inFlight.delete(item.id);
      }
    },
  });
}
