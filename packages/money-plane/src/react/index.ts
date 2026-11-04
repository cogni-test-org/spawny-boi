// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/react`
 * Purpose: Public surface of the React subpath: the one FinanceReport component and its prop types.
 * Scope: Re-exports only. React is a peer; the kit and actions are injected by the consuming node.
 * Invariants: No env, no fetch, no routing in this subpath.
 * Side-effects: none
 * Links: ./FinanceReport.tsx
 * @public
 */
export {
  type FinanceActions,
  type FinanceKit,
  type FinanceReportData,
  type FinanceReportProps,
  FinanceReport,
} from "./FinanceReport";
export {
  isStewardWithdrawalRejected,
  StewardWithdrawalRejected,
} from "../steward";
export {
  balanceLabel,
  burnLabel,
  railLabel,
  refreshedLabel,
  runwayLabel,
  unavailableReason,
} from "./format";
