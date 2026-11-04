// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/finance-preview/FinancePreviewClient`
 * Purpose: Exercise the actual report with fixture-owned actions that cannot move money.
 * Scope: Development preview only; the live admin page keeps its normal action wiring.
 * Invariants: No POST, route refresh or real checkout links; no fake successful transfer.
 * Side-effects: local UI state only
 * Links: ./page.tsx, ../../(admin)/admin/payments/FinanceReportClient.client.tsx
 * @internal
 */
"use client";

import { type MoneyPlaneRow, StewardWithdrawalRejected } from "@cogni/money-plane";
import type { FinanceActions } from "@cogni/money-plane/react";
import { FinanceReportClient } from "@/app/(admin)/admin/payments/FinanceReportClient.client";
import type { NodeFinanceSnapshot } from "@/app/(admin)/admin/payments/money-plane.server";

const demoActions: FinanceActions = {
  async fundSteward() {
    throw new StewardWithdrawalRejected("Demo only · no payments");
  },
  refresh() {},
};

function demoRow(row: MoneyPlaneRow): MoneyPlaneRow {
  const children = row.children?.map(demoRow);
  const withChildren = children ? { ...row, children } : row;
  if (!row.payAction || row.payAction.kind === "fund-steward") return withChildren;
  const { payAction: _checkout, ...withoutCheckout } = withChildren;
  return {
    ...withoutCheckout,
    rail: { kind: row.rail?.kind ?? "none", status: "unsupported" },
    note: "Demo only · payments disabled",
  };
}

export function FinancePreviewClient({ report }: { report: NodeFinanceSnapshot }) {
  return <FinanceReportClient report={{ ...report, rows: report.rows.map(demoRow) }} actions={demoActions} />;
}
