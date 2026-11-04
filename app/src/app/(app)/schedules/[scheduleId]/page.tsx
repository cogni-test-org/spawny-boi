// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/[scheduleId]/page
 * Purpose: Authenticated schedule history page shell.
 * Scope: Session and path checks only; data reads enforce ownership separately.
 * Invariants: No public schedule content.
 * Side-effects: IO (session)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import { ScheduleParamsSchema } from "@cogni/node-contracts";
import { notFound, redirect } from "next/navigation";
import { getServerSessionUser } from "@/lib/auth/server";
import { ScheduleDetailView } from "./view";
export default async function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ scheduleId: string }>;
}) {
  if (!(await getServerSessionUser())) redirect("/");
  const parsed = ScheduleParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  return <ScheduleDetailView scheduleId={parsed.data.scheduleId} />;
}
