// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import { hasScores, WorkItemScoresRadar } from "@cogni/knowledge-base-ui";
import type { WorkItemDto } from "@cogni/node-contracts";
import type { ReactElement } from "react";
import {
  Markdown,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components";

import { EntityCitationLinks } from "../../_components/EntityCitationLinks";
import { isWorkItemNotFoundError } from "../_api/fetchWorkItems";
import { StatusPill, TypeIcon } from "./work-item-icons";

type SubjectRef = WorkItemDto["assignees"][number];

function assigneeLabel(a: SubjectRef): string {
  switch (a.kind) {
    case "user":
      return a.userId;
    case "agent":
      return a.agentId;
    case "system":
      return a.serviceId;
  }
}

interface WorkItemDetailProps {
  readonly item: WorkItemDto | null;
  readonly itemId?: string;
  readonly isLoading?: boolean;
  readonly error?: Error | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): ReactElement | null {
  if (!children) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
        {label}
      </span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function WorkItemDetail({
  item,
  itemId,
  isLoading = false,
  error = null,
  open,
  onOpenChange,
}: WorkItemDetailProps): ReactElement {
  const isNotFound = isWorkItemNotFoundError(error);
  const hasOperationalError = !isLoading && !isNotFound && (!item || !!error);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {isLoading && (
          <SheetHeader className="px-6 py-16 text-center sm:text-center">
            <SheetTitle>Loading work item</SheetTitle>
            <SheetDescription>
              Loading details for {itemId ?? "the selected work item"}.
            </SheetDescription>
          </SheetHeader>
        )}

        {!isLoading && isNotFound && (
          <SheetHeader className="px-6 py-16 text-center sm:text-center">
            <SheetTitle>Work item not found</SheetTitle>
            <SheetDescription className="text-xs leading-relaxed">
              No work item with id <code className="font-mono">{itemId}</code>{" "}
              exists, or it isn&apos;t visible to you.
            </SheetDescription>
          </SheetHeader>
        )}

        {hasOperationalError && (
          <SheetHeader className="px-6 py-16 text-center sm:text-center">
            <SheetTitle>Unable to load work item</SheetTitle>
            <SheetDescription className="text-xs leading-relaxed">
              The work-item route could not load{" "}
              <code className="font-mono">{itemId ?? "the selected item"}</code>
              . Try again shortly.
            </SheetDescription>
          </SheetHeader>
        )}

        {!isLoading && !error && item && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <TypeIcon type={item.type} className="size-5" />
                <span className="font-mono text-muted-foreground text-sm">
                  {item.id}
                </span>
              </div>
              <SheetTitle className="text-lg leading-snug">
                {item.title}
              </SheetTitle>
              <SheetDescription>
                Details for <span className="font-mono">{item.id}</span>.
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-5 px-1">
              {/* Status + Priority row */}
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill status={item.status} />
                {item.priority != null && (
                  <span className="inline-flex rounded-md bg-muted px-2 py-0.5 font-medium text-xs">
                    {item.priority}
                  </span>
                )}
                {item.estimate != null && (
                  <span className="text-muted-foreground text-xs">
                    Est: {item.estimate}
                  </span>
                )}
              </div>

              {/* Evaluation (story.5111) */}
              {hasScores(item.scores) && (
                <Field label="Evaluation">
                  <WorkItemScoresRadar scores={item.scores} />
                </Field>
              )}

              {/* Summary */}
              {item.summary && (
                <Field label="Summary">
                  <Markdown content={item.summary} />
                </Field>
              )}

              {/* Outcome */}
              {item.outcome && (
                <Field label="Outcome">
                  <Markdown content={item.outcome} />
                </Field>
              )}

              <EntityCitationLinks entityId={item.id} />

              {/* Project */}
              {item.projectId && (
                <Field label="Project">{item.projectId}</Field>
              )}

              {/* Branch / PR */}
              {(item.branch || item.pr) && (
                <div className="flex gap-6">
                  {item.branch && (
                    <Field label="Branch">
                      <code className="text-xs">{item.branch}</code>
                    </Field>
                  )}
                  {item.pr && (
                    <Field label="PR">
                      <code className="text-xs">{item.pr}</code>
                    </Field>
                  )}
                </div>
              )}

              {/* Blocked by */}
              {item.blockedBy && (
                <Field label="Blocked By">
                  <span className="font-mono text-destructive text-xs">
                    {item.blockedBy}
                  </span>
                </Field>
              )}

              {/* Labels */}
              {item.labels.length > 0 && (
                <Field label="Labels">
                  <div className="flex flex-wrap gap-1.5">
                    {item.labels.map((l) => (
                      <span
                        key={l}
                        className="rounded-md bg-muted px-2 py-0.5 text-xs"
                      >
                        {l}
                      </span>
                    ))}
                  </div>
                </Field>
              )}

              {/* Spec refs */}
              {item.specRefs.length > 0 && (
                <Field label="Spec Refs">
                  <div className="flex flex-col gap-1">
                    {item.specRefs.map((s) => (
                      <code key={s} className="text-xs">
                        {s}
                      </code>
                    ))}
                  </div>
                </Field>
              )}

              {/* Assignees */}
              {item.assignees.length > 0 && (
                <Field label="Assignees">
                  <div className="flex flex-wrap gap-2">
                    {item.assignees.map((a) => (
                      <span
                        key={`${a.kind}-${assigneeLabel(a)}`}
                        className="rounded-md bg-muted px-2 py-0.5 text-xs"
                      >
                        {assigneeLabel(a)}
                      </span>
                    ))}
                  </div>
                </Field>
              )}

              {/* Timestamps */}
              <div className="flex gap-6 border-t pt-4 text-muted-foreground text-xs">
                <span>Created: {item.createdAt.slice(0, 10)}</span>
                <span>Updated: {item.updatedAt.slice(0, 10)}</span>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
