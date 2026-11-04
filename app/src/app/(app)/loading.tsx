// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/loading`
 * Purpose: Default Suspense fallback for every route under the protected
 *   `(app)` route group. Rendered inside the sidebar shell while the RSC
 *   payload streams in, so the user sees the shared brain indicator on nav
 *   instead of a frozen UI for the whole server round-trip.
 * Scope: Server component, layout-preserving. Does not fetch data.
 * Invariants: Renders inside `(app)/layout.tsx` — sidebar + top bar stay
 *   visible across nav.
 * Side-effects: none
 * Links: ./layout.tsx, src/components/kit/feedback/BrainLoading.tsx,
 *   https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming
 * @public
 */

import { BrainLoading } from "@/components/kit/feedback/BrainLoading";

export default function AppLoading() {
  return <BrainLoading />;
}
