# money-plane · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** draft
- **Last reviewed:** 2026-10-26

## Purpose

Published leaf package (`@cogni-dao/money-plane`, consumed as `@cogni/money-plane`) that owns the money-plane row model, grading policy, the never-throwing snapshot runner, the USD projection (ECB rate) and summary, the generic injected readers (Base wallets, OpenRouter, credit-purchase income), and — under `./react` — the one FinanceReport UI every node renders. Design: [money-plane-snapshot-design](https://cognidao.org/knowledge/money-plane-snapshot-design).

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

No runtime dependencies, no env reads, no viem. `fetch` is injected (`FetchLike`). React is allowed only under `src/react` (subpath `@cogni-dao/money-plane/react`, React 19 peer); that subpath still reads no env and performs no fetch — the node injects its UI kit and its actions.

## Public Surface

- Types: `MoneyPlaneRow`, `NativeAmount`, `NativeRate`, `PayAction`, `Grade`, `PlaneKind`, `ReasonCode`, `PlaneReader`, `MoneyPlaneSnapshot`, `FetchLike`
- Policy: `RUNWAY_DAYS`, `SPEND_USD_PER_MONTH`, `EXPIRY_DAYS`, `ESCROW_DAYS`, `ESCROW_CALIBRATED`
- Grading: `gradeRunway`, `gradeSpend`, `gradeExpiry`, `worstGrade`, `applyGradingFloor`
- Runner: `takeSnapshot(readers, { timeoutMs, now? })`
- Readers: `openRouterReader`, `baseWalletReader`, `creditPurchaseIncomeReader({ query: (since, signal) => { totalUsdCents, count }, windowDays?, basis?: "credited" | "intent" })`; helpers `unknownRow`, `safeDetail`
- Steward: `StewardWithdrawalRejected` (core, no React) + `isStewardWithdrawalRejected` — an explicit server refusal; any other failure after a POST is an unknown outcome
- FX + summary: `fetchEcbRate(fetch, pair)`, `toUsd(row, rates)`, `usdBalance`, `usdBurn`, `summarize(snapshot, { treasuryPlane, windowDays? })` → `{ treasuryUsd, incomePerDay, burnPerDay, runwayDays (treasury ÷ known costs), runwayReason, costCoverageGaps, nextDeadline, windowDays, ratesUsed, unconverted }`
- Row model additions (v6): `kind: "income"`, `usd`, `rail`, `children` (one level), `parts`, `note`
- React (`./react`): `FinanceReport({ report: { takenAt, rows, treasuryPlane?, stewardWalletUrl? }, summary, kit, actions, formatTime?, thisNode? })`; `kit` = Button, Input, Card, CardContent, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger; `actions` = fundSteward(amountUsd), refresh?. Ship `tailwind-source.css` so consumers scan its classes.

## Invariants

- UNREADABLE_IS_UNKNOWN — unreadable, unconfigured, timed-out, stale, or prepaid-with-unmeasured-burn is UNKNOWN, never GREEN. Wallets are INFO.
- READERS_NEVER_THROW — readers return UNKNOWN rows; `takeSnapshot` additionally converts throws and timeouts and never rejects.
- EVIDENCE_IS_EXPLICIT — sourceObservedAt differs from read-at observedAt; absent/stale freshness cannot grade GREEN/YELLOW. Native rates/transfer aggregates retain exact decimal strings and denomination; no FX or custody aggregation.
- SPEND_POLICY_IS_EXPLICIT — gradeSpend without caller thresholds is UNKNOWN.
- ACTIONS_ON_ROWS — the only money-moving control is the node's existing steward-withdrawal POST, rendered from `payAction` on the row; agents prepare, humans click. NO_BLIND_RETRY — withdrawal state and the synchronous send lock are owned once per report/account and shared by desktop/mobile controls. A valid broadcast with `receiptStatus:pending` or `receiptStatus:reverted` stays accurately labeled and locked with its transaction link until explicit human acknowledgement. Only receiptStatus:success means funded. A valid broadcast hash outranks HTTP refusal/error labels and malformed status: retain the explorer link and pending lock. Missing or invalid hash is unknown. Demo previews inject inert actions; no real financial POST is possible. After a POST, only a `StewardWithdrawalRejected` (the server refused before broadcasting) re-enables the control; every other outcome (5xx, 422, timeout, unreadable body, lost socket) locks it until a human confirms the wallet on the explorer.
- ONE_ROW_MODEL — a Pay button is a `payAction` value, never a new row shape; how a line gets paid is a `rail`. A rail that is not `supported` renders a greyed label, never a clickable control.
- ONE_UI — nodes render `FinanceReport` from `./react`; they keep readers, composition and auth only.
- RUNWAY_NEEDS_COVERAGE — past credit receipts never offset forecast burn. Missing, stale or invalid registered costs (including rollup children) prevent a runway estimate. Known subtotals remain visible; wallets and date-only expiry rows are not costs. Treasury must be current and readable. Zero burn and invalid derived results never render infinity.
- USD_IS_DERIVED — `usd` is a projection (`toUsd`); native amounts stay exact in dialogs; a parent carrying burn is the rollup and its children are never summed again.
- `detail` never carries a URL, key, or address. Optional `wallet: WalletIdentity` holds only public address/network/explorer evidence, retained on read failure and timeout. Base readers expose only valid configured addresses. Source dialogs show the full wrapping address, copy with honest success/failure feedback, and only credential-free HTTPS explorer links.
- OpenRouter burn is not measured here: `openRouterReader` exposes `usageTotal` and grades only from a caller-supplied `burnPerDay`. `/credits` needs an OpenRouter management key; an inference key must never carry it, so node compositions leave the OpenRouter balance UNKNOWN ("needs a management key · task.5361") with the Top up action still reachable. An inherited key reads the inheritor's account, not the node's balance. Provider least privilege is task.5361.

## Not here

The alert decision, routes, DI wiring, env loading and UI stay in each consuming node ([keep-node-product-local](https://cognidao.org/knowledge/keep-node-product-local)). Operator-only planes (Akash, Cherry, Grafana, domain) are operator readers.

## Release

Bump `version`, merge, then push tag `money-plane-v<version>` at the merged main SHA; `.github/workflows/publish-packages.yml` publishes the Release asset.

- EVIDENCE_AT_EVERY_DEPTH — grading normalization and snapshot worst include descendants; stale or failed INFO is UNKNOWN while proven RED remains visible. Exact native wallet amounts are retained as decimal-string parts; numeric balances are display projections.

- INCOME_COVERAGE — cash received sums only current, dated, valid USD income, with partial coverage explicit when registered income lines are unavailable. Past receipts never offset forecast costs. Desktop and stacked mobile views share useful sorting controls and state. This file ships in the package whitelist.
