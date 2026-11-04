// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/presentation
 * Purpose: Shared labels for schedule configuration and run history.
 * Scope: Pure presentation; does not infer execution health.
 * Invariants: Unknown cadence retains its literal expression and timezone.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
export const SCHEDULE_PRESETS = [
  { label: "Daily at 9:00 AM", value: "0 9 * * *" },
  { label: "Daily at 6:00 PM", value: "0 18 * * *" },
  { label: "Weekly on Monday at 9:00 AM", value: "0 9 * * 1" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 10 minutes", value: "*/10 * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 2 minutes", value: "*/2 * * * *" },
  { label: "Every minute", value: "* * * * *" },
];
export const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/Paris",
  "Asia/Manila",
];
export function cadence(cron: string) {
  return SCHEDULE_PRESETS.find((item) => item.value === cron)?.label ?? cron;
}
export function schedulePrompt(input: Record<string, unknown>): string {
  const messages = input.messages;
  if (!Array.isArray(messages)) return "";
  const message = messages.find(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      "role" in item &&
      item.role === "user"
  );
  return typeof message?.content === "string" ? message.content : "";
}
export function scheduleModel(input: Record<string, unknown>): string {
  const ref = input.modelRef;
  if (
    ref &&
    typeof ref === "object" &&
    "modelId" in ref &&
    typeof ref.modelId === "string" &&
    ref.modelId
  ) {
    const provider =
      "providerKey" in ref && typeof ref.providerKey === "string"
        ? ref.providerKey
        : "";
    return provider ? `${ref.modelId} · ${provider}` : ref.modelId;
  }
  return typeof input.model === "string" && input.model
    ? input.model
    : "Not specified";
}
export function agentLabel(graphId: string) {
  return graphId.split(":").at(-1) ?? graphId;
}
export { formatRunTime as runTime } from "@cogni/scheduling/presentation";
