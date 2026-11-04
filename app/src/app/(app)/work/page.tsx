// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/page`
 * Purpose: Work list route — server auth gate; the layout renders the dashboard.
 * Scope: Auth check only. Data fetching handled client-side via React Query.
 * Invariants: Protected route (server-side auth check).
 * Side-effects: none
 * Links: [WorkRouteView](./WorkRouteView.tsx)
 * @public
 */

import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";

export default async function WorkPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  // The work layout renders the persistent dashboard.
  return null;
}
