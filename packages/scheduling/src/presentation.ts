// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure run labels. Nodes own components, styling, locale and conversation URLs. */
import type { ScheduleRunSummary } from "./contracts/schedules.history.v1.contract.js";

const STATUS_LABELS = {
  pending: "Waiting",
  running: "Running",
  success: "Completed",
  error: "Failed",
  timeout: "Timed out",
  skipped: "Skipped",
  cancelled: "Cancelled",
} as const;

export function runStatusLabel(status: ScheduleRunSummary["status"]): string {
  return STATUS_LABELS[status];
}
export function formatRunDuration(run: ScheduleRunSummary): string {
  if (!run.startedAt || !run.completedAt)
    return run.status === "running" ? "…" : "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000)
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
export function formatRunTime(
  value: string | null,
  timezone: string,
  locale?: string
): string {
  if (!value) return "Time unavailable";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}
export function presentScheduleRun(
  run: ScheduleRunSummary,
  options: { timezone: string; locale?: string }
) {
  return {
    id: run.id,
    statusLabel: runStatusLabel(run.status),
    durationLabel: formatRunDuration(run),
    timeLabel: formatRunTime(
      run.scheduledFor,
      options.timezone,
      options.locale
    ),
    exactScheduledFor: run.scheduledFor,
    conversationKey: run.stateKey,
  };
}
