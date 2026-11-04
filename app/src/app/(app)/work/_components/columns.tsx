// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/columns`
 * Purpose: TanStack column definitions for the work-items DataGrid.
 * Scope: Pure column descriptors + inline cells. No fetching, no router.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER: every header renders via reui
 *     `DataGridColumnHeader` so sort lives there. Discrete-value columns
 *     (type / status) inline a `HeaderFilter`; project entry uses a header
 *     popover with normal keyboard navigation.
 *   - Column visibility is NOT in the header dropdown — it lives in a single
 *     toolbar `Columns` button at top-right of `view.tsx`.
 *   - filterFn: "arrIncludesSome" on facet columns so HeaderFilter's
 *     setFilterValue(string[]) works.
 * @internal
 */

"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import { DataGridColumnHeader } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header";
import { Button } from "@cogni/node-ui-kit/shadcn/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cogni/node-ui-kit/shadcn/popover";
import { HeaderFilter } from "@cogni/node-ui-kit/header-filter";
import { rankScore, VALID_TRANSITIONS } from "@cogni/work-items";
import { type Column, createColumnHelper } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, ListFilter } from "lucide-react";
import { NumberRangeFilter } from "./NumberRangeFilter";
import { StatusPill, TypeIcon } from "./work-item-icons";

const col = createColumnHelper<WorkItemDto>();

const formatProject = (v: string) => v.replace("proj.", "");

/** App binding: the shared generic header otherwise forces ascending first. */
export function WorkItemRankHeader<TData, TValue>({
  column,
}: {
  readonly column: Column<TData, TValue>;
}) {
  const direction = column.getIsSorted();
  const Icon =
    direction === "desc"
      ? ArrowDownIcon
      : direction === "asc"
        ? ArrowUpIcon
        : ChevronsUpDownIcon;
  return (
    <Button
      variant="ghost"
      className="-ms-2 h-6 px-2 font-normal"
      onClick={() => column.toggleSorting()}
      disabled={!column.getCanSort()}
    >
      Rank <Icon className="size-3.25 opacity-60" aria-hidden="true" />
    </Button>
  );
}

export function WorkRankControls<TData, TValue>({ column }: { readonly column: Column<TData, TValue> }) {
  return <div className="flex items-center gap-1"><WorkItemRankHeader column={column} /><NumberRangeFilter column={column} label="Rank" /></div>;
}

export function WorkFacetControls<TData, TValue>({ column, facet }: { readonly column: Column<TData, TValue>; readonly facet: "type" | "status" | "projectId" }) {
  const title = facet === "type" ? "Type" : facet === "status" ? "Status" : "Project";
  return <div className="flex items-center">
    <DataGridColumnHeader column={column} title={title} />
    <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" className="h-6 min-w-6 px-1.5" aria-label={`Filter ${facet === "projectId" ? "projects" : title.toLowerCase()}`}><ListFilter className={column.getIsFiltered() ? "size-3.5 text-primary" : "size-3.5 text-muted-foreground"} /></Button></PopoverTrigger>
      <PopoverContent className="w-64" align="start"><HeaderFilter column={column} options={facet === "type" ? ["task", "bug", "story", "spike", "subtask"] : facet === "status" ? [...VALID_TRANSITIONS.keys()] : []} allowEntry={facet === "projectId"} formatLabel={facet === "status" ? (v) => v.replace("needs_", "").replaceAll("_", " ") : facet === "projectId" ? formatProject : (v) => v} showCounts={false} /></PopoverContent>
    </Popover>
  </div>;
}

export const columns = [
  col.accessor("priority", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Pri" />
    ),
    size: 60,
    cell: (info) => {
      const v = info.getValue();
      if (v == null)
        return <span className="text-muted-foreground">&mdash;</span>;
      return (
        <span className="inline-flex w-7 justify-center rounded-md bg-muted px-1.5 py-0.5 font-medium text-xs">
          P{v}
        </span>
      );
    },
    sortingFn: (a, b) => {
      const pa = a.original.priority ?? 999;
      const pb = b.original.priority ?? 999;
      return pa - pb;
    },
    meta: { headerTitle: "Pri" },
  }),

  // story.5111: WSJF rank from the package; unscored items always sort last.
  col.accessor((row) => rankScore(row.scores), {
    id: "rankScore",
    header: ({ column }) => <WorkRankControls column={column} />,
    size: 220,
    minSize: 220,
    cell: (info) => {
      const v = info.getValue();
      if (v === undefined)
        return <span className="text-muted-foreground">&mdash;</span>;
      return <span className="font-mono text-xs">{v.toFixed(1)}</span>;
    },
    sortDescFirst: true,
    sortUndefined: "last",
    filterFn: "inNumberRange",
    meta: { headerTitle: "Rank" },
  }),

  col.accessor("type", {
    header: ({ column }) => <WorkFacetControls column={column} facet="type" />,
    size: 110,
    minSize: 110,
    cell: (info) => <TypeIcon type={info.getValue()} />,
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Type" },
  }),

  col.display({
    id: "item",
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Item" />
    ),
    minSize: 250,
    cell: ({ row }) => {
      const { id, title } = row.original;
      return (
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="line-clamp-2 text-sm md:line-clamp-1">{title}</span>
          <span className="font-mono text-muted-foreground text-xs">{id}</span>
        </div>
      );
    },
    meta: { headerTitle: "Item" },
  }),

  col.accessor("status", {
    header: ({ column }) => <WorkFacetControls column={column} facet="status" />,
    size: 150,
    cell: (info) => <StatusPill status={info.getValue()} />,
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Status" },
  }),

  col.accessor("projectId", {
    header: ({ column }) => <WorkFacetControls column={column} facet="projectId" />,
    size: 140,
    cell: (info) => {
      const v = info.getValue();
      if (!v) return null;
      return (
        <span className="truncate text-muted-foreground text-xs">
          {formatProject(v)}
        </span>
      );
    },
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Project" },
  }),

  col.accessor("updatedAt", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Updated" />
    ),
    size: 110,
    cell: (info) => {
      const v = info.getValue() || info.row.original.createdAt;
      if (!v) return <span className="text-muted-foreground">&mdash;</span>;
      return (
        <span className="text-muted-foreground text-xs">{v.slice(0, 10)}</span>
      );
    },
    sortingFn: (a, b) => {
      const da = a.original.updatedAt || a.original.createdAt || "";
      const db = b.original.updatedAt || b.original.createdAt || "";
      return da.localeCompare(db);
    },
    meta: { headerTitle: "Updated" },
  }),

  col.accessor("estimate", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Est" />
    ),
    size: 70,
    minSize: 70,
    cell: (info) => {
      const v = info.getValue();
      return (
        <span className="text-center text-muted-foreground text-xs">
          {v ?? "—"}
        </span>
      );
    },
    meta: { headerTitle: "Est" },
  }),
];
