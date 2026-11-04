// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

export interface CitationLabelEndpoint {
  readonly id: string;
  readonly title?: string | null;
}

/** Prefer the human title while preserving the stable id as a fallback. */
export function formatCitationLabel(
  citationType: string,
  endpoint: CitationLabelEndpoint
): string {
  return `${citationType} ${endpoint.title ?? endpoint.id}`;
}
