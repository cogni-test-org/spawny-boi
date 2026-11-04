// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** ReUI board projection of the existing table's filtered, sorted page. */
"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";
import { rankScore } from "@cogni/work-items";
import Link from "next/link";
import { useMemo } from "react";
import { RelativeTime } from "../../knowledge/_components/RelativeTime";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
} from "./reui-kanban";
import { StatusPill, TypeIcon } from "./work-item-icons";

interface WorkKanbanProps {
  readonly items: readonly WorkItemDto[];
  readonly statuses: readonly string[];
  readonly isLoading: boolean;
  readonly onOpenItem: (item: WorkItemDto) => void;
}

export function WorkKanban({
  items,
  statuses,
  isLoading,
  onOpenItem,
}: WorkKanbanProps) {
  const columns = useMemo(() => {
    const result: Record<string, WorkItemDto[]> = Object.fromEntries(
      statuses.map((status) => [status, []]),
    );
    for (const item of items) {
      result[item.status]?.push(item);
    }
    return result;
  }, [items, statuses]);

  return (
    <Kanban
      value={columns}
      onValueChange={() => {}}
      getItemValue={(item) => item.id}
    >
      <KanbanBoard
        className="flex items-start gap-4 overflow-x-auto pb-4"
        aria-label="Work board"
        role="region"
      >
        {Object.entries(columns).map(([status, cards]) => (
          <KanbanColumn
            key={status}
            value={status}
            disabled
            className="w-72 shrink-0 gap-3 rounded-xl bg-muted/30 p-3 opacity-100"
          >
            <div className="flex items-center justify-between gap-2 px-1">
              <h2>
                <StatusPill status={status} className="px-0" />
              </h2>
              <span
                className="font-mono text-muted-foreground text-xs"
                title={`${cards.length} items on this page`}
              >
                {cards.length}
              </span>
            </div>
            <KanbanColumnContent value={status} className="min-h-40 gap-3">
              {isLoading ? (
                <>
                  <Skeleton className="h-32 rounded-lg" />
                  <Skeleton className="h-28 rounded-lg" />
                </>
              ) : cards.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-8 text-center text-muted-foreground text-xs">
                  No items on this page
                </p>
              ) : (
                cards.map((item) => {
                  const score = rankScore(item.scores);
                  const goals = new Map<string, string>();
                  for (const label of item.labels) {
                    const match =
                      /^goal:(?:goal-)?([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(label);
                    if (match?.[1] && !goals.has(match[1]))
                      goals.set(match[1], label);
                  }
                  const updated = item.updatedAt
                    ? new Date(item.updatedAt)
                    : null;
                  const updatedIso =
                    updated && Number.isFinite(updated.getTime())
                      ? updated.toISOString()
                      : undefined;
                  return (
                    <div
                      key={item.id}
                      data-slot="kanban-item"
                      className="relative flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/40"
                    >
                      {/* One card, one hover/focus surface: the button stretches over the
                          whole card; only the goal link sits above it. */}
                      <button
                        type="button"
                        onClick={() => onOpenItem(item)}
                        className="flex w-full flex-col gap-3 text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none"
                        aria-label={`${item.id}: ${item.title}`}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span
                            className="shrink-0 font-mono text-muted-foreground text-xs"
                            title="Rank score"
                          >
                            {score === undefined
                              ? "Unscored"
                              : `Rank ${score.toFixed(1)}`}
                          </span>
                          <span className="flex items-center gap-2">
                            <TypeIcon type={item.type} />
                            <span className="font-mono text-muted-foreground text-xs">
                              {item.id}
                            </span>
                          </span>
                        </span>
                        <span className="line-clamp-3 font-medium text-sm leading-relaxed">
                          {item.title}
                        </span>
                      </button>
                      <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
                        <span className="flex min-w-0 flex-wrap gap-1">
                          {[...goals].slice(0, 1).map(([slug, label]) => (
                            <Link
                              key={slug}
                              href={`/knowledge/${encodeURIComponent(`goal-${slug}`)}`}
                              prefetch={false}
                              className="relative z-10 truncate underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {label}
                            </Link>
                          ))}
                        </span>
                        <span className="shrink-0">
                          Updated <RelativeTime iso={updatedIso} />
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </KanbanColumnContent>
          </KanbanColumn>
        ))}
      </KanbanBoard>
    </Kanban>
  );
}
