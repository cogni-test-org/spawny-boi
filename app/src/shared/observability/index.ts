// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability`
 * Purpose: Cross-cutting observability — combines app-local (pino/prom-client) + extracted (@cogni/node-shared) utilities.
 * Scope: Unified entry point for all observability utilities.
 * Invariants: No imports from bootstrap or ports.
 * Side-effects: none
 * @public
 */

import { EVENT_NAMES as NODE_SHARED_EVENT_NAMES } from "@cogni/node-shared";

// App-local event registry: the shared registry plus node-local events.
export const EVENT_NAMES = {
  ...NODE_SHARED_EVENT_NAMES,
  DB_POOL_CONFIGURED: "adapter.db_pool.configured",
  // Auth perimeter (proxy): request rejected before reaching any route handler,
  // so the request-scoped logger never sees it — emitted directly from the proxy.
  AUTH_PERIMETER_DENIED: "auth.perimeter.denied",
  // /admin/payments money-plane snapshot: one terminal event per page read
  // (outcome success|error, durationMs, worst grade, per-plane grade enums).
  MONEY_PLANE_SNAPSHOT: "money_plane.snapshot",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

// --- Extracted: events, context, client (from @cogni/node-shared) ---
// NOTE: logEvent/logRequestWarn/etc. come through ./server (which re-exports from @cogni/node-shared)
export {
  // Event payload types
  type AiActivityQueryCompletedEvent,
  type AiLlmCallEvent,
  type Clock,
  // Client-side logging
  clientLogger,
  // Context
  createRequestContext,
  type EventBase,
  type PaymentsConfirmedEvent,
  type PaymentsIntentCreatedEvent,
  type PaymentsStateTransitionEvent,
  type PaymentsStatusReadEvent,
  type PaymentsVerifiedEvent,
  type RequestContext,
  WORK_ITEMS_LIST_ERROR_CODES,
} from "@cogni/node-shared";
// --- App-local: server logger/metrics/redact (pino + prom-client runtime deps) ---
export * from "./server";
