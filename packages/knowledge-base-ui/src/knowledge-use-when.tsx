// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-use-when`
 * Purpose: Render the retrieval trigger shared by atom readers and inbox previews.
 * Scope: Pure presentation; styling and placement remain node-owned.
 * Invariants: BLANK_TRIGGERS_HIDDEN, PLAIN_TEXT_ONLY.
 * Side-effects: none
 * @public
 */

import type { ReactElement } from "react";

export interface KnowledgeUseWhenProps {
  readonly useWhen?: string | null | undefined;
  readonly className?: string;
}

/** Hide missing triggers and render supplied text without interpreting markup. */
export function KnowledgeUseWhen({
  useWhen,
  className,
}: KnowledgeUseWhenProps): ReactElement | null {
  const trigger = useWhen?.trim();
  if (!trigger) return null;

  return (
    <p className={className}>
      <span>Use when:</span> {trigger}
    </p>
  );
}
