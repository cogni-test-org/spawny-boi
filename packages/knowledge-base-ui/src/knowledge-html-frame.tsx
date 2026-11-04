// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";

import { type ReactElement, useEffect, useState } from "react";

/**
 * The only sandbox capability granted to authored knowledge HTML.
 * Navigation still requires an explicit user activation.
 */
export const KNOWLEDGE_HTML_SANDBOX =
  "allow-top-navigation-by-user-activation" as const;

/**
 * Normalize authored anchors before they enter the opaque-origin iframe.
 * Authored bases/targets are untrusted; only resolved HTTP(S) URLs may leave it.
 */
export function normalizeKnowledgeHtmlNavigation(
  documentHtml: string,
  parentUrl: string
): string {
  const document = new DOMParser().parseFromString(documentHtml, "text/html");

  document.querySelectorAll("base").forEach((base) => {
    base.remove();
  });
  document.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
    const authoredHref = anchor.getAttribute("href");
    if (!authoredHref) return;

    let resolved: URL;
    try {
      resolved = new URL(authoredHref, parentUrl);
    } catch {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      return;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      return;
    }

    anchor.href = resolved.href;
    anchor.target = "_top";
    anchor.rel = "noopener noreferrer";
  });

  const doctype = document.doctype
    ? `<!doctype ${document.doctype.name}>\n`
    : "";
  const htmlElement = document.querySelector("html");
  return htmlElement ? `${doctype}${htmlElement.outerHTML}` : documentHtml;
}

export interface KnowledgeHtmlFrameProps {
  readonly documentHtml: string;
  readonly title: string;
  readonly className?: string;
  readonly busy?: boolean;
}

/** Owns the security boundary shared by every node's knowledge renderer. */
export function KnowledgeHtmlFrame({
  documentHtml,
  title,
  className,
  busy = false,
}: KnowledgeHtmlFrameProps): ReactElement {
  const [srcDoc, setSrcDoc] = useState("");

  useEffect(() => {
    setSrcDoc(
      documentHtml
        ? normalizeKnowledgeHtmlNavigation(documentHtml, window.location.href)
        : ""
    );
  }, [documentHtml]);

  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox={KNOWLEDGE_HTML_SANDBOX}
      referrerPolicy="no-referrer"
      aria-busy={busy || srcDoc.length === 0}
      className={className}
    />
  );
}
