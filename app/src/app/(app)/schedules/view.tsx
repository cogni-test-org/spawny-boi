// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/view
 * Purpose: Show active schedules and direct owners to their run history.
 * Scope: List/filter/configuration UI; catalog errors stay within the creation form.
 * Invariants: Active means enabled configuration, not worker health; paused history stays accessible.
 * Side-effects: IO (schedule reads and pause/resume)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CalendarClock, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge, Button } from "@/components";
import { fetchSchedules } from "./_api/fetchSchedules";
import { updateSchedule } from "./_api/updateSchedule";
import { CreateScheduleForm } from "./create-form";
import { agentLabel, cadence, schedulePrompt } from "./presentation";

export function SchedulesView() {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"Active" | "Paused" | "All">("Active");
  const query = useQuery({
    queryKey: ["schedules"],
    queryFn: fetchSchedules,
    staleTime: 30_000,
  });
  const toggle = useMutation({
    mutationFn: updateSchedule,
    onSuccess: (updated) => {
      client.setQueryData(["schedule", updated.id], updated);
      void client.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const schedules = query.data?.schedules ?? [];
  const counts = {
    Active: schedules.filter((item) => item.enabled).length,
    Paused: schedules.filter((item) => !item.enabled).length,
    All: schedules.length,
  };
  const visible = schedules
    .filter(
      (item) =>
        filter === "All" || (filter === "Active" ? item.enabled : !item.enabled)
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    );
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-semibold text-3xl tracking-tight">Schedules</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Set recurring work. Open a schedule to see its results.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={creating}>
          <Plus className="mr-2 size-4" />
          New schedule
        </Button>
      </div>
      {creating && <CreateScheduleForm onClose={() => setCreating(false)} />}
      <fieldset className="flex gap-2" aria-label="Filter schedules">
        {(["Active", "Paused", "All"] as const).map((item) => (
          <Button
            key={item}
            variant={filter === item ? "secondary" : "ghost"}
            onClick={() => setFilter(item)}
            aria-pressed={filter === item}
          >
            {item}{" "}
            <span className="ml-2 text-muted-foreground">{counts[item]}</span>
          </Button>
        ))}
      </fieldset>
      {toggle.error && (
        <p role="alert" className="text-destructive text-sm">
          {toggle.error.message}
        </p>
      )}
      {query.isLoading ? (
        <output className="py-12 text-center text-muted-foreground">
          Loading schedules…
        </output>
      ) : query.error ? (
        <div role="alert" className="rounded-xl border p-6">
          <p>Unable to load schedules.</p>
          <Button
            className="mt-3"
            variant="secondary"
            onClick={() => query.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <CalendarClock className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h2 className="font-semibold">
            No {filter === "All" ? "" : `${filter.toLowerCase()} `}schedules yet
          </h2>
          <p className="mt-2 text-muted-foreground text-sm">
            {filter === "Active" && counts.Paused > 0
              ? "Your paused schedules and their past results are still available."
              : "Create a schedule to give recurring work a regular home."}
          </p>
          {filter === "Active" && counts.Paused > 0 && (
            <Button
              className="mt-4"
              variant="secondary"
              onClick={() => setFilter("Paused")}
            >
              View paused schedules
            </Button>
          )}
        </div>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {visible.map((schedule) => {
            const prompt = schedulePrompt(schedule.input);
            return (
              <li
                key={schedule.id}
                className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge intent="secondary" size="sm">
                      {schedule.enabled ? "Active" : "Paused"}
                    </Badge>
                    <span className="truncate text-muted-foreground text-xs">
                      {agentLabel(schedule.graphId)}
                    </span>
                  </div>
                  <Link
                    href={`/schedules/${schedule.id}`}
                    className="line-clamp-2 font-medium leading-6 hover:underline"
                  >
                    {prompt || agentLabel(schedule.graphId)}
                  </Link>
                  <p className="mt-2 text-muted-foreground text-sm">
                    {cadence(schedule.cron)} · {schedule.timezone}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() =>
                      toggle.mutate({
                        id: schedule.id,
                        data: { enabled: !schedule.enabled },
                      })
                    }
                    disabled={toggle.isPending}
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button variant="outline" asChild>
                    <Link href={`/schedules/${schedule.id}`}>
                      View history
                      <ArrowUpRight className="ml-2 size-4" />
                    </Link>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
