// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/chat/page`
 * Purpose: Server entrypoint for the chat page.
 * Scope: Server component only; delegates client-side behavior to ChatView.
 * Invariants: chat/loading.tsx provides the Suspense boundary for useSearchParams(); no nested empty fallback. Auth enforced by proxy.ts.
 * Side-effects: none (server render only)
 * Links: src/app/(app)/chat/view.tsx
 * @public
 */

import type { ReactElement } from "react";

import { ChatView } from "./view";

export default function ChatPage(): ReactElement {
  return <ChatView />;
}
