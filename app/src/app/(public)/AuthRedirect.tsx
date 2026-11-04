// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(public)/AuthRedirect`
 * Purpose: Client-side auth transition gate for SIWE sign-in on public pages.
 * Scope: Watches NextAuth session status; does not enforce auth policy or access control.
 *   When authenticated, renders the app shell + shared loader and hard-navigates to /chat
 *   so middleware/RSC run on the new request. Server remains the routing authority.
 * Invariants: No-op when session is loading or unauthenticated; overlay prevents flash.
 * Side-effects: IO (hard navigation via window.location.replace)
 * Links: src/proxy.ts (server-side authority), src/app/(public)/page.tsx
 * @public
 */

"use client";

import { useSession } from "next-auth/react";
import { useEffect } from "react";

import { BrainLoading } from "@/components/kit/feedback/BrainLoading";
import { AppShell } from "@/features/layout/components/AppShell";

export function AuthRedirect(): React.JSX.Element | null {
  const { status } = useSession();

  useEffect(() => {
    if (status === "authenticated") {
      window.location.replace("/chat");
    }
  }, [status]);

  if (status !== "authenticated") return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-background">
      <AppShell>
        <BrainLoading />
      </AppShell>
    </div>
  );
}
