// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Node-owned identity binding for the shared scheduling readback service. */
import { toUserId } from "@cogni/ids";
import type {
  ScheduleRunReader,
  ScheduleUserPort,
} from "@cogni/scheduler-core";
import { createScheduleHistoryService as createSharedScheduleHistoryService } from "@cogni/scheduling";

export { ScheduleHistoryNotFoundError } from "@cogni/scheduling";

export function createScheduleHistoryService(deps: {
  schedules: Pick<ScheduleUserPort, "getSchedule">;
  reader: ScheduleRunReader;
}) {
  return createSharedScheduleHistoryService({
    getSchedule: (caller, scheduleId) =>
      deps.schedules.getSchedule(toUserId(caller), scheduleId),
    reader: deps.reader,
  });
}
