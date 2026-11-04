// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** HTTP parsing, facade delegation, and conflict mapping must preserve revision CAS. */
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { PATCH } from "@/app/api/v1/work/items/[id]/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown,
  route: unknown
) => Promise<Response>;

const patch = vi.fn();
const item = {
  id: "task.0001",
  type: "task",
  title: "Revision fixture",
  status: "needs_implement",
  priority: 2,
  rank: 0,
  estimate: 1,
  summary: "updated",
  outcome: "",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 8,
  deployVerified: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};

function request(body: unknown): Promise<Response> {
  return (PATCH as unknown as Handler)(
    { log: { info: vi.fn() } },
    new Request("http://localhost/api/v1/work/items/task.0001", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { id: "principal-1" },
    { params: Promise.resolve({ id: "task.0001" }) }
  );
}

describe("work-item revision HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: { patch },
    } as never);
    patch.mockResolvedValue(item);
  });

  it("forwards the caller's revision through the real facade and returns the new revision", async () => {
    const response = await request({
      expectedRevision: 7,
      set: { summary: "updated" },
    });
    expect(response.status).toBe(200);
    expect(patch).toHaveBeenCalledWith(
      { id: "task.0001", expectedRevision: 7, set: { summary: "updated" } },
      "principal-1"
    );
    expect(await response.json()).toMatchObject({ revision: 8 });
  });

  it("maps a stale revision to a distinct 409 with the actual current revision", async () => {
    patch.mockRejectedValue(
      new WorkItemRevisionConflictError("task.0001", 7, 8)
    );
    const response = await request({
      expectedRevision: 7,
      set: { summary: "updated" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "revision_conflict",
      expectedRevision: 7,
      currentRevision: 8,
    });
  });

  it.each([
    -1,
    0.5,
    "7",
    null,
  ])("rejects invalid expectedRevision %j before the store", async (expectedRevision) => {
    const response = await request({
      expectedRevision,
      set: { summary: "updated" },
    });
    expect(response.status).toBe(400);
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps legacy patches unconditional when expectedRevision is omitted", async () => {
    const response = await request({ set: { summary: "updated" } });
    expect(response.status).toBe(200);
    expect(patch).toHaveBeenCalledWith(
      { id: "task.0001", set: { summary: "updated" } },
      "principal-1"
    );
  });

  it("keeps writer admission failures as 503", async () => {
    patch.mockRejectedValue(
      Object.assign(new Error("writer busy"), { name: "WorkItemsBusyError" })
    );
    const response = await request({
      expectedRevision: 7,
      set: { summary: "updated" },
    });
    expect(response.status).toBe(503);
  });
});
