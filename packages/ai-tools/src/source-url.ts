// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/source-url`
 * Purpose: Attach node-local canonical provenance to content returned by existing readers.
 * Scope: Pure URL construction from a server-injected public origin; does not fetch content or read env.
 * Invariants: ORIGIN_IS_INJECTED, HTTPS_PROVENANCE, NO_MODEL_SELECTED_HOST.
 * Side-effects: none
 * Links: story.5111, task.5318
 * @internal
 */

export function readSourceUrl(
  origin: string | undefined,
  collection: "knowledge" | "work/items",
  id: string
): string | undefined {
  if (!origin) return undefined;
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" || base.username || base.password)
      return undefined;
    return new URL(`/${collection}/${encodeURIComponent(id)}`, base.origin)
      .href;
  } catch {
    return undefined;
  }
}

/** Explicitly distinguish unavailable provenance from a source the agent can cite. */
export function readSourceProvenance(
  origin: string | undefined,
  collection: "knowledge" | "work/items",
  id: string
): { sourceUrl: string } | { sourceUrlUnavailable: true } {
  const sourceUrl = readSourceUrl(origin, collection, id);
  return sourceUrl ? { sourceUrl } : { sourceUrlUnavailable: true };
}

/** Discard untrusted provenance outcomes before trusted server enrichment. */
export function withoutSourceProvenance<T extends object>(
  item: T
): Omit<T, "sourceUrl" | "sourceUrlUnavailable"> {
  const { sourceUrl: _url, sourceUrlUnavailable: _unavailable, ...fields } = item as T & {
    sourceUrl?: unknown;
    sourceUrlUnavailable?: unknown;
  };
  return fields;
}
