// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves direct work-item URLs stay authenticated and leave rendering to the layout. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: auth }));
vi.mock("next/navigation", () => ({ redirect }));

import WorkItemPage from "@/app/(app)/work/items/[id]/page";

describe("WorkItemPage", () => {
  beforeEach(() => {
    auth.mockReset();
    redirect.mockReset();
  });

  it("renders nothing itself; the work layout keeps the dashboard mounted", async () => {
    auth.mockResolvedValue({ id: "user-1" });

    const element = await WorkItemPage({
      params: Promise.resolve({ id: "story.5000" }),
    });

    expect(element).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("keeps direct permalinks behind the authenticated app boundary", async () => {
    auth.mockResolvedValue(null);

    await WorkItemPage({ params: Promise.resolve({ id: "story.5000" }) });

    expect(redirect).toHaveBeenCalledWith("/");
  });
});
