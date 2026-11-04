// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/chat/loading`
 * Purpose: Per-route Suspense fallback for `/chat`. Overrides the default
 *   `(app)/loading.tsx` inside the chat viewport with the same brain indicator.
 * Scope: Server component, layout-preserving inside `chat/layout.tsx`.
 * Invariants: Matches the chat-viewport flex shell — full-height,
 *   overflow-hidden. Uses the same component as the client readiness gates,
 *   so route streaming never switches to a second loading design.
 * Side-effects: none
 * Links: ./layout.tsx, ./view.tsx,
 *   src/features/ai/chat/components/ChatThreadsSidebarGroup.tsx
 * @public
 */

import { BrainLoading } from "@/components/kit/feedback/BrainLoading";

export default function ChatLoading() {
  return <BrainLoading />;
}
