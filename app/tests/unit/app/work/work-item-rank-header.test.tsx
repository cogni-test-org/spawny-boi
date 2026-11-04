// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exercises header clicks against the real sorted and paginated table model. */
// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type TableState,
} from "@tanstack/react-table";
import { afterEach, describe, expect, it } from "vitest";

import { WorkItemRankHeader } from "@/app/(app)/work/_components/columns";

function tableFor(descFirst?: boolean) {
  let state: TableState;
  const table = createTable({
    data: [
      { id: "low", score: 1 },
      { id: "unknown", score: undefined },
      { id: "high", score: 10 },
      { id: "middle", score: 5 },
    ],
    columns: [
      {
        accessorKey: "score",
        id: "rankScore",
        sortUndefined: "last",
        ...(descFirst !== undefined ? { sortDescFirst: descFirst } : {}),
      },
    ],
    state: {},
    onStateChange: (updater) => {
      state = typeof updater === "function" ? updater(state) : updater;
      table.setOptions((options) => ({ ...options, state }));
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    renderFallbackValue: null,
  });
  state = { ...table.initialState, pagination: { pageIndex: 0, pageSize: 2 } };
  table.setOptions((options) => ({ ...options, state }));
  return table;
}

const visibleIds = (table: ReturnType<typeof tableFor>) =>
  table.getRowModel().rows.map((row) => row.original.id);

describe("work Rank header sorting", () => {
  afterEach(cleanup);

  it("clicks descending first, then ascending, before client pagination", () => {
    const table = tableFor(true);
    const column = table.getColumn("rankScore");
    if (!column) throw new Error("missing Rank column");
    const { rerender } = render(<WorkItemRankHeader column={column} />);

    fireEvent.click(screen.getByRole("button", { name: "Rank" }));
    expect(visibleIds(table)).toEqual(["high", "middle"]);
    expect(table.getSortedRowModel().rows.at(-1)?.original.id).toBe("unknown");
    rerender(
      <WorkItemRankHeader
        key={JSON.stringify(table.getState().sorting)}
        column={column}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rank" }));
    expect(visibleIds(table)).toEqual(["low", "middle"]);
    expect(table.getSortedRowModel().rows.at(-1)?.original.id).toBe("unknown");
    rerender(
      <WorkItemRankHeader
        key={JSON.stringify(table.getState().sorting)}
        column={column}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rank" }));
    expect(table.getState().sorting).toEqual([]);
  });
});
