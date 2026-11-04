// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Canonical human URL for a node-local work item. */
export function workItemPermalink(id: string): string {
  return `/work/items/${encodeURIComponent(id)}`;
}
