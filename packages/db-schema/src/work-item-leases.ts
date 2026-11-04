// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Operational lease authority, independent of the versioned work-item database. */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const workItemLeases = pgTable("work_item_leases", {
  workItemId: text("work_item_id").primaryKey(),
  principalId: text("principal_id").notNull(),
  runId: text("run_id").notNull(),
  leaseToken: uuid("lease_token").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastCommand: text("last_command").notNull(),
}).enableRLS();
