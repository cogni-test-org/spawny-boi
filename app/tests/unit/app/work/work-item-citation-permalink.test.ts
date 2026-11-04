// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Prevents citation metadata from regressing to search-query work links. */

import { describe, expect, it } from "vitest";

import { workItemPermalink } from "@/app/api/v1/citations/[id]/_lib/workItemPermalink";

describe("work-item citation permalink", () => {
  it("emits the canonical item route with one encoding boundary", () => {
    expect(workItemPermalink("bug.5355")).toBe("/work/items/bug.5355");
    expect(workItemPermalink("bug.%2F")).toBe("/work/items/bug.%252F");
  });
});
