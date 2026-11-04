// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/WorkRouteView`
 * Purpose: Keeps one dashboard mounted in the work layout so opening or closing
 *          an item swaps only the URL, never the page (no remount, no skeleton).
 * Scope: Client route projection. Pages own authentication and render nothing.
 * Links: ./view.tsx, ./WorkNavigationBoundary.tsx
 */

"use client";

import { useParams, usePathname } from "next/navigation";
import { WorkDashboardView } from "./view";

export function WorkRouteView() {
  const pathname = usePathname();
  const params = useParams();
  const itemId =
    typeof params.id === "string" && /^\/work\/items\/[^/]+$/.test(pathname)
      ? params.id
      : undefined;
  if (pathname !== "/work" && itemId === undefined) return null;
  return <WorkDashboardView {...(itemId !== undefined && { selectedItemId: itemId })} />;
}
