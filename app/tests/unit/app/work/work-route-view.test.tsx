// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
// @vitest-environment jsdom

/** Proves the layout-owned dashboard follows the URL without remounting. */
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/work", params: {} as Record<string, string> }));
const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useParams: () => route.params,
}));
vi.mock("@/app/(app)/work/view", async () => {
  const { useEffect } = await import("react");
  return {
    WorkDashboardView: ({ selectedItemId }: { selectedItemId?: string }) => {
      useEffect(() => {
        mounts.count += 1;
      }, []);
      return <output data-testid="dashboard">{selectedItemId ?? "none"}</output>;
    },
  };
});

import { WorkRouteView } from "@/app/(app)/work/WorkRouteView";

afterEach(() => {
  route.pathname = "/work";
  route.params = {};
  mounts.count = 0;
});

describe("WorkRouteView", () => {
  it("opens and closes an item on one mounted dashboard", () => {
    const view = render(<WorkRouteView />);
    expect(view.getByTestId("dashboard")).toHaveTextContent("none");

    route.pathname = "/work/items/task.0014";
    route.params = { id: "task.0014" };
    view.rerender(<WorkRouteView />);
    expect(view.getByTestId("dashboard")).toHaveTextContent("task.0014");

    route.pathname = "/work";
    route.params = {};
    view.rerender(<WorkRouteView />);
    expect(view.getByTestId("dashboard")).toHaveTextContent("none");
    expect(mounts.count).toBe(1);
  });

  it("renders nothing on unknown work subroutes", () => {
    route.pathname = "/work/other";
    const view = render(<WorkRouteView />);
    expect(view.queryByTestId("dashboard")).toBeNull();
  });
});
