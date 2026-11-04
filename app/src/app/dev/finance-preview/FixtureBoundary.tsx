// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/finance-preview/FixtureBoundary`
 * Purpose: Isolate real shell financial queries to the selected local fixture.
 * Scope: Development preview only; no root provider or production hook changes.
 * Invariants: Treasury observer is disabled before mounting; never uses live cache.
 * Side-effects: local query cache only
 * Links: features/treasury/hooks/useTreasurySnapshot.ts
 * @internal
 */
"use client";
import type { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

export function createFinancePreviewQueryClient(
  snapshot?: TreasurySnapshotResponseV1
): QueryClient {
  const client = new QueryClient();
  client.setQueryDefaults(["treasury", "snapshot"], { enabled: false });
  if (snapshot) client.setQueryData(["treasury", "snapshot"], snapshot);
  return client;
}
export function FixtureBoundary({
  children,
  snapshot,
}: {
  children: ReactNode;
  snapshot?: TreasurySnapshotResponseV1;
}) {
  const [client] = useState(() => createFinancePreviewQueryClient(snapshot));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
