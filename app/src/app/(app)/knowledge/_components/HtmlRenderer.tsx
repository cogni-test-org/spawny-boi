// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/HtmlRenderer`
 * Purpose: Renders a knowledge entry's `content` as a sandboxed HTML document.
 *   Used for `entryType === 'html'` — the canonical agent→human visual output
 *   channel. Reads theme via next-themes (the sanctioned ThemeProvider path)
 *   and passes the result into the shell so the artifact matches the parent.
 * Scope: Theme-aware shell composition. `@cogni/knowledge-base-ui` owns the
 *   normalized-link and iframe sandbox security boundary shared by every node.
 * Links: docs/spec/knowledge-html-style.md
 * @internal
 */

"use client";

import { KnowledgeHtmlFrame } from "@cogni/knowledge-base-ui";
import { useTheme } from "next-themes";
import { type ReactElement, useEffect, useState } from "react";
import { buildHtmlShell, type RenderTheme } from "./htmlShell";

interface HtmlRendererProps {
  readonly html: string;
  readonly title: string;
}

export function HtmlRenderer({ html, title }: HtmlRendererProps): ReactElement {
  const { resolvedTheme, theme: themePref, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const effective =
    resolvedTheme ??
    (themePref === "system" ? systemTheme : themePref) ??
    systemTheme;
  const theme: RenderTheme = effective === "dark" ? "dark" : "light";
  const srcDoc = mounted ? buildHtmlShell(html, title, theme) : "";

  return (
    <KnowledgeHtmlFrame
      key={mounted ? theme : "pending"}
      title={title}
      documentHtml={srcDoc}
      busy={!mounted}
      className="h-[var(--height-artifact-canvas)] w-full rounded-md border border-border bg-background"
    />
  );
}
