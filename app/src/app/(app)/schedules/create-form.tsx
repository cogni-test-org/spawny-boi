// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/create-form
 * Purpose: Configure an agent, prompt, cadence and timezone using existing schedule creation.
 * Scope: Form UI and catalog reads; does not schedule execution itself.
 * Invariants: Catalog availability affects this form only; explicit cadence/timezone confirmation.
 * Side-effects: IO (catalog and creation requests)
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
"use client";
import type { ModelRef } from "@cogni/ai-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { ModelPicker } from "@/features/ai/components/ModelPicker";
import { useModels } from "@/features/ai/hooks/useModels";
import { createSchedule } from "./_api/createSchedule";
import { fetchAgents } from "./_api/fetchAgents";
import { cadence, SCHEDULE_PRESETS, TIMEZONES } from "./presentation";

export function CreateScheduleForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    staleTime: 60_000,
  });
  const models = useModels();
  const selectedModel = modelRef ?? models.data?.defaultRef;
  const create = useMutation({
    mutationFn: createSchedule,
    onSuccess: (schedule) => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      router.push(`/schedules/${schedule.id}`);
    },
  });
  const catalogError = agents.error ?? models.error;
  const canCreate =
    prompt.trim() &&
    agent &&
    selectedModel &&
    !catalogError &&
    (models.data?.models.length ?? 0) > 0;
  return (
    <form
      className="space-y-6 rounded-xl border bg-card p-5 md:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canCreate || !selectedModel) return;
        create.mutate({
          graphId: agent,
          input: {
            messages: [{ role: "user", content: prompt.trim() }],
            modelRef: selectedModel,
          },
          cron,
          timezone,
        });
      }}
    >
      <div>
        <h2 className="font-semibold text-xl">New schedule</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Choose what to run and when it should repeat.
        </p>
      </div>
      {catalogError && (
        <p role="alert" className="text-destructive text-sm">
          Unable to load agents or models. Close and try again.
        </p>
      )}
      <div className="space-y-2">
        <label htmlFor="schedule-prompt" className="font-medium text-sm">
          What should the agent do?
        </label>
        <textarea
          id="schedule-prompt"
          required
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the result you want from each run…"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="schedule-agent" className="font-medium text-sm">
            Agent
          </label>
          <Select value={agent} onValueChange={setAgent}>
            <SelectTrigger id="schedule-agent">
              <SelectValue
                placeholder={
                  agents.isLoading ? "Loading agents…" : "Choose an agent"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {agents.data?.agents.map((item) => (
                <SelectItem key={item.graphId} value={item.graphId}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {agents.data?.agents.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No agents are available yet.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Model</p>
          <ModelPicker
            models={models.data?.models ?? []}
            value={selectedModel?.modelId ?? ""}
            onValueChange={setModelRef}
            disabled={models.isLoading || !models.data?.models.length}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="schedule-frequency" className="font-medium text-sm">
            Repeats
          </label>
          <Select value={cron} onValueChange={setCron}>
            <SelectTrigger id="schedule-frequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_PRESETS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label htmlFor="schedule-timezone" className="font-medium text-sm">
            Timezone
          </label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger id="schedule-timezone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="rounded-md bg-muted px-3 py-2 text-sm">
        {cadence(cron)} · {timezone}
      </p>
      {create.error && (
        <p role="alert" className="text-destructive text-sm">
          {create.error.message}
        </p>
      )}
      <div className="flex gap-3">
        <Button type="submit" disabled={!canCreate || create.isPending}>
          {create.isPending ? "Creating…" : "Create schedule"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={create.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
