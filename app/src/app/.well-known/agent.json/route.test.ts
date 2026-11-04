// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "test-sha" }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeBrandColor: () => "#000000",
  getNodeBrandIcon: () => "circle",
  getNodeHook: () => "Test hook",
  getNodeMission: () => "Test mission",
  getNodeName: () => "Test node",
  getNodeThumbnail: () => null,
}));

describe("GET /.well-known/agent.json", () => {
  it("publishes node-relative work-item write actions from typed contracts", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://0.0.0.0:3000/.well-known/agent.json", {
        headers: {
          "x-forwarded-host": "node.example",
          "x-forwarded-proto": "https",
        },
      })
    );
    const body = await response.json();

    expect(body.endpoints.openapi).toBe("https://node.example/openapi.json");
    expect(body.endpoints.workItems).toBe(
      "https://node.example/api/v1/work/items"
    );
    expect(body.actions.createWorkItem).toMatchObject({
      method: "POST",
      endpoint: "https://node.example/api/v1/work/items",
      auth: { type: "bearer" },
      inputSchema: { type: "object", required: ["type", "title"] },
    });
    expect(
      body.actions.createWorkItem.inputSchema.properties.type.enum
    ).toEqual(["task", "bug", "story", "spike", "subtask"]);
    expect(body.actions.listWorkItems.method).toBe("GET");
    expect(body.actions.getWorkItem.method).toBe("GET");
    expect(body.actions.updateWorkItem).toMatchObject({
      method: "PATCH",
      endpoint: "https://node.example/api/v1/work/items/{id}",
      auth: { type: "bearer" },
    });
    expect(body.actions.updateWorkItem.inputSchema.properties).toHaveProperty(
      "set"
    );
    expect(body.actions.deleteWorkItem.method).toBe("DELETE");
    expect(body.actions.claimWorkItem).toMatchObject({
      method: "POST",
      endpoint: "https://node.example/api/v1/work/items/{id}/claims",
      auth: { type: "bearer" },
    });
    expect(body.actions.heartbeatWorkItem.method).toBe("POST");
    expect(body.actions.releaseWorkItem.method).toBe("DELETE");
    expect(body.actions.getWorkItemCoordination.method).toBe("GET");
  });
});
