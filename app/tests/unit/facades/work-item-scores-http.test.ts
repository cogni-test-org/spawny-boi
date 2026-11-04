// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-item-scores-http`
 * Purpose: Prove the `scores` write path has one shared bounds enforcer (story.5111).
 * Scope: Real route handlers + real facade + real DoltgresWorkItemAdapter configured with
 *   no hostname configuration; the SQL client is a stub that must never be called.
 * Invariants:
 *   - SCORES_ONE_ENFORCER: the adapter's parseWorkItemScores rejects; the route answers 400
 *     with the package issues and never 500.
 * * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts
 * @internal
 */

import {
  WorkItemScoresInvalidError as AdapterScoresInvalidError,
  DoltgresWorkItemAdapter,
} from "@cogni/work-items/adapters/doltgres";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { PATCH } from "@/app/api/v1/work/items/[id]/route";
import { POST } from "@/app/api/v1/work/items/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown,
  route?: unknown
) => Promise<Response>;

const sqlCalls = vi.fn();
function stubSql(): Sql {
  return Object.assign(
    async (...args: unknown[]) => {
      sqlCalls(args);
      throw new Error("SQL must not run for rejected scores");
    },
    {
      unsafe: (...args: unknown[]) => {
        sqlCalls(args);
        throw new Error("SQL must not run for rejected scores");
      },
      reserve: (...args: unknown[]) => {
        sqlCalls(args);
        throw new Error("SQL must not run for rejected scores");
      },
      end: async () => undefined,
    }
  ) as unknown as Sql;
}

const ctx = { log: { info: vi.fn() } };
const user = { id: "principal-1" };

function post(body: unknown): Promise<Response> {
  return (POST as unknown as Handler)(
    ctx,
    new Request("http://localhost/api/v1/work/items", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    user
  );
}

function patch(body: unknown): Promise<Response> {
  return (PATCH as unknown as Handler)(
    ctx,
    new Request("http://localhost/api/v1/work/items/task.0001", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    user,
    { params: Promise.resolve({ id: "task.0001" }) }
  );
}

describe("work-item scores HTTP boundary (story.5111)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: new DoltgresWorkItemAdapter(stubSql(), {
        readClient: stubSql(),
      }),
    } as never);
  });

  it.each([
    ["v ≥ 4 without ev", { goal: { v: 4 } }, "evidence_required"],
    [
      "URL credentials",
      { goal: { v: 4, ev: "https://user:pass@example.com/x" } },
      "evidence_invalid_url",
    ],
    [
      "http ev",
      { goal: { v: 4, ev: "http://cognidao.org/x" } },
      "evidence_not_https",
    ],
    ["v above 5", { goal: { v: 6 } }, "invalid_value"],
    ["uppercase axis id", { Goal: { v: 1 } }, "invalid_axis_id"],
    ["extra property", { goal: { v: 1, note: "x" } }, "unknown_property"],
  ])("POST create with %s is a 400 from the adapter's validator, before any SQL", async (_label, scores, code) => {
    const response = await post({ type: "task", title: "scored", scores });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "invalid input",
      errorCode: "work_item_scores_invalid",
    });
    expect(body.issues.map((issue: { code: string }) => issue.code)).toContain(
      code
    );
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("PATCH with invalid scores is a 400 with the package issue path, before any SQL", async () => {
    const response = await patch({
      expectedRevision: 3,
      set: { scores: { goal: { v: 5 } } },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errorCode: "work_item_scores_invalid",
      issues: [{ code: "evidence_required", path: ["goal", "ev"] }],
    });
    expect(sqlCalls).not.toHaveBeenCalled();
  });

  it("normalizes an adapter-bundle copy of the error to a 400 (never a 500)", async () => {
    const adapterPatch = vi
      .fn()
      .mockRejectedValue(
        new AdapterScoresInvalidError([
          { code: "too_large", path: [], message: "too big" },
        ])
      );
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: { patch: adapterPatch },
    } as never);
    const response = await patch({ set: { scores: { goal: { v: 1 } } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      issues: [{ code: "too_large" }],
    });
  });

  it("rejects a non-object scores shape at the contract, before the store", async () => {
    const response = await post({
      type: "task",
      title: "scored",
      scores: { goal: { v: "5" } },
    });
    expect(response.status).toBe(400);
    expect(sqlCalls).not.toHaveBeenCalled();
  });
});
