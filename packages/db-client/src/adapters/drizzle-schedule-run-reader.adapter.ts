// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Existing Drizzle composition seam; the shared reader uses this app-role pool. */
import { PostgresScheduleRunReader } from "@cogni/scheduling/adapters/postgres";
import type { Database } from "../client";

export class DrizzleScheduleRunReader extends PostgresScheduleRunReader {
  constructor(db: Database) {
    super(db.$client);
  }
}
