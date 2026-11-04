// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/react/FinanceReport`
 * Purpose: The one Financials UI every node renders: header + four USD stat cards (Treasury · Income · Burn · Runway), one table (Line · Balance · Burn/day · Runway · Action)
 *   grouped Income / Costs / Reserves, expandable children, the Line dialog, and rail-driven actions.
 * Scope: Presentation only. The kit (Dialog, Button, Input) and the actions (fundSteward, refresh) are injected by the node;
 *   no env, no fetch, no routing here. Container query (@2xl) switches to stacked cards; no horizontal scroll.
 * Invariants: ONE_UI — nodes do not keep their own table. USD columns read `row.usd`; native exact amounts stay in the dialog.
 *   A rail that is not `supported` renders a greyed label, never a clickable control. A numeric column no row can fill is omitted.
 * Side-effects: local expand/sort state; actions.refresh on request
 * Links: ../report.ts, ../fx.ts, https://cognidao.org/knowledge/finances-expert
 * @public
 */
"use client";

import {
  type ComponentType,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { usdBalance, usdBurn } from "../fx";
import type { ReportSummary } from "../report";
import { isStewardWithdrawalRejected, readStewardWithdrawal } from "../steward";
import type { MoneyPlaneRow, PayAction, Rail, WalletIdentity } from "../types";
import {
  balanceLabel,
  basisLabel,
  burnLabel,
  byRisk,
  cx,
  DASH,
  dailyUsd,
  GROUPS,
  type Group,
  groupOf,
  nativeLabel,
  observedLabel,
  railLabel,
  railSentence,
  refreshedLabel,
  runway,
  runwayClass,
  runwayLabel,
  unavailableReason,
  usd,
} from "./format";

// biome-ignore lint/suspicious/noExplicitAny: kit components are injected by the node; their prop types are the node's.
type AnyComponent = ComponentType<any>;

/** The pieces of the node's UI kit the report renders with; both node kits export these with the same props. */
export interface FinanceKit {
  Button: AnyComponent;
  Input: AnyComponent;
  Card: AnyComponent;
  CardContent: AnyComponent;
  Dialog: AnyComponent;
  DialogContent: AnyComponent;
  DialogHeader: AnyComponent;
  DialogTitle: AnyComponent;
  DialogDescription: AnyComponent;
  DialogTrigger: AnyComponent;
}

export interface FinanceActions {
  /**
   * The amount-only steward withdrawal; requires a 32-byte tx hash and explicit receipt status. Throw `StewardWithdrawalRejected` for an explicit
   * server refusal (retry allowed); any other throw means the outcome is unknown and the control locks until checked.
   */
  fundSteward: (
    amountUsd: number
  ) => Promise<{ txHash: string; receiptStatus: "success" | "reverted" | "pending" }>;
  /** Re-read the report (e.g. router.refresh). Omit to hide the button. */
  refresh?: () => void | Promise<void>;
}

export interface FinanceReportData {
  takenAt: string;
  rows: MoneyPlaneRow[];
  treasuryPlane?: string | null;
  /** Explorer page of the steward wallet, shown when a transfer's result is unknown. */
  stewardWalletUrl?: string | null;
}

export interface FinanceReportProps {
  report: FinanceReportData;
  summary: ReportSummary;
  kit: FinanceKit;
  actions: FinanceActions;
  /** Override time rendering (tests, SSR); defaults to the viewer's zone after hydration. */
  formatTime?: (iso: string, kind: "refreshed" | "observed") => string;
  /** The node rendering the page; its own payer line is noise. */
  thisNode?: string;
}

const noop = () => () => {};
function useViewerTimeZone(): string | undefined {
  return useSyncExternalStore(
    noop,
    () => undefined,
    () => "UTC"
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cx(
        "size-4 shrink-0 text-muted-foreground transition-transform",
        open && "rotate-90"
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9M9 2h5v5M14 2 7 9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs leading-relaxed">{term}</dt>
      <dd className="font-medium text-sm tabular-nums">{children}</dd>
    </div>
  );
}

function WalletFact({ wallet, kit }: { wallet: WalletIdentity; kit: FinanceKit }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  let explorerUrl: string | undefined;
  try {
    const url = new URL(wallet.explorerUrl);
    if (url.protocol === "https:" && !url.username && !url.password) {
      explorerUrl = url.href;
    }
  } catch {
    // A malformed explorer link must not hide the public account itself.
  }
  async function copy() {
    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <Fact term={`Wallet · ${wallet.network}`}>
      <span className="block min-w-0 select-text break-all font-mono">
        {wallet.address}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-3">
        <kit.Button variant="outline" size="sm" aria-label="Copy address" onClick={copy}>
          Copy
        </kit.Button>
        {explorerUrl && (
          <kit.Button variant="link" size="sm" asChild>
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
              Explorer <ExternalIcon />
            </a>
          </kit.Button>
        )}
        <span role="status" aria-live="polite" className="text-muted-foreground text-xs">
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : ""}
        </span>
      </span>
    </Fact>
  );
}

function LineDialog({
  row,
  kit,
  timeZone,
  formatTime,
  thisNode,
  child,
}: {
  row: MoneyPlaneRow;
  kit: FinanceKit;
  timeZone: string | undefined;
  formatTime: FinanceReportProps["formatTime"];
  thisNode: string;
  child?: boolean;
}) {
  const reason = unavailableReason(row);
  const basis = basisLabel(row);
  const observed = formatTime
    ? row.sourceObservedAt
      ? formatTime(row.sourceObservedAt, "observed")
      : undefined
    : observedLabel(row.sourceObservedAt, timeZone);
  const read = formatTime
    ? formatTime(row.observedAt, "observed")
    : observedLabel(row.observedAt, timeZone);
  const payer = row.payer && row.payer !== thisNode ? `Paid by ${row.payer}` : "";
  const who = [row.payer ?? "", row.beneficiary ? `for ${row.beneficiary}` : ""]
    .filter(Boolean)
    .join(" · ");
  const rate = row.usd?.rate;
  return (
    <kit.Dialog>
      <kit.DialogTrigger asChild>
        <kit.Button
          variant="link"
          size="sm"
          className={cx(
            "h-auto min-w-0 flex-col items-start whitespace-normal p-0 text-left text-foreground no-underline hover:underline",
            child && "font-normal"
          )}
        >
          <span className="block font-medium text-sm">{row.label}</span>
          {payer && (
            <span className="block text-muted-foreground text-xs">{payer}</span>
          )}
        </kit.Button>
      </kit.DialogTrigger>
      <kit.DialogContent className="max-h-dvh w-11/12 min-w-0 max-w-lg overflow-y-auto break-words">
        <kit.DialogHeader className="pr-8">
          <kit.DialogTitle>{row.label}</kit.DialogTitle>
          <kit.DialogDescription>
            {row.source ?? "Not connected"}
            {basis ? ` · ${basis}` : ""}
          </kit.DialogDescription>
        </kit.DialogHeader>
        <dl className="grid min-w-0 gap-3">
          {row.wallet && <WalletFact wallet={row.wallet} kit={kit} />}
          {reason && (
            <Fact term="Unavailable">
              {reason}
              {row.detail && row.detail !== reason ? (
                <span className="text-muted-foreground text-xs"> · {row.detail}</span>
              ) : null}
            </Fact>
          )}
          {row.note && <Fact term="Note">{row.note}</Fact>}
          {row.parts?.length
            ? row.parts.map((part) => (
                <Fact key={part.label} term={part.label}>
                  {nativeLabel(part.amount, part.currency)}
                </Fact>
              ))
            : row.balance !== null && (
                <Fact term="Balance · exact">
                  {row.balance} {row.currency}
                </Fact>
              )}
          {row.nativeRate ? (
            <Fact term="Rate · exact">
              {row.nativeRate.amount} {row.nativeRate.currency} /{" "}
              {row.nativeRate.per}
            </Fact>
          ) : (
            row.burnPerDay !== null && (
              <Fact term={row.kind === "income" ? "Inflow / day" : "Burn / day"}>
                {row.burnPerDay} {row.currency}
              </Fact>
            )
          )}
          {rate && (
            <Fact term="Converted">
              {`${rate.pair.slice(0, 3)}→${rate.pair.slice(3)} ${rate.value} · ${rate.source} ${rate.date}`}
            </Fact>
          )}
          {!reason && row.detail && <Fact term="Detail">{row.detail}</Fact>}
          {row.rail && (
            <Fact term="Rail">
              {railSentence(row.rail)}
              {row.rail.guide ? (
                <span className="text-muted-foreground text-xs"> · {row.rail.guide}</span>
              ) : null}
            </Fact>
          )}
          <Fact term="Observed">
            {observed ?? `Source time unknown · read ${read ?? DASH}`}
          </Fact>
          {who && <Fact term="Who pays">{who}</Fact>}
          {row.cumulativeVendorTransfer && (
            <Fact term="Transfers · cumulative">
              {nativeLabel(
                row.cumulativeVendorTransfer.amount,
                row.cumulativeVendorTransfer.currency
              )}
            </Fact>
          )}
        </dl>
      </kit.DialogContent>
    </kit.Dialog>
  );
}

type Phase = "idle" | "submitting" | "pending" | "success" | "reverted" | "rejected" | "unknown";

/** One withdrawal state per report/account, shared by every responsive control. */
function useStewardWithdrawal(fundSteward: FinanceActions["fundSteward"]) {
  const inFlight = useRef(false);
  const [amount, setAmount] = useState("1");
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = Number(amount) > 0 && Number.isFinite(Number(amount));
  async function submit() {
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    setPhase("submitting");
    setError(null);
    setTxHash(null);
    try {
      const result = readStewardWithdrawal(await fundSteward(Number(amount)));
      if (!result) throw new Error("Withdrawal response missing valid transaction evidence");
      setTxHash(result.txHash);
      setPhase(result.receiptStatus);
      if (result.receiptStatus === "success") inFlight.current = false;
    } catch (err) {
      const broadcast = readStewardWithdrawal(err);
      if (broadcast) {
        setTxHash(broadcast.txHash);
        setPhase("pending");
      } else if (isStewardWithdrawalRejected(err)) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("rejected");
        inFlight.current = false;
      } else {
        // The request may have been accepted before the response was lost; never allow a blind second send.
        setError(err instanceof Error && err.message ? err.message : null);
        setPhase("unknown");
      }
    }
  }
  const locked = phase === "submitting" || phase === "pending" || phase === "unknown" || phase === "reverted";
  function acknowledge() {
    inFlight.current = false;
    setPhase("idle");
  }
  return { amount, setAmount, phase, txHash, error, valid, submit, locked, acknowledge };
}

type WithdrawalState = ReturnType<typeof useStewardWithdrawal>;

function FundSteward({ kit, withdrawal, stewardWalletUrl }: {
  kit: FinanceKit;
  withdrawal: WithdrawalState;
  stewardWalletUrl?: string | null | undefined;
}) {
  const id = useId();
  const { amount, setAmount, phase, txHash, error, valid, submit, locked, acknowledge } = withdrawal;
  const alertId = `${id}-alert`;
  const describedBy =
    phase === "unknown" || phase === "pending" || phase === "reverted" || phase === "rejected" ? alertId : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Fund steward (USD)
        </label>
        <kit.Input
          id={id}
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          aria-label="Fund steward (USD)"
          aria-describedby={describedBy}
          className="h-9 w-20 text-sm tabular-nums"
          value={amount}
          onChange={(e: { target: { value: string } }) =>
            setAmount(e.target.value)
          }
          disabled={locked}
        />
        <kit.Button
          size="sm"
          className="h-9 whitespace-nowrap"
          onClick={submit}
          disabled={locked || !valid}
          aria-describedby={describedBy}
        >
          {phase === "submitting" ? "Funding…" : "Fund steward"}
        </kit.Button>
      </div>
      {(phase === "success" || phase === "pending" || phase === "reverted") && txHash ? (
        <output aria-live="polite" className="block">
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cx("inline-flex items-center gap-1 font-mono text-xs hover:underline", phase === "success" ? "text-success" : "text-muted-foreground")}
          >
            {phase === "reverted" ? "Transaction" : "Sent"} {txHash.slice(0, 6)}…{txHash.slice(-4)}
            <ExternalIcon />
          </a>
          {phase === "pending" ? (
            <span className="ml-2 text-muted-foreground text-xs">
              Confirming…
            </span>
          ) : null}
        </output>
      ) : null}
      {phase === "rejected" && error ? (
        <span id={alertId} role="alert" className="text-destructive text-xs">
          {error}
        </span>
      ) : null}
      {phase === "unknown" || phase === "pending" || phase === "reverted" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span id={alertId} role="alert" className="text-warning text-xs">
            {phase === "pending" ? "Confirmation pending" : phase === "reverted" ? "Transfer reverted" : "Result unknown"}{error ? ` (${error})` : ""} — check the steward wallet
            {stewardWalletUrl ? (
              <>
                {" "}
                <a
                  href={stewardWalletUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline"
                >
                  on BaseScan
                  <ExternalIcon />
                </a>
              </>
            ) : (
              " on BaseScan"
            )}{" "}
            before sending again
          </span>
          <kit.Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={acknowledge}
          >
            I checked
          </kit.Button>
        </div>
      ) : null}
    </div>
  );
}

function TopUp({
  kit,
  href,
  label,
}: {
  kit: FinanceKit;
  href: string;
  label: string;
}) {
  return (
    <kit.Button asChild variant="outline" size="sm" className="h-9">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalIcon />
      </a>
    </kit.Button>
  );
}

/** The Action cell: a live control only for a `supported` rail; otherwise the greyed rail label. */
function RowAction({
  row,
  kit,
  withdrawal,
  stewardWalletUrl,
}: {
  row: MoneyPlaneRow;
  kit: FinanceKit;
  withdrawal: WithdrawalState;
  stewardWalletUrl?: string | null | undefined;
}) {
  const rail: Rail | undefined = row.rail;
  const action: PayAction | undefined = row.payAction;
  if (rail && rail.status !== "supported") {
    return (
      <span className="text-muted-foreground text-xs">
        {railLabel(rail)}
        <span className="sr-only"> · {rail.status}</span>
      </span>
    );
  }
  if (action?.kind === "fund-steward")
    return (
      <FundSteward
        kit={kit}
        withdrawal={withdrawal}
        stewardWalletUrl={stewardWalletUrl}
      />
    );
  if (action?.kind === "steward-checkout")
    return <TopUp kit={kit} href={action.checkoutUrl} label="Top up" />;
  if (action?.kind === "external")
    return <TopUp kit={kit} href={action.url} label={action.label || "Top up"} />;
  if (rail) {
    return (
      <span className="text-muted-foreground text-xs">{railLabel(rail)}</span>
    );
  }
  return null;
}

type SortKey = "line" | "balance" | "burn" | "runway";
type Sort = { key: SortKey; desc: boolean } | null;

function sortValue(row: MoneyPlaneRow, key: SortKey): number | string | undefined {
  if (key === "line") return row.label;
  if (key === "balance") return usdBalance(row);
  if (key === "burn") return usdBurn(row);
  return runway(row);
}

function sortRows(rows: MoneyPlaneRow[], sort: Sort): MoneyPlaneRow[] {
  const ordered = [...rows].sort(byRisk);
  if (!sort) return ordered;
  return ordered.sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    const cmp =
      typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
    return sort.desc ? -cmp : cmp;
  });
}

function SortHeader({
  title,
  column,
  sort,
  onSort,
  className,
}: {
  title: string;
  column: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort?.key === column;
  return (
    <th
      scope="col"
      className={cx("px-3 py-2 text-left font-medium", className)}
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-sm text-muted-foreground text-xs hover:text-foreground"
        onClick={() => onSort(column)}
      >
        {title}
        <span aria-hidden="true" className="text-[10px]">
          {active ? (sort.desc ? "▼" : "▲") : "⇅"}
        </span>
      </button>
    </th>
  );
}

function days(value: number): string {
  return value < 1 ? "<1d" : `${Math.floor(value)}d`;
}

/** The four stat cards above the table; a missing figure is a muted dash, never a guess. */
function StatCards({
  summary,
  rows,
  kit,
}: {
  summary: ReportSummary;
  rows: MoneyPlaneRow[];
  kit: FinanceKit;
}) {
  const deadlineRow = summary.nextDeadline
    ? rows
        .flatMap((row) => [row, ...(row.children ?? [])])
        .find((row) => row.label === summary.nextDeadline?.label)
    : undefined;
  const runwayValue =
    summary.runwayDays !== null && Number.isFinite(summary.runwayDays)
      ? days(summary.runwayDays)
      : DASH;
  const stats: {
    label: string;
    value: string;
    sub: string;
    className?: string;
    extra?: { text: string; className?: string };
  }[] = [
    {
      label: "Treasury",
      value: summary.treasuryUsd === null ? DASH : usd(summary.treasuryUsd),
      sub: "USDC on Base",
    },
    {
      label: "Cash received",
      value:
        dailyUsd(summary.incomePerDay),
      sub: summary.incomeCoverageGaps.length
        ? `partial receipts · ${summary.incomeCoverageGaps.length} ${summary.incomeCoverageGaps.length === 1 ? "gap" : "gaps"} · ${summary.windowDays}d`
        : `credit purchases · ${summary.windowDays}d`,
    },
    {
      label: "Burn",
      value: dailyUsd(summary.burnPerDay),
      sub: summary.costCoverageGaps.length
        ? `known subtotal · ${summary.costCoverageGaps.length} gaps`
        : "all known lines",
    },
    {
      label: "Runway",
      value: runwayValue,
      sub: summary.runwayReason === "costs_incomplete" ? "Costs incomplete"
        : summary.runwayReason === "treasury_unreadable" ? "Treasury unreadable"
        : summary.runwayReason === "no_measured_burn" ? "No measured burn"
        : summary.runwayReason === "estimate_unavailable" ? "Estimate unavailable"
        : "known-cost estimate",
      ...(summary.nextDeadline
        ? {
            extra: {
              text: `Next deadline ${days(summary.nextDeadline.days)} · ${summary.nextDeadline.label}`,
              ...(deadlineRow ? { className: runwayClass(deadlineRow.grade) } : {}),
            },
          }
        : {}),
    },
  ];
  return (
    <div
      className="@2xl:grid-cols-4 grid grid-cols-2 gap-3"
      data-finance-summary
    >
      {stats.map((stat) => (
        <kit.Card key={stat.label} className="py-0">
          <kit.CardContent className="space-y-1 p-4">
            <p className="text-muted-foreground text-xs">{stat.label}</p>
            <p
              className={cx(
                "font-semibold text-2xl tabular-nums tracking-tight",
                stat.value === DASH ? "text-muted-foreground" : stat.className
              )}
              data-finance-stat={stat.label}
            >
              {stat.value}
            </p>
            <p className="text-muted-foreground text-xs">{stat.sub}</p>
            {stat.extra ? (
              <p
                className={cx("text-xs", stat.extra.className ?? "text-muted-foreground")}
                data-finance-deadline
              >
                {stat.extra.text}
              </p>
            ) : null}
          </kit.CardContent>
        </kit.Card>
      ))}
    </div>
  );
}

function fxLine(summary: ReportSummary): string {
  const rates = summary.ratesUsed.map(
    (r) => `${r.pair.slice(0, 3)}→${r.pair.slice(3)} ${r.value} · ${r.source} ${r.date}`
  );
  const missing = summary.unconverted.length
    ? [`not converted: ${summary.unconverted.join(", ")}`]
    : [];
  return [...rates, ...missing].join(" · ");
}

export function FinanceReport({
  report,
  summary,
  kit,
  actions,
  formatTime,
  thisNode = "Operator",
}: FinanceReportProps) {
  const timeZone = useViewerTimeZone();
  const withdrawal = useStewardWithdrawal(actions.fundSteward);
  const [sort, setSort] = useState<Sort>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        group,
        rows: sortRows(
          report.rows.filter((row) => groupOf(row) === group),
          sort
        ),
      })).filter((g) => g.rows.length > 0),
    [report.rows, sort]
  );
  const all = report.rows.flatMap((row) => [row, ...(row.children ?? [])]);
  const hasBurn = all.some((row) => row.burnPerDay !== null);
  const hasRunway = all.some((row) => row.runwayDays !== null);
  const refreshed = formatTime
    ? formatTime(report.takenAt, "refreshed")
    : refreshedLabel(report.takenAt, timeZone);
  const fx = fxLine(summary);
  const columns = 2 + (hasBurn ? 1 : 0) + (hasRunway ? 1 : 0) + 1;

  function onSort(key: SortKey) {
    setSort((current) =>
      current?.key !== key
        ? { key, desc: false }
        : current.desc
          ? null
          : { key, desc: true }
    );
  }
  async function refresh() {
    if (!actions.refresh) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setMessage("You're offline. Reconnect to refresh this report.");
      return;
    }
    setRefreshing(true);
    setMessage("");
    try {
      await actions.refresh();
      setMessage("Refresh requested.");
    } catch {
      setMessage("Refresh failed. Try again.");
    } finally {
      setRefreshing(false);
    }
  }
  const toggle = (plane: string) =>
    setExpanded((e) => ({ ...e, [plane]: !e[plane] }));

  const cell = (text: string, className?: string) => (
    <span
      className={cx(
        "font-medium text-sm tabular-nums",
        text === DASH ? "text-muted-foreground" : "",
        className
      )}
    >
      {text}
    </span>
  );
  const runwayCell = (row: MoneyPlaneRow) => {
    const label = runwayLabel(row);
    return cell(label, label === DASH ? undefined : runwayClass(row.grade));
  };

  return (
    <div className="@container w-full min-w-0 space-y-5" data-finance-report>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-semibold text-2xl tracking-tight">Financials</h1>
          <p className="text-muted-foreground text-xs">Refreshed {refreshed}</p>
        </div>
        {actions.refresh && (
          <kit.Button
            variant="outline"
            className="min-h-11"
            disabled={refreshing}
            onClick={refresh}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </kit.Button>
        )}
        <output className="sr-only" aria-live="polite">
          {refreshing
            ? "Refreshing report."
            : message
              ? `${message} Refreshed ${refreshed}.`
              : ""}
        </output>
      </header>
      <StatCards summary={summary} rows={report.rows} kit={kit} />
      {fx && (
        <p className="text-muted-foreground text-xs" data-finance-fx>
          {fx}
        </p>
      )}

      <section className="@2xl:block hidden min-w-0" aria-label="Financials table">
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full table-auto border-collapse text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortHeader title="Line" column="line" sort={sort} onSort={onSort} />
                <SortHeader title="Balance" column="balance" sort={sort} onSort={onSort} />
                {hasBurn && (
                  <SortHeader title="Burn/day" column="burn" sort={sort} onSort={onSort} />
                )}
                {hasRunway && (
                  <SortHeader title="Runway" column="runway" sort={sort} onSort={onSort} />
                )}
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground text-xs">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map(({ group, rows }) => (
                <GroupRows
                  key={group}
                  group={group}
                  rows={rows}
                  columns={columns}
                  expanded={expanded}
                  toggle={toggle}
                  hasBurn={hasBurn}
                  hasRunway={hasRunway}
                  cell={cell}
                  runwayCell={runwayCell}
                  kit={kit}
                  withdrawal={withdrawal}
                  timeZone={timeZone}
                  formatTime={formatTime}
                  thisNode={thisNode}
                  stewardWalletUrl={report.stewardWalletUrl}
                />
              ))}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={columns} className="px-3 py-6 text-center text-muted-foreground">
                    No money planes configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="@2xl:hidden min-w-0 space-y-4" aria-label="Financials list">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sort financials">
          {([
            { key: "balance", label: "Balance", show: true },
            { key: "burn", label: "Burn/day", show: hasBurn },
            { key: "runway", label: "Runway", show: hasRunway },
          ] as const).filter((option) => option.show).map(({ key, label }) => (
            <kit.Button
              key={key}
              type="button"
              variant={sort?.key === key ? "secondary" : "outline"}
              size="sm"
              className="min-h-11"
              aria-label={`Sort by ${label}`}
              aria-pressed={sort?.key === key}
              onClick={() => onSort(key)}
            >
              {label}{sort?.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
            </kit.Button>
          ))}
          <output className="sr-only" aria-live="polite">
            {sort ? `Sorted by ${sort.key}, ${sort.desc ? "descending" : "ascending"}` : "Sorted by risk"}
          </output>
        </div>
        {groups.map(({ group, rows }) => (
          <section key={group} className="space-y-2" aria-label={group}>
            <h2 className="text-muted-foreground text-xs uppercase tracking-wide">{group}</h2>
            <ul className="space-y-3">
              {rows.map((row) => (
                <li key={row.plane} className="rounded-md border border-border p-4">
                  <div className="min-w-0 space-y-3">
                    <div className="flex items-start gap-2">
                      {row.children?.length ? (
                        <button
                          type="button"
                          className="mt-0.5 rounded-sm"
                          aria-expanded={Boolean(expanded[row.plane])}
                          aria-label={`${expanded[row.plane] ? "Collapse" : "Expand"} ${row.label}`}
                          onClick={() => toggle(row.plane)}
                        >
                          <Chevron open={Boolean(expanded[row.plane])} />
                        </button>
                      ) : null}
                      <LineDialog row={row} kit={kit} timeZone={timeZone} formatTime={formatTime} thisNode={thisNode} />
                    </div>
                    <dl className="grid min-w-0 grid-cols-3 gap-2">
                      <div>
                        <dt className="text-muted-foreground text-xs">Balance</dt>
                        <dd>{cell(balanceLabel(row))}</dd>
                      </div>
                      {hasBurn && (
                        <div>
                          <dt className="text-muted-foreground text-xs">Burn/day</dt>
                          <dd>{cell(burnLabel(row))}</dd>
                        </div>
                      )}
                      {hasRunway && (
                        <div>
                          <dt className="text-muted-foreground text-xs">Runway</dt>
                          <dd>{runwayCell(row)}</dd>
                        </div>
                      )}
                    </dl>
                    {expanded[row.plane] && row.children?.length ? (
                      <ul className="space-y-1 border-border border-l pl-3">
                        {row.children.map((child) => (
                          <li key={child.plane} className="flex items-center justify-between gap-2 text-sm">
                            <LineDialog row={child} kit={kit} timeZone={timeZone} formatTime={formatTime} thisNode={thisNode} child />
                            {cell(burnLabel(child))}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {(row.rail || row.payAction) && (
                      <div className="border-border border-t pt-3">
                        <RowAction row={row} kit={kit} withdrawal={withdrawal} stewardWalletUrl={report.stewardWalletUrl} />
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>
    </div>
  );
}

function GroupRows({
  group,
  rows,
  columns,
  expanded,
  toggle,
  hasBurn,
  hasRunway,
  cell,
  runwayCell,
  kit,
  withdrawal,
  timeZone,
  formatTime,
  thisNode,
  stewardWalletUrl,
}: {
  group: Group;
  rows: MoneyPlaneRow[];
  columns: number;
  expanded: Record<string, boolean>;
  toggle: (plane: string) => void;
  hasBurn: boolean;
  hasRunway: boolean;
  cell: (text: string, className?: string) => ReactNode;
  runwayCell: (row: MoneyPlaneRow) => ReactNode;
  kit: FinanceKit;
  withdrawal: WithdrawalState;
  timeZone: string | undefined;
  formatTime: FinanceReportProps["formatTime"];
  thisNode: string;
  stewardWalletUrl?: string | null | undefined;
}) {
  return (
    <>
      <tr className="border-border border-t bg-muted/30" data-finance-group={group}>
        <th
          scope="rowgroup"
          colSpan={columns}
          className="px-3 py-1.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide"
        >
          {group}
        </th>
      </tr>
      {rows.map((row) => {
        const open = Boolean(expanded[row.plane]);
        return (
          <RowGroup key={row.plane}>
            <tr className="border-border border-t align-middle" data-finance-row={row.plane}>
              <td className="px-3 py-2">
                <div className="flex items-start gap-2">
                  {row.children?.length ? (
                    <button
                      type="button"
                      className="mt-0.5 rounded-sm"
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${row.label}`}
                      onClick={() => toggle(row.plane)}
                    >
                      <Chevron open={open} />
                    </button>
                  ) : null}
                  <LineDialog row={row} kit={kit} timeZone={timeZone} formatTime={formatTime} thisNode={thisNode} />
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2">{cell(balanceLabel(row))}</td>
              {hasBurn && <td className="whitespace-nowrap px-3 py-2">{cell(burnLabel(row))}</td>}
              {hasRunway && <td className="whitespace-nowrap px-3 py-2">{runwayCell(row)}</td>}
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end">
                  <RowAction
                    row={row}
                    kit={kit}
                    withdrawal={withdrawal}
                    stewardWalletUrl={stewardWalletUrl}
                  />
                </div>
              </td>
            </tr>
            {open &&
              row.children?.map((child) => (
                <tr
                  key={child.plane}
                  className="border-border border-t border-dashed bg-muted/20"
                  data-finance-child={child.plane}
                >
                  <td className="py-1.5 pr-3 pl-10">
                    <LineDialog row={child} kit={kit} timeZone={timeZone} formatTime={formatTime} thisNode={thisNode} child />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">{cell(balanceLabel(child))}</td>
                  {hasBurn && <td className="whitespace-nowrap px-3 py-1.5">{cell(burnLabel(child))}</td>}
                  {hasRunway && <td className="whitespace-nowrap px-3 py-1.5">{runwayCell(child)}</td>}
                  <td />
                </tr>
              ))}
          </RowGroup>
        );
      })}
    </>
  );
}

function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
