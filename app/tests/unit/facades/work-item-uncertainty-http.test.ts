// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** The HTTP boundary must refuse automatic replay of an unresolved current write. */
import { WorkItemWriteOutcomeUnknownError } from "@cogni/work-items";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/app/_facades/work/items.server", async () => {
  const { WorkItemScoresInvalidError, WorkItemWriteOutcomeUnknownError } =
    await import("@cogni/work-items");
  const uncertain = async () => {
    throw new WorkItemWriteOutcomeUnknownError(
      "op-1",
      "work-item-op/one",
      "commit-1",
      "task.0001"
    );
  };
  return {
    createWorkItem: uncertain,
    patchWorkItem: uncertain,
    listWorkItems: vi.fn(),
    getWorkItem: vi.fn(),
    WorkItemWriteOutcomeUnknownError,
    WorkItemScoresInvalidError,
    InvalidCursorError: class extends Error {},
    WorkItemsBackendNotReadyError: class extends Error {},
    WorkItemNotFoundError: class extends Error {},
    WorkItemForbiddenError: class extends Error {},
    WorkItemRevisionConflictError: class extends Error {},
  };
});

import { PATCH } from "@/app/api/v1/work/items/[id]/route";
import { POST } from "@/app/api/v1/work/items/route";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown,
  route?: unknown
) => Promise<Response>;
describe("work-item uncertain write HTTP receipts", () => {
  for (const [name, handler, body] of [
    ["create", POST, { type: "task", title: "uncertain" }],
    ["patch", PATCH, { set: { title: "uncertain" } }],
  ] as const) {
    it(`${name} returns 409 plus the nonretryable lookup receipt`, async () => {
      const response = await (handler as unknown as Handler)(
        { log: { info: vi.fn() } },
        new Request("http://localhost/api/v1/work/items/task.0001", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        { id: "principal-1" },
        { params: Promise.resolve({ id: "task.0001" }) }
      );
      expect(response.status).toBe(409);
      const error = new WorkItemWriteOutcomeUnknownError(
        "op-1",
        "work-item-op/one",
        "commit-1",
        "task.0001"
      );
      expect(await response.json()).toMatchObject({
        error: error.code,
        retryable: false,
        lookup: error.receipt.lookup,
      });
    });
  }
});
