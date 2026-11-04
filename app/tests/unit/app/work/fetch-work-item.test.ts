// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Covers exact-item cookie-auth fetches and the unknown-id error state. */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWorkItem,
  fetchWorkItems,
  WorkItemFetchError,
} from "@/app/(app)/work/_api/fetchWorkItems";

describe("fetchWorkItem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the encoded exact-item endpoint with same-origin auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "story.5000" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkItem("story.5000")).resolves.toMatchObject({
      id: "story.5000",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/story.5000",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("surfaces unknown ids for the human not-found state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "Work item not found: bug.9999" }),
      }),
    );

    const error = await fetchWorkItem("bug.9999").catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({
      message: "Work item not found: bug.9999",
      status: 404,
    });
  });

  it("keeps operational failures distinct from not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: "Work-item store is busy" }),
      }),
    );

    await expect(fetchWorkItem("task.5174")).rejects.toMatchObject({
      name: "WorkItemFetchError",
      message: "Work-item store is busy",
      status: 503,
    });
  });

  it("encodes a logical percent sequence once at the API boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "bug.%2F" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkItem("bug.%2F");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/bug.%252F",
      expect.any(Object),
    );
  });
});

describe("fetchWorkItems bounded page", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns one page without fetching the next", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: "task.5000" }],
        pageInfo: { endCursor: "next", hasMore: true },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchWorkItems(
      new URLSearchParams({ limit: "10", rankMin: "4" }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.pageInfo?.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items?limit=10&rankMin=4",
      expect.any(Object),
    );
  });
  it("reports server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "Work-item store is busy" }),
      }),
    );
    await expect(fetchWorkItems(new URLSearchParams())).rejects.toThrow(
      "Work-item store is busy",
    );
  });
});
