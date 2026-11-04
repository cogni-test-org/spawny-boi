// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/tests/direct-relation-links`
 * Purpose: Prove bounded initial reads, explicit paging, and stale request handling.
 * Scope: Shared React component with injected loaders. Does not use a network.
 * Invariants: FIVE_INITIAL_LINKS, EXPLICIT_PAGINATION, PRESERVE_RESULTS_ON_FAILURE.
 * Side-effects: global (React test DOM)
 * Links: https://github.com/cogni-dao/cogni/issues/2832
 * @internal
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectRelationLinks, type DirectRelationPage } from "../src/index.js";

interface Link {
  readonly id: string;
}

function link(id: string) {
  return <a href={`/knowledge/${id}`}>{id}</a>;
}

afterEach(cleanup);

describe("DirectRelationLinks", () => {
  it("loads only the selected endpoint's first five links until More is clicked", async () => {
    const loadPage = vi.fn(async (_id: string, cursor?: string) => ({
      links: (cursor ? ["six"] : ["one", "two", "three", "four", "five"]).map(
        (id) => ({ id })
      ),
      nextCursor: cursor ? null : "page-two",
    }));
    render(
      <DirectRelationLinks
        entityId="root"
        loadPage={loadPage}
        renderLink={(item) => link(item.id)}
      />
    );

    await screen.findByRole("link", { name: "five" });
    expect(screen.getAllByRole("link")).toHaveLength(5);
    expect(loadPage.mock.calls).toEqual([["root", undefined]]);
    expect(screen.queryByRole("link", { name: "six" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More links" }));
    await screen.findByRole("link", { name: "six" });
    expect(loadPage.mock.calls).toEqual([
      ["root", undefined],
      ["root", "page-two"],
    ]);
    expect(screen.getAllByRole("link")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "More links" })).toBeNull();
  });

  it("retains loaded links after a failed next page and retries the same cursor", async () => {
    const loadPage = vi
      .fn<(_id: string, cursor?: string) => Promise<DirectRelationPage<Link>>>()
      .mockResolvedValueOnce({ links: [{ id: "one" }], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({
        links: [{ id: "one" }, { id: "two" }],
        nextCursor: null,
      });
    render(
      <DirectRelationLinks
        entityId="root"
        loadPage={loadPage}
        renderLink={(item) => link(item.id)}
      />
    );

    await screen.findByRole("link", { name: "one" });
    fireEvent.click(screen.getByRole("button", { name: "More links" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: "one" })).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "More links" }));
    await screen.findByRole("link", { name: "two" });
    expect(loadPage.mock.calls).toEqual([
      ["root", undefined],
      ["root", "next"],
      ["root", "next"],
    ]);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("ignores stale endpoint responses and caps an oversized initial page", async () => {
    let finishOld: ((page: DirectRelationPage<Link>) => void) | undefined;
    const loadPage = vi.fn((id: string) =>
      id === "old"
        ? new Promise<DirectRelationPage<Link>>((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve({
            links: Array.from({ length: 9 }, (_, i) => ({ id: `new-${i}` })),
            nextCursor: null,
          })
    );
    const view = render(
      <DirectRelationLinks
        entityId="old"
        loadPage={loadPage}
        renderLink={(item) => link(item.id)}
      />
    );
    view.rerender(
      <DirectRelationLinks
        entityId="new"
        loadPage={loadPage}
        renderLink={(item) => link(item.id)}
      />
    );
    await screen.findByRole("link", { name: "new-4" });
    finishOld?.({ links: [{ id: "stale" }], nextCursor: "old-next" });
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(5));
    expect(screen.queryByRole("link", { name: "stale" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More links" })).toBeNull();
  });
});
