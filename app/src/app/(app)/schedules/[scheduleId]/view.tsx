// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/[scheduleId]/view
 * Purpose: Inspect schedule configuration and execution history; open existing chat threads.
 * Scope: Read UI with existing pause/resume/delete controls; no execution side effects.
 * Invariants: One row per run; latest-run summary is factual; runtime status is not task success.
 * Side-effects: IO (schedule reads and explicit management mutations)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
"use client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogni/node-ui-kit/shadcn/dropdown-menu";
import {
  formatRunDuration as duration,
  runStatusLabel,
} from "@cogni/scheduling/presentation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { deleteSchedule } from "../_api/deleteSchedule";
import { fetchSchedule, fetchScheduleHistory } from "../_api/readHistory";
import { updateSchedule } from "../_api/updateSchedule";
import {
  agentLabel,
  cadence,
  runTime,
  scheduleModel,
  schedulePrompt,
} from "../presentation";

const STATUS_DOT = {
  pending: "bg-muted-foreground",
  running: "bg-success",
  success: "bg-success",
  error: "bg-destructive",
  timeout: "bg-destructive",
  skipped: "bg-muted-foreground",
  cancelled: "bg-muted-foreground",
} as const;

export function ScheduleDetailView({ scheduleId }: { scheduleId: string }) {
  const client = useQueryClient();
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const schedule = useQuery({
    queryKey: ["schedule", scheduleId],
    queryFn: () => fetchSchedule(scheduleId),
    staleTime: 30_000,
  });
  const history = useInfiniteQuery({
    queryKey: ["schedule-history", scheduleId],
    queryFn: ({ pageParam }) => fetchScheduleHistory(scheduleId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!schedule.data,
    staleTime: 30_000,
  });
  const toggle = useMutation({
    mutationFn: updateSchedule,
    onSuccess: (updated) => {
      client.setQueryData(["schedule", updated.id], updated);
      void client.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteSchedule,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["schedules"] });
      router.push("/schedules");
    },
  });
  const refresh = () => {
    void client.resetQueries({ queryKey: ["schedule-history", scheduleId] });
    void schedule.refetch();
  };
  const current = schedule.data;
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];
  const latestRun = runs[0];
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6 p-4 md:p-8">
      <Link
        href="/schedules"
        className="flex w-fit items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Schedules
      </Link>
      {schedule.isPending ? (
        <output>Loading schedule…</output>
      ) : schedule.error || !current ? (
        <div role="alert" className="rounded-xl border p-6">
          <h1 className="font-semibold text-xl">Schedule unavailable</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            This schedule may have been removed, or you may not have access.
          </p>
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => schedule.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
            <div className="w-full min-w-0 sm:w-auto sm:flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h1 className="line-clamp-2 break-words font-semibold text-2xl tracking-tight">
                  {schedulePrompt(current.input) || agentLabel(current.graphId)}
                </h1>
                <Badge intent="secondary">
                  {current.enabled ? "Active" : "Paused"}
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                {agentLabel(current.graphId)} · {cadence(current.cron)} ·{" "}
                {current.timezone}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={toggle.isPending || remove.isPending}
                onClick={() =>
                  toggle.mutate({
                    id: scheduleId,
                    data: { enabled: !current.enabled },
                  })
                }
              >
                {current.enabled ? (
                  <Pause className="mr-2 size-4" />
                ) : (
                  <Play className="mr-2 size-4" />
                )}
                {toggle.isPending
                  ? "Saving…"
                  : current.enabled
                    ? "Pause"
                    : "Resume"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="size-11 p-0"
                    aria-label="Schedule actions"
                    disabled={remove.isPending || toggle.isPending}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => setConfirmDelete(true)}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 size-4" />
                    Delete schedule
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {toggle.error && (
            <p role="alert" className="text-destructive text-sm">
              {toggle.error.message}
            </p>
          )}
          <details className="rounded-lg border bg-card px-4 py-3">
            <summary className="cursor-pointer font-medium text-sm">
              Scheduled instructions
            </summary>
            <p className="mt-3 break-words text-muted-foreground text-sm">
              Model: {scheduleModel(current.input)}
            </p>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">
              {schedulePrompt(current.input) ||
                "No prompt was provided for this schedule."}
            </p>
          </details>
          <section aria-labelledby="run-history-heading" className="min-w-0">
            {latestRun && (
              <p className="mb-4 text-muted-foreground text-sm">
                Latest run:{" "}
                <span className="font-medium text-foreground">
                  {runStatusLabel(latestRun.status)}
                </span>
                {" · "}
                {runTime(latestRun.scheduledFor, current.timezone)}
                {" · "}
                {duration(latestRun)}
              </p>
            )}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3 px-5 py-3">
                <div>
                  <CardTitle
                    id="run-history-heading"
                    className="font-semibold text-muted-foreground text-xs uppercase tracking-wider"
                  >
                    Run history
                  </CardTitle>
                  <p className="mt-1 text-muted-foreground text-xs">
                    Newest scheduled first · {current.timezone}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={refresh}
                  disabled={history.isFetching}
                >
                  <RefreshCw className="mr-2 size-4" />
                  Refresh
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {history.isPending ? (
                  <output className="block px-5 py-8 text-center text-muted-foreground text-sm">
                    Loading run history…
                  </output>
                ) : (
                  <>
                    {history.error && (
                      <div role="alert" className="m-4 rounded-lg border p-4">
                        <p className="text-destructive text-sm">
                          {history.error.message}
                        </p>
                        <Button
                          className="mt-2"
                          variant="secondary"
                          onClick={refresh}
                        >
                          Refresh history
                        </Button>
                      </div>
                    )}
                    {runs.length > 0 ? (
                      <Table className="min-w-[540px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-8">
                              <span className="sr-only">Status indicator</span>
                            </TableHead>
                            <TableHead>Agent</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">
                              Duration
                            </TableHead>
                            <TableHead className="text-right">When</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {runs.map((run) => (
                            <TableRow key={run.id}>
                              <TableCell className="pr-0">
                                <span
                                  aria-hidden="true"
                                  className={`inline-block size-2 rounded-full ${STATUS_DOT[run.status]}`}
                                />
                              </TableCell>
                              <TableCell className="font-medium text-sm">
                                {run.stateKey ? (
                                  <Link
                                    href={`/chat?thread=${encodeURIComponent(run.stateKey)}`}
                                    className="inline-flex items-center gap-1 hover:underline"
                                  >
                                    {agentLabel(current.graphId)}
                                    <ArrowUpRight
                                      className="size-3.5"
                                      aria-hidden="true"
                                    />
                                    <span className="sr-only">
                                      {" "}
                                      Open conversation scheduled for{" "}
                                      {runTime(
                                        run.scheduledFor,
                                        current.timezone
                                      )}
                                    </span>
                                  </Link>
                                ) : (
                                  <span className="text-muted-foreground">
                                    {agentLabel(current.graphId)}
                                    <span className="block font-normal text-xs">
                                      Conversation unavailable
                                    </span>
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  intent={
                                    run.status === "error" ||
                                    run.status === "timeout"
                                      ? "destructive"
                                      : run.status === "running"
                                        ? "default"
                                        : "secondary"
                                  }
                                  size="sm"
                                >
                                  {runStatusLabel(run.status)}
                                </Badge>
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-right text-muted-foreground text-sm tabular-nums">
                                {duration(run)}
                              </TableCell>
                              <TableCell
                                className="whitespace-nowrap text-right text-muted-foreground text-sm"
                                title={run.scheduledFor ?? undefined}
                              >
                                {runTime(run.scheduledFor, current.timezone)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      !history.error && (
                        <div className="px-5 py-10 text-center">
                          <h3 className="font-medium">No runs yet</h3>
                          <p className="mt-2 text-muted-foreground text-sm">
                            {current.enabled
                              ? "Results will appear here after this schedule runs."
                              : "Resume this schedule when you want it to run again."}
                          </p>
                        </div>
                      )
                    )}
                  </>
                )}
              </CardContent>
            </Card>
            {history.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  disabled={history.isFetchingNextPage}
                  onClick={() => history.fetchNextPage()}
                >
                  {history.isFetchingNextPage ? "Loading…" : "Load older runs"}
                </Button>
              </div>
            )}
          </section>
          <Dialog
            open={confirmDelete}
            onOpenChange={(open) => {
              if (!remove.isPending) setConfirmDelete(open);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete schedule?</DialogTitle>
                <DialogDescription>
                  This stops future runs. Its history will no longer be
                  available here.
                </DialogDescription>
              </DialogHeader>
              {remove.error && (
                <p role="alert" className="text-destructive text-sm">
                  {remove.error.message}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                  disabled={remove.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(scheduleId)}
                >
                  {remove.isPending ? "Deleting…" : "Delete schedule"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
