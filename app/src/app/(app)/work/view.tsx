// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/view`
 * Purpose: Work dashboard with ReUI Kanban and DataGrid sharing one TanStack
 *          filter, sort, pagination, and detail-navigation model.
 * Scope: Presentation. Fetches data via React Query.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in
 *     the column header dropdown (see `_components/columns.tsx`).
 *   - SINGLE_COLUMNS_TOGGLE — visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search persist in URL params.
 *   - CONTRACTS_ARE_TRUTH — types derived from `WorkItemDto`.
 * Side-effects: IO (fetches from /api/v1/work/items)
 * Links: [WorkPage](./page.tsx), [fetchWorkItems](./_api/fetchWorkItems.ts)
 * @public
 */

"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import { VALID_TRANSITIONS } from "@cogni/work-items";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@cogni/node-ui-kit/shadcn/dropdown-menu";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@cogni/node-ui-kit/shadcn/select";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useIsMobile } from "@cogni/node-ui-kit/util/use-is-mobile";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { Columns3, List, Settings2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "@/components";

import { type WorkIntent, useWorkNavigation } from "./WorkNavigationBoundary";
import { fetchWorkItem, fetchWorkItems } from "./_api/fetchWorkItems";
import { columns, WorkFacetControls, WorkRankControls } from "./_components/columns";
import { WorkItemDetail } from "./_components/WorkItemDetail";
import { WorkKanban } from "./_components/WorkKanban";
import {
  workItemHref,
  workListHref,
  workViewHref,
} from "./_lib/workItemNavigation";

const ALL_STATUSES = [...VALID_TRANSITIONS.keys()];
const ACTIVE_STATUSES = ALL_STATUSES.filter(
  (status) => status !== "done" && status !== "cancelled",
);
const EMPTY_ITEMS: WorkItemDto[] = [];
const HISTORY_STORAGE_KEY = "work-page-history";

function readFilters(searchParams: URLSearchParams): ColumnFiltersState {
  const filters: ColumnFiltersState = [];
  const typeParam = searchParams.get("type");
  if (typeParam) filters.push({ id: "type", value: typeParam.split(",") });
  const statusParam = searchParams.get("status");
  if (statusParam && statusParam !== "all") {
    filters.push({ id: "status", value: statusParam.split(",") });
  } else if (!statusParam) {
    filters.push({ id: "status", value: ACTIVE_STATUSES });
  }
  const projectParam = searchParams.get("project");
  if (projectParam)
    filters.push({ id: "projectId", value: projectParam.split(",") });
  const numberParam = (key: string) => {
    const raw = searchParams.get(key);
    if (!raw?.trim()) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const rankRange = [numberParam("rankMin"), numberParam("rankMax")];
  if (rankRange.some((value) => value !== undefined)) {
    filters.push({ id: "rankScore", value: rankRange });
  }
  return filters;
}

function readSorting(searchParams: URLSearchParams): SortingState {
  const sortParam = searchParams.get("sort");
  if (sortParam) {
    const desc = sortParam.startsWith("-");
    const id = desc ? sortParam.slice(1) : sortParam;
    return [{ id, desc }];
  }
  return [{ id: "rankScore", desc: true }];
}

// bug.0006: phones show Item (title + id) and Status; the Columns toggle can
// still reveal the rest. Explicit user choices win over this default.
const MOBILE_HIDDEN_COLUMNS: VisibilityState = {
  priority: false,
  rankScore: false,
  type: false,
  projectId: false,
  updatedAt: false,
  estimate: false,
};

function readColumns(params: URLSearchParams): string[] {
  const value = params.get("columns");
  return value === null
    ? [...ACTIVE_STATUSES]
    : value
        .split(",")
        .filter((status) =>
          ALL_STATUSES.includes(status as (typeof ALL_STATUSES)[number]),
        );
}

function intentHref(intent: WorkIntent): string {
  return intent.itemId
    ? workItemHref(intent.itemId, intent.params)
    : workListHref(intent.params);
}

export function WorkDashboardView({
  selectedItemId,
}: {
  readonly selectedItemId?: string;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const committedSearch = searchParams.toString();
  const actualHref = selectedItemId
    ? workItemHref(selectedItemId, searchParams)
    : workListHref(searchParams);
  const initialFilters = useMemo(
    () => readFilters(new URLSearchParams(committedSearch)),
    [committedSearch],
  );
  const initialSorting = useMemo(
    () => readSorting(new URLSearchParams(committedSearch)),
    [committedSearch],
  );
  const {
    desired, setDesired, columnVisibility, setColumnVisibility, history, setHistory,
    isNavigating, startNavigation, settledOperation, setSettledOperation,
    navigationLocked, setNavigationLocked, navigation,
  } = useWorkNavigation();
  const sorting = useMemo(() => readSorting(desired.params), [desired]);
  const columnFilters = useMemo(() => readFilters(desired.params), [desired]);
  const globalFilter = desired.params.get("q") ?? "";
  const visibleStatuses = readColumns(desired.params);
  const isMobile = useIsMobile();
  const tableColumnVisibility = useMemo(
    () =>
      isMobile
        ? { ...MOBILE_HIDDEN_COLUMNS, ...columnVisibility }
        : columnVisibility,
    [isMobile, columnVisibility],
  );
  const boardView = desired.params.get("view") !== "table";
  const pageSize = Number(searchParams.get("pageSize")) || 10;
  const cursor = searchParams.get("cursor") ?? "";
  const selectedItemQuery = useQuery({
    queryKey: ["work-item", selectedItemId],
    queryFn: () => fetchWorkItem(selectedItemId as string),
    enabled: selectedItemId !== undefined,
    retry: false,
    staleTime: 30_000,
  });
  const listParams = useMemo(() => {
    const params = new URLSearchParams({ limit: String(pageSize) });
    const values = (id: string) =>
      initialFilters.find((f) => f.id === id)?.value as string[] | undefined;
    for (const [id, key] of [
      ["type", "types"],
      ["status", "statuses"],
      ["projectId", "projectIds"],
    ] as const) {
      const value = values(id);
      if (value?.length) params.set(key, value.join(","));
    }
    const range = initialFilters.find((f) => f.id === "rankScore")?.value as
      | [number | undefined, number | undefined]
      | undefined;
    if (range?.[0] !== undefined) params.set("rankMin", String(range[0]));
    if (range?.[1] !== undefined) params.set("rankMax", String(range[1]));
    const sort = initialSorting[0];
    if (sort) {
      params.set("sortBy", sort.id);
      params.set("sortDirection", sort.desc ? "desc" : "asc");
    }
    const query = searchParams.get("q");
    if (query) params.set("text", query);
    if (cursor) params.set("cursor", cursor);
    return params;
  }, [initialFilters, initialSorting, searchParams, pageSize, cursor]);
  const historyKey = useMemo(() => {
    const p = new URLSearchParams(listParams);
    p.delete("cursor");
    return `work-page-history:${p}`;
  }, [listParams]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["work-items", listParams.toString()],
    queryFn: () => fetchWorkItems(listParams),
    staleTime: 30_000,
  });
  const items = data?.items ?? EMPTY_ITEMS;
  const dispatchNavigation = useCallback(
    (intent: WorkIntent, stack?: string[]) => {
      const owner = navigation.current;
      const to = intentHref(intent);
      if (owner.flight || isNavigating || to === owner.committed?.href) return;
      const flight = {
        id: ++owner.sequence,
        to,
        stack: stack ?? (intent.resetHistory ? [] : undefined),
        failed: false,
        committed: false,
      };
      owner.flight = flight;
      // A push belongs to this dispatch; later edits default to replacement.
      owner.desired = {
        ...owner.desired,
        method: "replace",
        resetHistory: false,
      };
      setNavigationLocked(true);
      startNavigation(() => {
        // This marker commits in this operation's transition lane. Unlike an old
        // isPending=false render it can also identify settlement without a URL change.
        setSettledOperation(flight.id);
        try {
          router[intent.method](to, { scroll: false });
        } catch {
          flight.failed = true;
        }
      });
    },
    [isNavigating, router, navigation, setNavigationLocked, setSettledOperation, startNavigation],
  );

  useEffect(() => {
    const owner = navigation.current;
    const flight = owner.flight;
    const previous = owner.committed;
    const reached = flight?.to === actualHref && !flight.failed;
    const external =
      previous !== null && actualHref !== previous.href && !reached;
    if (!previous || actualHref !== previous.href) {
      let stack =
        previous?.key === historyKey && previous.cursor === cursor
          ? previous.stack
          : [];
      if (reached) {
        stack =
          flight.stack ?? (previous?.key === historyKey ? previous.stack : []);
        flight.committed = true;
      } else if (stack !== previous?.stack) {
        try {
          // Retire older multi-record snapshots without depending on storage.
          for (const key of Object.keys(sessionStorage)) {
            if (key.startsWith("work-page-history:"))
              sessionStorage.removeItem(key);
          }
          const record = JSON.parse(
            sessionStorage.getItem(HISTORY_STORAGE_KEY) ?? "{}",
          );
          if (
            record?.key === historyKey &&
            record.cursor === cursor &&
            Array.isArray(record.history) &&
            record.history.length <= 20 &&
            record.history.every(
              (item: unknown) =>
                typeof item === "string" && item.length <= 2048,
            )
          )
            stack = record.history;
        } catch {
          /* Storage is optional. */
        }
      }
      owner.committed = { href: actualHref, key: historyKey, cursor, stack };
      setHistory(stack);
      if (reached) {
        try {
          sessionStorage.setItem(
            HISTORY_STORAGE_KEY,
            JSON.stringify({ key: historyKey, cursor, history: stack }),
          );
        } catch {
          /* Storage is optional. */
        }
      }
    }
    const settled = flight && settledOperation === flight.id && !isNavigating;
    if (external || flight?.failed || (settled && !flight.committed)) {
      // An external winner or abandoned request invalidates all its proposals.
      owner.flight = null;
      owner.desired = {
        params: new URLSearchParams(committedSearch),
        itemId: selectedItemId,
        method: "replace",
      };
      setDesired(owner.desired);
      setNavigationLocked(false);
    } else if (settled) {
      owner.flight = null;
      setNavigationLocked(false);
      if (intentHref(owner.desired) !== actualHref)
        dispatchNavigation(owner.desired);
    } else if (
      !owner.flight &&
      !isNavigating &&
      intentHref(owner.desired) !== actualHref
    ) {
      dispatchNavigation(owner.desired);
    }
  }, [
    actualHref,
    committedSearch,
    cursor,
    historyKey,
    isNavigating,
    settledOperation,
    selectedItemId,
    dispatchNavigation,
    navigation,
    setHistory,
    setDesired,
    setNavigationLocked,
  ]);

  const editIntent = useCallback(
    (update: (intent: WorkIntent) => WorkIntent) => {
      const owner = navigation.current;
      // Every updater reads the latest draft, including edits made in this tick.
      owner.desired = update({
        ...owner.desired,
        params: new URLSearchParams(owner.desired.params),
      });
      setDesired(owner.desired);
      dispatchNavigation(owner.desired);
    },
    [dispatchNavigation, navigation, setDesired],
  );

  const editList = (
    update: (state: {
      filters: ColumnFiltersState;
      sorting: SortingState;
      query: string;
    }) => void,
  ) => {
    editIntent((intent) => {
      const state = {
        filters: readFilters(intent.params),
        sorting: readSorting(intent.params),
        query: intent.params.get("q") ?? "",
      };
      update(state);
      const valuesFor = (id: string): readonly string[] => {
        const value = state.filters.find((filter) => filter.id === id)?.value;
        return Array.isArray(value) ? (value as string[]) : [];
      };
      const sort = state.sorting[0];
      const href = workViewHref(intent.itemId, intent.params, {
        type: valuesFor("type"),
        status: valuesFor("status"),
        project: valuesFor("projectId"),
        sort: sort ? `${sort.desc ? "-" : ""}${sort.id}` : null,
        query: state.query,
        rankRange: (state.filters.find((filter) => filter.id === "rankScore")
          ?.value as [number | undefined, number | undefined] | undefined) ?? [
          undefined,
          undefined,
        ],
      });
      return {
        ...intent,
        params: new URL(href, window.location.origin).searchParams,
        resetHistory: true,
      };
    });
  };

  const changePage = (action: "next" | "previous" | "restart") => {
    const owner = navigation.current;
    const committed = owner.committed;
    if (
      owner.flight ||
      isNavigating ||
      !committed ||
      committed.href !== actualHref ||
      intentHref(owner.desired) !== actualHref
    )
      return;
    let next = "";
    let stack: string[] = [];
    if (action === "next") {
      if (!(data?.pageInfo?.hasMore ?? Boolean(data?.nextCursor))) return;
      next = data?.pageInfo?.endCursor ?? data?.nextCursor ?? "";
      if (!next) return;
      stack = [...committed.stack, committed.cursor].slice(-20);
    } else if (action === "previous") {
      if (!committed.cursor || !committed.stack.length) return;
      next = committed.stack[committed.stack.length - 1] ?? "";
      stack = committed.stack.slice(0, -1);
    } else if (!committed.cursor) return;
    const params = new URLSearchParams(committedSearch);
    if (next) params.set("cursor", next);
    else params.delete("cursor");
    owner.desired = { params, itemId: selectedItemId, method: "replace" };
    setDesired(owner.desired);
    dispatchNavigation(owner.desired, stack);
  };

  const openItem = useCallback(
    (item: WorkItemDto) => {
      editIntent((intent) => ({ ...intent, itemId: item.id, method: "push" }));
    },
    [editIntent],
  );
  const closeItem = useCallback(() => {
    editIntent((intent) => ({
      ...intent,
      itemId: undefined,
      method: "replace",
    }));
  }, [editIntent]);

  const table = useReactTable({
    data: items,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility: tableColumnVisibility,
    },
    onSortingChange: (updater) =>
      editList((state) => {
        state.sorting =
          typeof updater === "function" ? updater(state.sorting) : updater;
      }),
    onColumnFiltersChange: (updater) =>
      editList((state) => {
        state.filters =
          typeof updater === "function" ? updater(state.filters) : updater;
      }),
    onGlobalFilterChange: (query) =>
      editList((state) => {
        state.query = query;
      }),
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const q = filterValue.toLowerCase();
      const d = row.original;
      return (
        d.id.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.labels.some((l: string) => l.toLowerCase().includes(q))
      );
    },
  });

  const rows = table.getRowModel().rows;
  const navigationRows = boardView
    ? rows.filter((row) => visibleStatuses.includes(row.original.status))
    : rows;
  const navigationKey = JSON.stringify([boardView, navigationRows.map((row) => row.id)]);

  const [focus, setFocus] = useState({ key: "", index: -1 });
  const focusedRowIndex = focus.key === navigationKey ? focus.index : -1;
  useEffect(() => {
    setFocus((previous) => previous.key === navigationKey ? previous : { key: navigationKey, index: -1 });
  }, [navigationKey]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement &&
          e.target.closest(
            "button, a, select, summary, [contenteditable=true], [role^=menuitem], [role=combobox], [role=checkbox], [role=option], [role=slider], [role=spinbutton]",
          ))
      )
        return;
      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocus({ key: navigationKey, index: Math.min(focusedRowIndex + 1, navigationRows.length - 1) });
          break;
        case "k":
          e.preventDefault();
          setFocus({ key: navigationKey, index: navigationRows.length ? Math.max(focusedRowIndex - 1, 0) : -1 });
          break;
        case "Enter":
          if (focusedRowIndex >= 0 && focusedRowIndex < navigationRows.length) {
            const row = navigationRows[focusedRowIndex];
            if (row) {
              e.preventDefault();
              openItem(row.original);
            }
          }
          break;
        case "/":
          e.preventDefault();
          document
            .querySelector<HTMLInputElement>("[data-search-input]")
            ?.focus();
          break;
        case "Escape":
          if (selectedItemId) {
            closeItem();
          }
          break;
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [navigationRows, navigationKey, focusedRowIndex, selectedItemId, openItem, closeItem]);

  const hasActiveFilters = columnFilters.length > 0;

  const setView = (view: "board" | "table") => {
    editIntent((intent) => {
      intent.params.set("view", view);
      return intent;
    });
  };

  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
        Work Dashboard
      </h1>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-search-input
          className="h-9 w-full sm:w-56"
          placeholder="Search id, title, labels... ( / )"
          value={globalFilter}
          onChange={(e) => {
            editList((state) => { state.query = e.target.value; });
          }}
        />
        {hasActiveFilters && (
          <button
            type="button"
            className="inline-flex min-h-6 items-center text-muted-foreground text-xs underline hover:text-foreground"
            onClick={() => {
              editList((state) => { state.filters = []; });
            }}
          >
            Clear filters
          </button>
        )}
        {boardView && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Board columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {ALL_STATUSES.map((status) => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={visibleStatuses.includes(status)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => {
                    editIntent((intent) => {
                      const current = readColumns(intent.params);
                      const next = checked ? [...current, status] : current.filter((value) => value !== status);
                      intent.params.set("columns", next.join(","));
                      return intent;
                    });
                  }}
                >
                  {status.replace("needs_", "").replaceAll("_", " ")}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="ml-auto flex items-center gap-2">
          <fieldset
            className="inline-flex min-w-0 rounded-lg border bg-muted/30 p-1"
            aria-label="Work view"
          >
            <Button
              variant={boardView ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1.5"
              aria-pressed={boardView}
              onClick={() => setView("board")}
            >
              <Columns3 className="size-3.5" />
              Board
            </Button>
            <Button
              variant={boardView ? "ghost" : "secondary"}
              size="sm"
              className="h-7 gap-1.5"
              aria-pressed={!boardView}
              onClick={() => setView("table")}
            >
              <List className="size-3.5" />
              Table
            </Button>
          </fieldset>
          {!boardView && (
            <DataGridColumnVisibility
              table={table}
              trigger={
                <Button variant="outline" size="sm" className="h-9 gap-1.5">
                  <Settings2 className="size-3.5" />
                  Columns
                </Button>
              }
            />
          )}
        </div>
      </div>

      {error && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}

      <DataGrid
        table={table}
        recordCount={table.getFilteredRowModel().rows.length}
        isLoading={isLoading}
        loadingMode="skeleton"
        onRowClick={openItem}
        tableLayout={{
          // Auto layout on phones lets the visible columns share the viewport.
          width: isMobile ? "auto" : "fixed",
          headerSticky: true,
          headerBackground: true,
          rowBorder: true,
          dense: true,
        }}
        tableClassNames={{
          bodyRow: "cursor-pointer",
        }}
        emptyMessage="No work items found."
      >
        {boardView ? (
          <>
            <fieldset
              className="mb-4 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-2"
              aria-label="Board filters and sorting"
            >
              {(() => {
                const rank = table.getColumn("rankScore");
                return rank && <WorkRankControls column={rank} />;
              })()}
              {(["type", "status", "projectId"] as const).map((facet) => {
                const column = table.getColumn(facet);
                return column && <WorkFacetControls key={facet} column={column} facet={facet} />;
              })}
            </fieldset>
            {sorting[0] &&
              !["rankScore", "type", "status", "projectId"].includes(
                sorting[0].id,
              ) && (
                <div className="mb-4 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <span>
                    Sorted by {sorting[0].id} (
                    {sorting[0].desc ? "descending" : "ascending"})
                  </span>
                  <button
                    type="button"
                    className="underline hover:text-foreground"
                    onClick={() => {
                      const next = [{ id: "rankScore", desc: true }];
                      editList((state) => { state.sorting = next; });
                    }}
                  >
                    Reset to rank
                  </button>
                </div>
              )}
            <WorkKanban
              items={rows.map((row) => row.original)}
              statuses={visibleStatuses}
              isLoading={isLoading}
              onOpenItem={openItem}
            />
          </>
        ) : (
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4 text-sm">
          <span>
            {items.length} items on this page
            {boardView
              ? ` · ${items.filter((item) => visibleStatuses.includes(item.status)).length} visible cards`
              : ""}
          </span>
          <div className="flex flex-wrap gap-2">
            <Select
              value={String(Number(desired.params.get("pageSize")) || 10)}
              onValueChange={(value) => {
                editIntent((intent) => {
                  intent.params.set("pageSize", value);
                  intent.params.delete("cursor");
                  return { ...intent, resetHistory: true };
                });
              }}
            >
              <SelectTrigger aria-label="Items per page" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => changePage("restart")}
              disabled={navigationLocked || isNavigating || !cursor}
            >
              Restart
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => changePage("previous")}
              disabled={navigationLocked || isNavigating || !cursor || history.length === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => changePage("next")}
              disabled={
                navigationLocked || isNavigating ||
                !(data?.pageInfo?.hasMore ?? Boolean(data?.nextCursor)) ||
                !(data?.pageInfo?.endCursor ?? data?.nextCursor)
              }
            >
              Next
            </Button>
          </div>
        </div>
      </DataGrid>

      <WorkItemDetail
        item={selectedItemQuery.data ?? null}
        {...(selectedItemId !== undefined && { itemId: selectedItemId })}
        isLoading={selectedItemQuery.isLoading}
        error={selectedItemQuery.error}
        open={selectedItemId !== undefined}
        onOpenChange={(open) => {
          if (!open) closeItem();
        }}
      />
    </div>
  );
}
