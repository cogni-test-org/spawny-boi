// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-selection-direct-links`
 * Purpose: Keep node-template atom selection on direct relations in each knowledge view.
 * Scope: Real selection handlers and shared UI, with an already-loaded entry body.
 * Invariants: NO_IMPLICIT_CHAIN, FIVE_INITIAL_LINKS, MORE_REQUIRES_CLICK.
 * Side-effects: Stubbed browser fetch; no live services or database.
 * Links: https://github.com/cogni-dao/cogni/issues/2846
 * @vitest-environment jsdom
 * @internal
 */

import type { KnowledgeRow } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";

const navigation = vi.hoisted(() => ({ mode: "browse" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams({ mode: navigation.mode }),
}));

// Only the grid and WebGL presentation are replaced. Their real parent
// selection callbacks, detail fields and released relation UI remain mounted.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({
      graphData,
      onNodeClick,
    }: {
      graphData: {
        nodes: Array<{ id: string; title: string; isHub: boolean }>;
      };
      onNodeClick: (node: { id: string; isHub: boolean }) => void;
    }) => (
      <div>
        {graphData.nodes
          .filter((node) => !node.isHub)
          .map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onNodeClick(node)}
            >
              Select graph {node.title}
            </button>
          ))}
      </div>
    ),
}));

vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid", () => ({
  DataGrid: ({
    table,
    onRowClick,
  }: {
    table: {
      getRowModel: () => {
        rows: Array<{ id: string; original: KnowledgeRow }>;
      };
    };
    onRowClick: (entry: KnowledgeRow) => void;
  }) => (
    <div>
      {table.getRowModel().rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onRowClick(row.original)}
        >
          Select row {row.original.title}
        </button>
      ))}
    </div>
  ),
  DataGridContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility",
  () => ({
    DataGridColumnVisibility: () => null,
  })
);
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-pagination", () => ({
  DataGridPagination: () => null,
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-table", () => ({
  DataGridTable: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/AddDomainSheet", () => ({
  AddDomainSheet: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/ConfidenceBar", () => ({
  ConfidenceBar: () => null,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const selected = {
  id: "node-template-selected-decision",
  domain: "meta",
  entityId: null,
  title: "node-template selected decision",
  content: "The already-loaded node-template entry body",
  useWhen: null,
  entryType: "decision",
  confidencePct: 80,
  sourceType: "human",
  sourceRef: null,
  tags: null,
  createdAt: null,
} satisfies KnowledgeRow;

function relation(index: number) {
  return {
    id: `direct-${index}`,
    direction: "out",
    citationType: "supports",
    source: {
      id: selected.id,
      kind: "knowledge",
      title: selected.title,
      href: `/knowledge/${selected.id}`,
    },
    target: {
      id: `neighbor-${index}`,
      kind: "knowledge",
      title: `Direct relation ${index}`,
      href: `/knowledge/neighbor-${index}`,
    },
    context: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("node-template knowledge selection", () => {
  it.each([
    "browse",
    "chains",
    "graph",
  ])("%s reuses the loaded body and reads direct metadata only on demand", async (mode) => {
    navigation.mode = mode;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    const first = `/api/v1/citations/${selected.id}`;
    const next = `${first}?cursor=direct-4`;
    const contributions =
      "/api/v1/knowledge/contributions?state=open&limit=100";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === contributions) return Response.json({ contributions: [] });
      if (url === first)
        return Response.json({
          links: Array.from({ length: 5 }, (_, index) => relation(index)),
          nextCursor: "direct-4",
        });
      if (url === next)
        return Response.json({
          links: [relation(5)],
          nextCursor: null,
        });
      throw new Error(`Unexpected read after selection: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <KnowledgeDashboardView
          initialList={{ items: [selected], domains: [selected.domain] }}
          initialDomains={{ domains: [] }}
          initialGraph={{
            nodes: [selected],
            edges: [],
            domains: [selected.domain],
          }}
        />
      </QueryClientProvider>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(selected.content)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: `Select ${mode === "graph" ? "graph" : "row"} ${selected.title}`,
      })
    );
    await screen.findByText(selected.content);
    await screen.findByRole("link", { name: "supports Direct relation 4" });
    expect(
      screen.queryByRole("link", { name: "supports Direct relation 5" })
    ).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      contributions,
      first,
    ]);

    fireEvent.click(screen.getByRole("button", { name: "More links" }));
    await screen.findByRole("link", { name: "supports Direct relation 5" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      contributions,
      first,
      next,
    ]);
    expect(screen.queryByRole("button", { name: "More links" })).toBeNull();
  });
});
