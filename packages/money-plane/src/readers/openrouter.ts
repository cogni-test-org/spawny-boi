// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/readers/openrouter`
 * Purpose: Read the OpenRouter account's remaining credit (total_credits − total_usage) as a prepaid money-plane row.
 * Scope: One GET /api/v1/credits through an injected fetch. Does not derive burn: the consumer supplies a measured `burnPerDay` (e.g. a scheduler differencing `usageTotal` between runs) or the row stays UNKNOWN `burn_unmeasured`.
 * Invariants: READERS_NEVER_THROW. UNREADABLE_IS_UNKNOWN — no key ⇒ `unconfigured`, HTTP/body failure ⇒ `unreadable`, unmeasured burn ⇒ UNKNOWN unless the balance is already exhausted (RED). PACKAGE_LEAF_NO_ENV — the key arrives as an argument. Per-key usage is not used as burn (it undercounts account-wide spend).
 *   MANAGEMENT_KEY_ONLY — `/credits` is account-wide and OpenRouter requires a management key for it; never pass an inference key (task.5361). Node compositions leave the row UNKNOWN until a scoped read exists.
 * Side-effects: IO (HTTPS GET via injected fetch)
 * Links: https://openrouter.ai/docs/api-reference/get-credits, https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

import { gradeRunway } from "../grade";
import { unknownRow } from "../row";
import type {
  FetchLike,
  MoneyPlaneRow,
  PayAction,
  PlaneReader,
} from "../types";

export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const OPENROUTER_PLANE = "openrouter:account";

export interface OpenRouterReaderOptions {
  apiKey: string | null | undefined;
  fetch: FetchLike;
  /** Measured account-wide burn in USD/day; omit or null when unmeasured. */
  burnPerDay?: number | null;
  label?: string;
  payAction?: PayAction;
  now?: () => Date;
}

export function openRouterReader(
  options: OpenRouterReaderOptions
): PlaneReader {
  const label = options.label ?? "OpenRouter";
  const now = options.now ?? (() => new Date());
  const payAction = options.payAction;
  const withAction = payAction === undefined ? {} : { payAction };
  const unknown = (
    reasonCode: "unconfigured" | "unreadable",
    detail?: string
  ) =>
    unknownRow({
      plane: OPENROUTER_PLANE,
      label,
      kind: "prepaid",
      reasonCode,
      observedAt: now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
      ...withAction,
    });

  return {
    plane: OPENROUTER_PLANE,
    label,
    kind: "prepaid",
    ...withAction,
    async read(signal): Promise<MoneyPlaneRow> {
      const apiKey = options.apiKey;
      if (!apiKey)
        return unknown("unconfigured", "no OpenRouter key in this environment");
      try {
        const res = await options.fetch(OPENROUTER_CREDITS_URL, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!res.ok) return unknown("unreadable", `HTTP ${res.status}`);
        const body = (await res.json()) as {
          data?: { total_credits?: unknown; total_usage?: unknown };
        } | null;
        const credits = body?.data?.total_credits;
        const usage = body?.data?.total_usage;
        if (
          typeof credits !== "number" ||
          !Number.isFinite(credits) ||
          typeof usage !== "number" ||
          !Number.isFinite(usage)
        ) {
          return unknown("unreadable", "credits response missing totals");
        }
        const balance = credits - usage;
        const burn =
          typeof options.burnPerDay === "number" &&
          Number.isFinite(options.burnPerDay) &&
          options.burnPerDay >= 0
            ? options.burnPerDay
            : null;
        const observedAt = now().toISOString();
        const base = {
          plane: OPENROUTER_PLANE,
          label,
          kind: "prepaid" as const,
          balance,
          currency: "USD",
          burnPerDay: burn,
          observedAt,
          source: "OpenRouter credits API",
          sourceObservedAt: observedAt,
          freshness: "current" as const,
          usageTotal: usage,
          ...withAction,
        };
        if (balance <= 0) {
          return {
            ...base,
            runwayDays: 0,
            grade: "RED",
            detail: "credit exhausted",
          };
        }
        if (burn === null) {
          return {
            ...base,
            runwayDays: null,
            grade: "UNKNOWN",
            reasonCode: "burn_unmeasured",
          };
        }
        if (burn === 0) {
          return {
            ...base,
            runwayDays: null,
            grade: "GREEN",
            detail: "no measured spend",
          };
        }
        const runwayDays = balance / burn;
        return { ...base, runwayDays, grade: gradeRunway(runwayDays) };
      } catch {
        return unknown("unreadable", "credits read failed");
      }
    },
  };
}
