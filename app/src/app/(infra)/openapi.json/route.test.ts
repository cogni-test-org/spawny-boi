// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /openapi.json", () => {
  it("advertises work-item CRUD and coordination operations", async () => {
    const response = GET();
    const document = (await response.json()) as {
      paths?: Record<string, Record<string, unknown>>;
    };

    expect(document.paths?.["/work/items"]?.post).toBeDefined();
    expect(document.paths?.["/work/items"]?.get).toBeDefined();
    expect(document.paths?.["/work/items/{id}"]?.get).toBeDefined();
    expect(document.paths?.["/work/items/{id}"]?.patch).toBeDefined();
    expect(document.paths?.["/work/items/{id}"]?.delete).toBeDefined();
    expect(document.paths?.["/work/items/{id}/claims"]?.post).toBeDefined();
    expect(document.paths?.["/work/items/{id}/claims"]?.delete).toBeDefined();
    expect(document.paths?.["/work/items/{id}/heartbeat"]?.post).toBeDefined();
    expect(document.paths?.["/work/items/{id}/coordination"]?.get).toBeDefined();
  });
});
