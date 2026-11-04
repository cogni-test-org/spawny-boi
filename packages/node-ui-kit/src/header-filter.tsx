// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-ui-kit/header-filter`
 * Purpose: Multi-select facet filter for header-owned Popovers or dropdowns.
 * Scope: Client component reading `column.getFacetedUniqueValues()`; assumes the table has `getFacetedRowModel + getFacetedUniqueValues` enabled and `filterFn: "arrIncludesSome"` on the column. Does not fetch data or own URL state.
 * Invariants: HEADER_OWNS_SORT_AND_FILTER — facet controls belong to the column header, not a parallel toolbar chip.
 * Side-effects: none
 * Links: docs/spec/ui-implementation.md, work/items/task.0432.work-items-table-poly-standard.md
 * @public
 */

"use client";

import type { Column } from "@tanstack/react-table";
import { Check } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Input } from "./shadcn/input";

import { cn } from "./util/cn";

interface HeaderFilterProps<TData, TValue> {
  readonly column: Column<TData, TValue>;
  /** Optional value → display-label mapping. */
  readonly formatLabel?: (value: string) => string;
  readonly options?: readonly string[];
  readonly allowEntry?: boolean;
  readonly showCounts?: boolean;
}

export function HeaderFilter<TData, TValue>({
  column,
  formatLabel,
  options,
  allowEntry = false,
  showCounts = true,
}: HeaderFilterProps<TData, TValue>): ReactElement {
  const [entry, setEntry] = useState("");
  const facets = column.getFacetedUniqueValues();
  const selected = new Set((column.getFilterValue() as string[]) ?? []);
  const values = [
    ...new Set([...facets.keys(), ...(options ?? []), ...selected]),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .sort((a, b) => a.localeCompare(b));

  function toggle(value: string) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    column.setFilterValue(next.size === 0 ? undefined : Array.from(next));
  }

  if (values.length === 0 && !allowEntry) {
    return <span className="text-muted-foreground text-xs">No values</span>;
  }

  return (
    <div className="flex max-h-64 min-w-56 flex-col gap-0.5 overflow-y-auto pr-1">
      {values.map((v) => {
        const isSelected = selected.has(v);
        return (
          <button
            key={v}
            type="button"
            aria-pressed={isSelected}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggle(v);
            }}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent"
          >
            <span
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : "opacity-50",
              )}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </span>
            <span className="flex-1 truncate capitalize">
              {formatLabel ? formatLabel(v) : v}
            </span>
            {showCounts && (
              <span className="shrink-0 pl-2 font-mono text-muted-foreground text-xs tabular-nums">
                {facets.get(v)}
              </span>
            )}
          </button>
        );
      })}
      {allowEntry && (
        <div className="flex gap-1">
          <Input
            aria-label="Project ID"
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
          />
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (entry && !selected.has(entry)) toggle(entry);
              setEntry("");
            }}
          >
            Add
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            column.setFilterValue(undefined);
          }}
          className="mt-1 rounded-sm px-2 py-1 text-center text-muted-foreground text-xs hover:bg-accent"
        >
          Clear
        </button>
      )}
    </div>
  );
}
