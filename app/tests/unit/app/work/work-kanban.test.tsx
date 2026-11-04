// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
// @vitest-environment jsdom

/** Exercises the real ReUI board through the shared TanStack work dashboard. */
import "@testing-library/jest-dom/vitest";
import type { WorkItemDto } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createContext, Suspense, useContext, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  pathname: "/work",
  itemId: undefined as string | undefined,
  hold: false,
  pending: false,
  autoSettle: true,
  origin: "",
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useTransition: () => {
    const actual = react.useTransition();
    return navigation.hold
      ? [navigation.pending, (action: () => void) => { navigation.origin = navigation.params.toString(); navigation.pending = true; action(); }] as const
      : actual;
  } };
});
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  usePathname: () => navigation.pathname,
  useParams: () => navigation.itemId ? { id: navigation.itemId } : {},
  useSearchParams: () => {
    const routed = useContext(RouteParamsContext);
    if (navigation.autoSettle && navigation.params.toString() !== navigation.origin) navigation.pending = false;
    return routed ?? navigation.params;
  },
}));
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@cogni/node-ui-kit/util/use-is-mobile", () => ({
  useIsMobile: () => viewport.mobile,
}));
vi.mock("@/components", async () => ({
  ...(await import("@cogni/node-ui-kit/shadcn/button")),
  ...(await import("@cogni/node-ui-kit/shadcn/input")),
}));
vi.mock("@/app/(app)/work/_components/WorkItemDetail", () => ({
  WorkItemDetail: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => open ? <button type="button" onClick={() => onOpenChange(false)}>Close detail</button> : null,
}));
vi.mock("@/app/(app)/work/_api/fetchWorkItems", () => ({
  fetchWorkItems: vi.fn(),
  fetchWorkItem: vi.fn(),
}));

import { fetchWorkItem, fetchWorkItems } from "@/app/(app)/work/_api/fetchWorkItems";
import { WorkDashboardView as Dashboard } from "@/app/(app)/work/view";
import { WorkNavigationBoundary, useWorkNavigation } from "@/app/(app)/work/WorkNavigationBoundary";

function WorkDashboardView({ selectedItemId }: { selectedItemId?: string } = {}) {
  navigation.itemId = selectedItemId;
  navigation.pathname = selectedItemId ? `/work/items/${selectedItemId}` : "/work";
  return <WorkNavigationBoundary><Dashboard selectedItemId={selectedItemId} /></WorkNavigationBoundary>;
}

const RouteParamsContext = createContext<URLSearchParams | null>(null);

const fixture: WorkItemDto[] = Array.from({ length: 5_000 }, (_, index) => ({
  id: `task.${String(index).padStart(4, "0")}`,
  type: "task",
  title: `Work item ${index}`,
  status: index % 3 === 0 ? "needs_design" : "needs_implement",
  labels: [],
  specRefs: [],
  revision: 1,
  deployVerified: false,
  assignees: [],
  externalRefs: [],
  actor: "either",
  node: "node-template",
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
  priority: 2,
  scores: Object.fromEntries(
    Object.entries({
      goal: 5,
      time: 5,
      unblocks: 5,
      ease: index % 2 === 0 ? 5 : 1,
      confidence: 5,
      agent: 5,
    }).map(([key, v]) => [key, { v }]),
  ),
}));

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkDashboardView />
    </QueryClientProvider>,
  );
}
// URL observation and transition settlement are independent router signals.
function routedMount(initialItemId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let itemId = initialItemId;
  const element = () => {
    navigation.itemId = itemId;
    navigation.pathname = itemId ? `/work/items/${itemId}` : "/work";
    return (
      <QueryClientProvider client={client}>
        <WorkNavigationBoundary>
          <Dashboard key={itemId ?? "list"} {...(itemId && { selectedItemId: itemId })} />
        </WorkNavigationBoundary>
      </QueryClientProvider>
    );
  };
  const result = render(element());
  return {
    ...result,
    redraw: () => result.rerender(element()),
    commit: (href: string, settle = true) => {
      const url = new URL(href, "https://example.com");
      navigation.params = url.searchParams;
      itemId = url.pathname.startsWith("/work/items/")
        ? decodeURIComponent(url.pathname.slice("/work/items/".length))
        : undefined;
      if (settle) navigation.pending = false;
      result.rerender(element());
    },
    settle: () => {
      navigation.pending = false;
      result.rerender(element());
    },
  };
}
function lastReplacement(): string {
  return vi.mocked(navigation.router.replace).mock.lastCall?.[0] as string;
}
async function choosePageSize(value: string) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Items per page" }), {
    key: "Enter",
  });
  await userEvent.click(screen.getByRole("option", { name: value }));
}

describe("Work Kanban", () => {
  beforeEach(() => {
    navigation.params = new URLSearchParams();
    navigation.pathname = "/work";
    navigation.itemId = undefined;
    navigation.hold = true;
    navigation.pending = false;
    navigation.autoSettle = true;
    navigation.origin = "";
    sessionStorage.clear();
    vi.clearAllMocks();
    navigation.router.push.mockReset();
    navigation.router.replace.mockReset();
    vi.mocked(fetchWorkItem).mockResolvedValue(fixture[0] as WorkItemDto);
    vi.mocked(fetchWorkItems).mockResolvedValue({
      items: fixture.filter((_, i) => i % 2 === 0).slice(0, 10),
      pageInfo: { endCursor: "next", hasMore: true },
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("requests one ranked page and renders only that page", async () => {
    mount();
    await waitFor(() =>
      expect(
        screen.getByText("10 items on this page · 10 visible cards"),
      ).toBeInTheDocument(),
    );
    const params = vi.mocked(fetchWorkItems).mock.calls[0]?.[0];
    expect(params?.get("limit")).toBe("10");
    expect(params?.has("rankMin")).toBe(false);
    expect(params?.get("sortBy")).toBe("rankScore");
    expect(params?.get("sortDirection")).toBe("desc");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.router.replace).toHaveBeenCalledWith(
      "/work?cursor=next",
      { scroll: false },
    );
  });
  it("renders one rank, one goal pointer, no project, and safe updated times on one hover surface", async () => {
    const item = {
      ...(fixture[0] as WorkItemDto),
      labels: ["goal:alpha", "goal:goal-alpha", "goal:beta", "goal:../unsafe"],
      projectId: "proj.example",
      updatedAt:
        "Mon Nov 02 2026 18:37:35 GMT+0000 (Coordinated Universal Time)",
    };
    const invalid = {
      ...(fixture[1] as WorkItemDto),
      scores: undefined,
      updatedAt: "bad date",
    };
    const missing = { ...(fixture[2] as WorkItemDto), updatedAt: "" };
    vi.mocked(fetchWorkItems).mockResolvedValue({
      items: [item, invalid, missing],
      pageInfo: { endCursor: null, hasMore: false },
    });
    mount();
    const open = await screen.findByRole("button", {
      name: "task.0000: Work item 0",
    });
    const card = open.parentElement as HTMLElement;
    expect(card).toHaveAttribute("data-slot", "kanban-item");
    expect(card).not.toHaveAttribute("role", "button");
    expect(card).not.toHaveAttribute("tabindex");
    expect(card.tabIndex).toBe(-1);
    expect(within(card).getAllByText(/^Rank /)).toHaveLength(1);
    expect(within(card).queryByText("P2")).not.toBeInTheDocument();
    expect(within(card).queryByText("example")).not.toBeInTheDocument();
    expect(within(card).getAllByRole("link")).toHaveLength(1);
    expect(card.className).toContain("hover:bg-accent/40");
    expect(open.className).not.toContain("hover:");
    const goal = within(card).getByRole("link", { name: "goal:alpha" });
    expect(goal).toHaveAttribute("href", "/knowledge/goal-alpha");
    expect(open.contains(goal)).toBe(false);
    goal.focus();
    expect(goal).toHaveFocus();
    fireEvent.keyDown(goal, { key: "Enter" });
    fireEvent.click(goal);
    expect(navigation.router.push).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(navigation.router.push).toHaveBeenCalledWith(
      "/work/items/task.0000",
      { scroll: false },
    );
    expect(card.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-11-02T18:37:35.000Z",
    );
    const invalidCard = screen.getByRole("button", {
      name: "task.0001: Work item 1",
    }).parentElement as HTMLElement;
    expect(within(invalidCard).getByText("Unscored")).toBeInTheDocument();
    expect(within(invalidCard).getByText(/Updated/)).toHaveTextContent(
      "Updated —",
    );
    expect(invalidCard.querySelector("time")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "task.0002: Work item 2" })
        .parentElement?.querySelector("time"),
    ).toBeNull();
  });

  it("preserves explicit rank bounds and clears them on request", async () => {
    navigation.params = new URLSearchParams("rankMin=2&rankMax=5&status=all");
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalled());
    const params = vi.mocked(fetchWorkItems).mock.calls[0]?.[0];
    expect(params?.get("rankMin")).toBe("2");
    expect(params?.get("rankMax")).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    const url = vi
      .mocked(navigation.router.replace)
      .mock.calls.at(-1)?.[0] as string;
    const cleared = new URL(url, "https://example.com").searchParams;
    expect(cleared.get("rankMin")).toBe("");
    expect(cleared.get("rankMax")).toBe("");
  });

  it.each(["rankMin", "rankMax"])("passes a negative %s to the API", async (key) => {
    navigation.params = new URLSearchParams(`${key}=-1&status=all`);
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalled());
    expect(vi.mocked(fetchWorkItems).mock.calls[0]?.[0].get(key)).toBe("-1");
  });

  it("exposes selected facet values as pressed", async () => {
    navigation.params = new URLSearchParams("type=bug&status=all");
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Filter type" }));
    expect(screen.getByRole("button", { name: "bug" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "task" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows titles and status without secondary columns in the mobile table", async () => {
    viewport.mobile = true;
    try {
      navigation.params = new URLSearchParams("view=table");
      mount();
      expect(await screen.findByText("Work item 0")).toBeInTheDocument();
      const headers = screen.getAllByRole("columnheader").map((header) => header.textContent ?? "");
      expect(headers.some((text) => text.includes("Item"))).toBe(true);
      expect(headers.some((text) => text.includes("Status"))).toBe(true);
      for (const hidden of ["Pri", "Rank", "Type", "Project", "Updated", "Est"]) {
        expect(headers.some((text) => text.includes(hidden))).toBe(false);
      }
      expect(screen.getByRole("table")).toHaveClass("table-auto");
    } finally {
      viewport.mobile = false;
    }
  });

  it("keeps board controls when their table columns are hidden", async () => {
    navigation.params = new URLSearchParams("view=table&sort=projectId");
    const view = mount();
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    for (const label of ["Rank", "Type", "Status", "Project"]) {
      await userEvent.click(screen.getByRole("menuitemcheckbox", { name: label }));
    }
    await userEvent.keyboard("{Escape}");
    navigation.params = new URLSearchParams("view=board&sort=projectId");
    view.rerender(view.container.firstChild ? <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WorkDashboardView /></QueryClientProvider> : <></>);
    for (const name of ["Filter rank", "Filter type", "Filter status", "Filter projects"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByText(/Sorted by projectId/)).not.toBeInTheDocument();
  });

  it("navigates only visible board cards and clears selection when columns change", async () => {
    navigation.params = new URLSearchParams("status=all&columns=needs_design");
    vi.mocked(fetchWorkItems).mockResolvedValue({
      items: [{ ...fixture[0]!, status: "done" }, { ...fixture[1]!, status: "needs_design" }],
      pageInfo: { endCursor: null, hasMore: false },
    });
    const route = routedMount();
    await screen.findByRole("button", { name: "task.0001: Work item 1" });
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(navigation.router.push).toHaveBeenCalledWith(expect.stringContaining("task.0001"), expect.anything());
    route.commit(vi.mocked(navigation.router.push).mock.lastCall?.[0] as string);
    vi.mocked(navigation.router.push).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Board columns" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "design" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "done" }));
    await userEvent.keyboard("{Escape}");
    route.commit(lastReplacement());
    route.commit(lastReplacement());
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(navigation.router.push).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(navigation.router.push).toHaveBeenCalledWith(expect.stringContaining("task.0000"), expect.anything());
  });

  it("discloses hidden legacy sorting and resets only on request", async () => {
    navigation.params = new URLSearchParams("sort=-priority&cursor=p2");
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalled());
    expect(
      screen.getByText("Sorted by priority (descending)"),
    ).toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWorkItems).mock.calls[0]?.[0].get("sortBy")).toBe(
      "priority",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to rank" }));
    const url = vi
      .mocked(navigation.router.replace)
      .mock.calls.at(-1)?.[0] as string;
    const reset = new URL(url, "https://example.com").searchParams;
    expect(reset.get("sort")).toBe("-rankScore");
    expect(reset.has("cursor")).toBe(false);
  });

  it("retains selected empty columns when no items match", async () => {
    navigation.params = new URLSearchParams("columns=done,needs_design");
    vi.mocked(fetchWorkItems).mockResolvedValue({
      items: [],
      pageInfo: { endCursor: null, hasMore: false },
    });
    mount();
    await waitFor(() =>
      expect(
        screen.getByText("0 items on this page · 0 visible cards"),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getAllByText("No items on this page")).toHaveLength(2),
    );
    expect(screen.getAllByText("done").length).toBeGreaterThan(0);
  });
  it("moves through 21 results and back without prefetching", async () => {
    const items = fixture.filter((_, i) => i % 2 === 0).slice(0, 21);
    vi.mocked(fetchWorkItems).mockImplementation(async (params) => {
      const cursor = params.get("cursor");
      const offset = cursor === "p2" ? 10 : cursor === "p3" ? 20 : 0;
      return {
        items: items.slice(offset, offset + 10),
        pageInfo: {
          endCursor: offset === 0 ? "p2" : offset === 10 ? "p3" : null,
          hasMore: offset < 20,
        },
      };
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const element = () => (
      <QueryClientProvider client={client}>
        <WorkDashboardView />
      </QueryClientProvider>
    );
    const result = render(element());
    await waitFor(() =>
      expect(
        screen.getByText("10 items on this page · 10 visible cards"),
      ).toBeInTheDocument(),
    );
    expect(fetchWorkItems).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    navigation.params = new URLSearchParams("cursor=p2");
    result.rerender(element());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "task.0020: Work item 20" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    navigation.params = new URLSearchParams("cursor=p3");
    result.rerender(element());
    await waitFor(() =>
      expect(
        screen.getByText("1 items on this page · 1 visible cards"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith(
      "/work?cursor=p2",
      { scroll: false },
    );
    navigation.params = new URLSearchParams("cursor=p2"); result.rerender(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "task.0020: Work item 20" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work", { scroll: false });
  });

  it("serializes rapid paging and persists only committed predecessors", async () => {
    navigation.hold = true;
    vi.mocked(fetchWorkItems).mockImplementation(async (params) => ({
      items: [], pageInfo: { endCursor: params.get("cursor") === "p2" ? "p3" : "p2", hasMore: true },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = () => <QueryClientProvider client={client}><WorkDashboardView /></QueryClientProvider>;
    const result = render(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(sessionStorage.getItem("work-page-history")).toBeNull();
    navigation.pending = false;
    navigation.params = new URLSearchParams("cursor=p2");
    result.rerender(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    expect(navigation.router.replace).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sessionStorage.getItem("work-page-history") as string).history).toEqual([""]);
    navigation.pending = false;
    navigation.params = new URLSearchParams("cursor=p3");
    result.rerender(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
    expect(JSON.parse(sessionStorage.getItem("work-page-history") as string).history).toEqual(["", "p2"]);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work?cursor=p2", { scroll: false });
    navigation.pending = false;
    navigation.params = new URLSearchParams("cursor=p2");
    result.rerender(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work", { scroll: false });
  });

  it.each(["filter", "sort", "page size"])("blocks paging during a pending %s replacement", async (change) => {
    const route = routedMount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    route.commit(lastReplacement());
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
    const committedRecord = sessionStorage.getItem("work-page-history");
    expect(JSON.parse(committedRecord as string).history).toEqual([""]);
    if (change === "filter") {
      fireEvent.change(screen.getByPlaceholderText(/Search id/), { target: { value: "target" } });
    } else if (change === "sort") {
      fireEvent.click(screen.getByRole("button", { name: /Rank/ }));
    } else {
      await choosePageSize("25");
    }
    const destination = lastReplacement();
    const calls = vi.mocked(navigation.router.replace).mock.calls.length;
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    });
    expect(navigation.router.replace).toHaveBeenCalledTimes(calls);
    expect(sessionStorage.getItem("work-page-history")).toBe(committedRecord);
    route.commit(destination);
    expect(JSON.parse(sessionStorage.getItem("work-page-history") as string).history).toEqual([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(vi.mocked(navigation.router.replace).mock.calls.length).toBe(calls + 1);
    route.commit(lastReplacement());
    expect(JSON.parse(sessionStorage.getItem("work-page-history") as string).history).toEqual([""]);
  });

  it("recovers after an interrupted transition without inventing history", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = () => <QueryClientProvider client={client}><WorkDashboardView /></QueryClientProvider>;
    const result = render(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    navigation.pending = false;
    result.rerender(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    expect(sessionStorage.getItem("work-page-history")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.router.replace).toHaveBeenCalledTimes(2);
  });

  it("bounds stored predecessors after 45 pages and restores only the current page", async () => {
    vi.mocked(fetchWorkItems).mockImplementation(async (params) => ({
      items: [],
      pageInfo: { endCursor: `p${Number(params.get("cursor")?.slice(1) ?? 1) + 1}`, hasMore: true },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const element = () => <QueryClientProvider client={client}><WorkDashboardView /></QueryClientProvider>;
    sessionStorage.setItem("work-page-history:old-filter", JSON.stringify({ p10: ["p1", "p2"] }));
    let result = render(element());
    for (let page = 1; page < 45; page++) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      const url = vi.mocked(navigation.router.replace).mock.lastCall?.[0] as string;
      expect(new URL(url, "https://example.com").searchParams.get("cursor")).toBe(`p${page + 1}`);
      navigation.params = new URLSearchParams(`cursor=p${page + 1}`);
      result.rerender(element());
      await waitFor(() => expect(vi.mocked(fetchWorkItems).mock.calls.some(([params]) => params.get("cursor") === `p${page + 1}`)).toBe(true));
    }
    const stored = Object.keys(sessionStorage).filter((key) => key.startsWith("work-page-history"));
    expect(stored).toHaveLength(1);
    const record = JSON.parse(sessionStorage.getItem(stored[0] as string) as string);
    expect(record.history).toEqual(Array.from({ length: 20 }, (_, i) => `p${i + 25}`));
    expect(record.cursor).toBe("p45");
    result.unmount();
    result = render(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work?cursor=p44", { scroll: false });
    navigation.params = new URLSearchParams("cursor=p44");
    result.rerender(element());
    result.unmount();
    result = render(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work?cursor=p43", { scroll: false });
    navigation.params = new URLSearchParams("cursor=p43");
    result.rerender(element());
    for (let page = 42; page >= 25; page--) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      expect(lastReplacement()).toBe(`/work?cursor=p${page}`);
      navigation.params = new URLSearchParams(`cursor=p${page}`);
      result.rerender(element());
    }
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    expect(JSON.parse(sessionStorage.getItem("work-page-history") as string).history).toEqual([]);
    result.unmount();
    navigation.params = new URLSearchParams("cursor=p10");
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled());
  });

  it.each(["getItem", "setItem"] as const)("keeps paging when storage %s throws", async (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("storage unavailable"); });
    vi.mocked(fetchWorkItems).mockImplementation(async (params) => ({
      items: fixture.slice(0, 1),
      pageInfo: { endCursor: params.get("cursor") === "p2" ? "p3" : "p2", hasMore: true },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = () => <QueryClientProvider client={client}><WorkDashboardView /></QueryClientProvider>;
    const result = render(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work?cursor=p2", { scroll: false });
    navigation.params = new URLSearchParams("cursor=p2");
    result.rerender(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
    navigation.params = new URLSearchParams("cursor=p2&view=table");
    result.rerender(element());
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work?view=table", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work?view=table", { scroll: false });
    result.unmount();
    navigation.pending = false;
    render(element());
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
  });

  it("navigates on filter and page-size changes when storage removal throws", async () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    navigation.params = new URLSearchParams("cursor=p2");
    const route = routedMount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(/Search id/), { target: { value: "target" } });
    const first = lastReplacement();
    expect(first).not.toContain("cursor=");
    await choosePageSize("25");
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    route.commit(first);
    const latest = new URL(lastReplacement(), "https://example.com").searchParams;
    expect(latest.get("q")).toBe("target");
    expect(latest.get("pageSize")).toBe("25");
    expect(latest.has("cursor")).toBe(false);
    route.commit(lastReplacement());
    expect(screen.getByPlaceholderText(/Search id/)).toHaveValue("target");
  });

  it("offers project entry in a keyboard-dismissible popover", async () => {
    navigation.params = new URLSearchParams("project=proj.offpage");
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalled());
    const trigger = screen.getByRole("button", { name: "Filter projects" });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "offpage" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Project ID" }), "proj.other");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const url = vi.mocked(navigation.router.replace).mock.lastCall?.[0] as string;
    expect(new URL(url, "https://example.com").searchParams.get("project")).toBe("proj.offpage,proj.other");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Project ID" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("does not combine an edited filter with an old cursor", async () => {
    navigation.params = new URLSearchParams("cursor=p2");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const element = () => (
      <QueryClientProvider client={client}>
        <WorkDashboardView />
      </QueryClientProvider>
    );
    const result = render(element());
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText(/Search id/), {
      target: { value: "target" },
    });
    expect(
      vi
        .mocked(fetchWorkItems)
        .mock.calls.every(
          ([params]) => !params.get("text") || !params.get("cursor"),
        ),
    ).toBe(true);
    navigation.params = new URLSearchParams(
      "q=target&rankMin=4&rankMax=&status=all&sort=-rankScore",
    );
    result.rerender(element());
    await waitFor(() =>
      expect(
        vi
          .mocked(fetchWorkItems)
          .mock.calls.some(
            ([params]) =>
              params.get("text") === "target" && !params.get("cursor"),
          ),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });
  it("does not combine an edited sort with an old cursor", async () => {
    navigation.params = new URLSearchParams("cursor=p2");
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Rank/ }));
    expect(vi.mocked(fetchWorkItems).mock.calls.every(([params]) => params.get("sortDirection") !== "asc" || !params.get("cursor"))).toBe(true);
    expect(navigation.router.replace).toHaveBeenCalledWith(expect.not.stringContaining("cursor="), { scroll: false });
  });

  it("does not intercept Enter on the page-size control", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "task.0000: Work item 0" })).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Items per page" }), { key: "Enter" });
    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitemcheckbox");
    document.body.appendChild(menuItem);
    fireEvent.keyDown(menuItem, { key: "Enter" });
    menuItem.remove();
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("composes latest controls, metadata and detail across intermediate commits", async () => {
    navigation.autoSettle = false;
    navigation.params = new URLSearchParams("cursor=p2");
    const route = routedMount();
    await screen.findByRole("button", { name: "task.0000: Work item 0" });
    fireEvent.change(screen.getByPlaceholderText(/Search id/), {
      target: { value: "target" },
    });
    const first = lastReplacement();
    act(() => {
      fireEvent.change(screen.getByPlaceholderText(/Search id/), {
        target: { value: "latest target" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Rank", exact: true }),
      );
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter rank" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rank minimum" }), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rank maximum" }), {
      target: { value: "5" },
    });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Filter type" }));
    await user.click(screen.getByRole("button", { name: "bug", exact: true }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Filter status" }));
    await user.click(screen.getByRole("button", { name: "done", exact: true }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Filter projects" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project ID" }), {
      target: { value: "proj.target" },
    });
    await user.click(screen.getByRole("button", { name: "Add", exact: true }));
    await user.keyboard("{Escape}");
    await choosePageSize("25");
    await user.click(screen.getByRole("button", { name: "Board columns" }));
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "done", exact: true }),
    );
    await user.keyboard("{Escape}");
    fireEvent.click(
      screen.getByRole("button", { name: "task.0000: Work item 0" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Table", exact: true }));
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(navigation.router.push).not.toHaveBeenCalled();
    route.commit(first, false);
    expect(screen.getByPlaceholderText(/Search id/)).toHaveValue(
      "latest target",
    );
    expect(navigation.router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    route.settle();
    expect(navigation.router.push).toHaveBeenCalledTimes(1);
    const final = vi.mocked(navigation.router.push).mock
      .lastCall?.[0] as string;
    const url = new URL(final, "https://example.com");
    expect(url.pathname).toBe("/work/items/task.0000");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "latest target",
      rankMin: "2",
      rankMax: "5",
      type: "bug",
      sort: "rankScore",
      pageSize: "25",
      view: "table",
      project: "proj.target",
    });
    expect(url.searchParams.get("columns")?.split(",")).toContain("done");
    expect(url.searchParams.get("status")?.split(",")).toContain("done");
    expect(url.searchParams.has("cursor")).toBe(false);
    route.commit(final);
    expect(screen.getByPlaceholderText(/Search id/)).toHaveValue(
      "latest target",
    );
    expect(
      JSON.parse(sessionStorage.getItem("work-page-history") as string).history,
    ).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(lastReplacement()).toBe(`/work?${url.searchParams}`);
    expect(navigation.router.push).toHaveBeenCalledTimes(1);
    route.commit(lastReplacement());
    expect(
      vi
        .mocked(fetchWorkItems)
        .mock.calls.every(
          ([params]) => !params.get("text") || !params.get("cursor"),
        ),
    ).toBe(true);
  });

  it.each(["open", "close"] as const)("preserves queued controls when %s replaces the leaf", async (direction) => {
    navigation.autoSettle = false;
    const route = routedMount(direction === "close" ? "task.0000" : undefined);
    await screen.findByRole("button", { name: "task.0000: Work item 0" });
    if (direction === "open") {
      fireEvent.click(screen.getByRole("button", { name: "task.0000: Work item 0" }));
    } else {
      await screen.findByRole("button", { name: "Close detail" });
      fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    }
    const first = direction === "open" ? vi.mocked(navigation.router.push).mock.lastCall?.[0] as string : lastReplacement();
    fireEvent.change(screen.getByPlaceholderText(/Search id/), { target: { value: "queued" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank", exact: true }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter type" }));
    await user.click(screen.getByRole("button", { name: "bug", exact: true }));
    await user.keyboard("{Escape}");
    await choosePageSize("25");
    await user.click(screen.getByRole("button", { name: "Board columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "done", exact: true }));
    await user.keyboard("{Escape}");
    fireEvent.click(screen.getByRole("button", { name: "Table", exact: true }));
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Rank" }));
    await user.keyboard("{Escape}");
    route.commit(first, false);
    expect(screen.getByPlaceholderText(/Search id/)).toHaveValue("queued");
    await user.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Rank" })).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Escape}");
    route.settle();
    const final = new URL(lastReplacement(), "https://example.com");
    expect(final.pathname).toBe(direction === "open" ? "/work/items/task.0000" : "/work");
    expect(final.searchParams.get("q")).toBe("queued");
    expect(final.searchParams.get("view")).toBe("table");
    expect(final.searchParams.get("sort")).toBe("rankScore");
    expect(final.searchParams.get("type")).toBe("bug");
    expect(final.searchParams.get("pageSize")).toBe("25");
    expect(final.searchParams.get("columns")?.split(",")).toContain("done");
  });

  it.each(["open", "close"] as const)("drains queued selection after %s replaces the leaf", async (direction) => {
    navigation.autoSettle = false;
    const route = routedMount(direction === "close" ? "task.0000" : undefined);
    await screen.findByRole("button", { name: "task.0002: Work item 2" });
    if (direction === "open") {
      fireEvent.click(screen.getByRole("button", { name: "task.0000: Work item 0" }));
    } else {
      await screen.findByRole("button", { name: "Close detail" });
      fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    }
    const first = direction === "open" ? vi.mocked(navigation.router.push).mock.lastCall?.[0] as string : lastReplacement();
    fireEvent.click(screen.getByRole("button", { name: "task.0002: Work item 2" }));
    route.commit(first, false);
    route.settle();
    expect(vi.mocked(navigation.router.push).mock.lastCall?.[0]).toContain("/work/items/task.0002");
  });

  it("retains denied-storage history across leaf replacement but not owner remount", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    vi.mocked(fetchWorkItems).mockResolvedValue({ items: fixture.slice(0, 1), pageInfo: { endCursor: "p2", hasMore: true } });
    const route = routedMount();
    await screen.findByRole("button", { name: "task.0000: Work item 0" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    route.commit(lastReplacement());
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
    fireEvent.click(await screen.findByRole("button", { name: "task.0000: Work item 0" }));
    route.commit(vi.mocked(navigation.router.push).mock.lastCall?.[0] as string);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    route.unmount();
    navigation.pending = false;
    const fresh = routedMount("task.0000");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    fresh.unmount();
  });

  it("keeps the owner on supported routes and creates a fresh one after leaving", () => {
    let owner: ReturnType<typeof useWorkNavigation>["navigation"] | undefined;
    function Probe() { owner = useWorkNavigation().navigation; return null; }
    const element = () => <WorkNavigationBoundary><Probe /></WorkNavigationBoundary>;
    const view = render(element());
    const original = owner;
    navigation.pathname = "/work/items/task.0000";
    navigation.itemId = "task.0000";
    view.rerender(element());
    expect(owner).toBe(original);
    navigation.pathname = "/work/other";
    view.rerender(<WorkNavigationBoundary><span>Other</span></WorkNavigationBoundary>);
    navigation.pathname = "/work";
    navigation.itemId = undefined;
    view.rerender(element());
    expect(owner).not.toBe(original);
  });

  it("composes numeric bounds changed in the same tick", async () => {
    navigation.autoSettle = false;
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Filter rank" }));
    act(() => {
      fireEvent.change(screen.getByRole("spinbutton", { name: "Rank minimum" }), { target: { value: "-2" } });
      fireEvent.change(screen.getByRole("spinbutton", { name: "Rank maximum" }), { target: { value: "5" } });
    });
    expect(screen.getByRole("spinbutton", { name: "Rank minimum" })).toHaveValue(-2);
    expect(screen.getByRole("spinbutton", { name: "Rank maximum" })).toHaveValue(5);
  });

  it("holds the pager guard across rerenders and mixed same-tick actions", async () => {
    navigation.autoSettle = false;
    vi.mocked(fetchWorkItems).mockImplementation(async (params) => ({
      items: [],
      pageInfo: {
        endCursor: params.get("cursor") === "p2" ? "p3" : "p2",
        hasMore: true,
      },
    }));
    const route = routedMount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    route.redraw();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("work-page-history")).toBeNull();
    route.commit(lastReplacement(), false);
    expect(
      JSON.parse(sessionStorage.getItem("work-page-history") as string).history,
    ).toEqual([""]);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    route.settle();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    route.redraw();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    expect(navigation.router.replace).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(sessionStorage.getItem("work-page-history") as string).history,
    ).toEqual([""]);
    route.commit(lastReplacement());
    expect(
      JSON.parse(sessionStorage.getItem("work-page-history") as string).history,
    ).toEqual(["", "p2"]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    });
    route.redraw();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(navigation.router.replace).toHaveBeenCalledTimes(3);
    route.commit(lastReplacement());
    expect(
      JSON.parse(sessionStorage.getItem("work-page-history") as string).history,
    ).toEqual([""]);
  });

  it.each(["pager", "filter"])(
    "recovers from synchronous %s replace failure with committed history intact",
    async (kind) => {
      vi.mocked(fetchWorkItems).mockImplementation(async (params) => ({
        items: [],
        pageInfo: {
          endCursor: params.get("cursor") === "p2" ? "p3" : "p2",
          hasMore: true,
        },
      }));
      const route = routedMount();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      route.commit(lastReplacement());
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
      );
      const stored = sessionStorage.getItem("work-page-history");
      navigation.router.replace.mockImplementationOnce(() => {
        throw new Error("router refused");
      });
      if (kind === "pager")
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
      else
        fireEvent.change(screen.getByPlaceholderText(/Search id/), {
          target: { value: "uncommitted" },
        });
      expect(sessionStorage.getItem("work-page-history")).toBe(stored);
      route.settle();
      expect(screen.getByPlaceholderText(/Search id/)).toHaveValue("");
      expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      expect(lastReplacement()).toBe("/work");
      route.commit(lastReplacement());
      expect(
        JSON.parse(sessionStorage.getItem("work-page-history") as string)
          .history,
      ).toEqual([]);
    },
  );

  it.each(["settled", "external"])(
    "discards queued drafts when %s navigation wins",
    async (winner) => {
      navigation.autoSettle = false;
      vi.mocked(fetchWorkItems).mockImplementation(async (params) => ({
        items: [],
        pageInfo: {
          endCursor: params.get("cursor") === "p2" ? "p3" : "p2",
          hasMore: true,
        },
      }));
      const route = routedMount();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      route.commit(lastReplacement());
      const stored = sessionStorage.getItem("work-page-history");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.change(screen.getByPlaceholderText(/Search id/), {
        target: { value: "abandoned" },
      });
      expect(lastReplacement()).toContain("cursor=p3");
      if (winner === "external")
        route.commit("/work?cursor=external&q=winner", false);
      else route.settle();
      route.settle();
      expect(sessionStorage.getItem("work-page-history")).toBe(stored);
      expect(screen.getByPlaceholderText(/Search id/)).toHaveValue(
        winner === "external" ? "winner" : "",
      );
      expect(navigation.router.replace).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Previous" }))[
        winner === "external" ? "toBeDisabled" : "toBeEnabled"
      ]();
      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      expect(lastReplacement()).toBe(
        winner === "external" ? "/work?q=winner" : "/work",
      );
    },
  );

  it("retains Previous and Restart after a committed page fetch fails", async () => {
    const route = routedMount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    vi.mocked(fetchWorkItems).mockRejectedValue(new Error("page fetch failed"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    route.commit(lastReplacement());
    await screen.findByText("Failed to load work items.");
    expect(
      JSON.parse(sessionStorage.getItem("work-page-history") as string).history,
    ).toEqual([""]);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(lastReplacement()).toBe("/work");
  });

  it("restores the bounded page through detail remount, view switch and reload", async () => {
    navigation.params = new URLSearchParams(
      "q=target&rankMin=2&rankMax=5&pageSize=25&columns=needs_design",
    );
    let route = routedMount();
    await screen.findByRole("button", { name: "task.0000: Work item 0" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    route.commit(lastReplacement());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled(),
    );
    const stored = sessionStorage.getItem("work-page-history");
    fireEvent.click(
      await screen.findByRole("button", { name: "task.0000: Work item 0" }),
    );
    const opened = vi.mocked(navigation.router.push).mock
      .lastCall?.[0] as string;
    expect(opened).toContain("/work/items/task.0000?");
    expect(
      new URL(opened, "https://example.com").searchParams.get("cursor"),
    ).toBe("next");
    route.commit(opened);
    route.unmount();
    route = routedMount("task.0000");
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Table", exact: true }));
    route.commit(lastReplacement());
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(sessionStorage.getItem("work-page-history")).toBe(stored);
    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
    route.commit(lastReplacement());
    route.unmount();
    route = routedMount();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByPlaceholderText(/Search id/)).toHaveValue("target");
    expect(
      screen.getByRole("button", { name: "Table", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(
        vi
          .mocked(fetchWorkItems)
          .mock.calls.some(
            ([params]) =>
              params.get("cursor") === "next" &&
              params.get("limit") === "25" &&
              params.get("rankMin") === "2" &&
              params.get("rankMax") === "5" &&
              params.get("text") === "target",
          ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(
      new URL(lastReplacement(), "https://example.com").searchParams.has(
        "cursor",
      ),
    ).toBe(false);
  });

  it("waits for a real suspended React route transition before releasing the pager", async () => {
    navigation.hold = false;
    navigation.autoSettle = false;
    let permitCommit = false;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestRoute = (_href: string) => {};
    navigation.router.replace.mockImplementation((href: string) =>
      requestRoute(href),
    );
    function CommitBarrier({ cursor }: { cursor: string | null }) {
      if (cursor && !permitCommit) throw barrier;
      return null;
    }
    function Route() {
      const [params, setParams] = useState(new URLSearchParams());
      requestRoute = (href) =>
        setParams(new URL(href, "https://example.com").searchParams);
      return (
        <RouteParamsContext.Provider value={params}>
          <WorkDashboardView />
          <CommitBarrier cursor={params.get("cursor")} />
        </RouteParamsContext.Provider>
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const element = () => (
      <QueryClientProvider client={client}>
        <Suspense fallback={<p>Route loading</p>}>
          <Route />
        </Suspense>
      </QueryClientProvider>
    );
    const result = render(element());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    result.rerender(element());
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(sessionStorage.getItem("work-page-history")).toBeNull();
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    await act(async () => {
      permitCommit = true;
      release();
      await barrier;
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled(),
    );
    expect(
      JSON.parse(sessionStorage.getItem("work-page-history") as string).history,
    ).toEqual([""]);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() =>
      expect(
        JSON.parse(sessionStorage.getItem("work-page-history") as string)
          .history,
      ).toEqual([]),
    );
    expect(navigation.router.replace).toHaveBeenCalledTimes(2);
  });

  it("settles a no-op router through the real React transition without locking forever", async () => {
    navigation.hold = false;
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled(),
    );
    expect(sessionStorage.getItem("work-page-history")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.router.replace).toHaveBeenCalledTimes(2);
  });
});
