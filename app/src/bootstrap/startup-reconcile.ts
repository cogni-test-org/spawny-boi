// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/startup-reconcile`
 * Purpose: Activate this node's repo-spec governance schedules on first container use.
 * Scope: Once-per-process bounded retry of the existing advisory-lock guarded job.
 * Invariants:
 *   - No loopback token or instrumentation → bootstrap import is required.
 *   - Dynamic job import avoids a static container/job cycle; tests are inert.
 *   - Lock contention retries; manual ops route and its authentication remain intact.
 * Side-effects: IO (job), bounded retry timers.
 * Links: bootstrap/container.ts, bootstrap/jobs/syncGovernanceSchedules.job.ts
 * @public
 */

let started = false;
const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 15_000;

export function startGovernanceSyncOnBoot(): void {
  if (started) return;
  // biome-ignore lint/style/noProcessEnv: startup gate before container config
  if (process.env.APP_ENV === "test" || process.env.VITEST === "true") return;
  started = true;
  void reconcile(1);
}

async function reconcile(attempt: number): Promise<void> {
  try {
    const { runGovernanceSchedulesSyncJob } = await import(
      "./jobs/syncGovernanceSchedules.job"
    );
    await runGovernanceSchedulesSyncJob({ throwIfLocked: true });
  } catch (error) {
    // Importing the logger here keeps startup dependencies lazy, like the job.
    const { makeLogger } = await import("@/shared/observability");
    makeLogger({ component: "startup-reconcile" }).warn(
      { err: error, attempt, exhausted: attempt === MAX_ATTEMPTS },
      "Governance startup reconcile failed",
    );
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => void reconcile(attempt + 1), RETRY_DELAY_MS);
    }
  }
}
