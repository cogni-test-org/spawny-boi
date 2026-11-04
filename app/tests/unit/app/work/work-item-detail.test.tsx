// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves every open work-item sheet state is named and described. */

// @vitest-environment happy-dom

import "@testing-library/jest-dom/vitest";

import type { WorkItemDto } from "@cogni/node-contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkItemFetchError } from "@/app/(app)/work/_api/fetchWorkItems";
import { WorkItemDetail } from "@/app/(app)/work/_components/WorkItemDetail";

vi.mock("@/app/(app)/_components/EntityCitationLinks", () => ({
  EntityCitationLinks: () => null,
}));

const item: WorkItemDto = {
  id: "task.5174",
  type: "task",
  title: "Canonical work-item permalink",
  status: "needs_implement",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 1,
  deployVerified: false,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function expectAccessibleDialog(
  name: string,
  description: RegExp
): HTMLElement {
  const dialog = screen.getByRole("dialog", { name });
  expect(dialog).toHaveAccessibleDescription(description);
  return dialog;
}

describe("WorkItemDetail accessibility", () => {
  it("names and describes the loading state", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={null}
        itemId="task.5174"
        isLoading
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(
      "Loading work item",
      /Loading details for task\.5174/
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("names and describes only a typed 404 as not-found", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={null}
        itemId="task.5174"
        error={new WorkItemFetchError("missing", 404)}
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(
      "Work item not found",
      /No work item with id task\.5174/
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("names and describes operational failures without calling them 404", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={null}
        itemId="task.5174"
        error={new WorkItemFetchError("busy", 503)}
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(
      "Unable to load work item",
      /could not load task\.5174/
    );
    expect(screen.queryByText("Work item not found")).not.toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("names and describes the loaded item", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WorkItemDetail
        item={item}
        itemId={item.id}
        open
        onOpenChange={vi.fn()}
      />
    );

    expectAccessibleDialog(item.title, /Details for task\.5174/);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
