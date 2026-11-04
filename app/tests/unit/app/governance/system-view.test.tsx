// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `system-view.test`
 * Purpose: Prove /gov/system renders the DAO autonomous AI activity (loaded state, empty state, error state) instead of a redirect.
 * Scope: GovernanceView with the status hook, activity fetch, router and chart mocked. Does not hit the network.
 * Invariants: LOADED_NOT_SKELETON (credit balance + Recent Runs only render after status resolves), ERROR_IS_VISIBLE.
 * Side-effects: none
 * Links: src/app/(app)/gov/system/view.tsx, task.5387, story.5134
 * @vitest-environment jsdom
 */

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: {
    data: undefined as unknown,
    isLoading: false,
    error: null as Error | null,
  },
}));

vi.mock("@/features/governance/hooks/useGovernanceStatus", () => ({
  useGovernanceStatus: () => state.status,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/gov/system/_api/fetchGovernanceActivity", () => ({
  fetchGovernanceActivity: () => new Promise(() => {}),
}));
vi.mock("@/components/kit/data-display/ActivityChart", () => ({
  ActivityChart: ({ title }: { title: string }) => <div>{title} chart</div>,
}));

import { GovernanceView } from "@/app/(app)/gov/system/view";

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GovernanceView />
    </QueryClientProvider>,
  );
}

describe("/gov/system GovernanceView", () => {
  afterEach(cleanup);

  it("renders balance, upcoming runs and recent runs once status loads", () => {
    state.status = {
      isLoading: false,
      error: null,
      data: {
        systemCredits: "5000000000",
        upcomingRuns: [
          {
            name: "Community",
            nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
        recentRuns: [
          {
            id: "run-1",
            title: "Community governance run",
            startedAt: "2026-10-28T00:00:00.000Z",
            lastActivity: "2026-10-28T00:05:00.000Z",
          },
        ],
      },
    };
    renderView();
    expect(screen.getByText("Cogni System Activity")).toBeInTheDocument();
    expect(screen.getByText("System Credit Balance")).toBeInTheDocument();
    expect(screen.getByText("Upcoming Runs")).toBeInTheDocument();
    expect(screen.getByText("Community")).toBeInTheDocument();
    expect(screen.getByText("Recent Runs")).toBeInTheDocument();
    expect(screen.getByText("Community governance run")).toBeInTheDocument();
    expect(screen.getByText("Usage Metrics")).toBeInTheDocument();
  });

  it("renders explicit empty states when the node has no runs", () => {
    state.status = {
      isLoading: false,
      error: null,
      data: { systemCredits: "0", upcomingRuns: [], recentRuns: [] },
    };
    renderView();
    expect(screen.getByText("System Credit Balance")).toBeInTheDocument();
    expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
    expect(screen.getByText("Recent Runs")).toBeInTheDocument();
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
  });

  it("does not show loaded sections while status is loading", () => {
    state.status = { isLoading: true, error: null, data: undefined };
    renderView();
    expect(screen.queryByText("System Credit Balance")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent Runs")).not.toBeInTheDocument();
  });

  it("surfaces a failing status route as an error, not a blank page", () => {
    state.status = {
      isLoading: false,
      error: new Error("Failed to fetch governance status"),
      data: undefined,
    };
    renderView();
    expect(
      screen.getByText("Error loading governance data"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recent Runs")).not.toBeInTheDocument();
  });
});
