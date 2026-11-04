// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/knowledge.domains.crud`
 * Purpose: Prove the item-scoped domain routes (GET / PATCH / DELETE /api/v1/knowledge/domains/[domain]) accept any
 *   authenticated principal like POST register, validate input against the contract, and map store failures to typed error bodies.
 * Scope: Real route handlers and shared perimeter against the in-memory fake store. Does not test Doltgres SQL (see tests/component/db/doltgres-domains.int.test.ts).
 * Invariants: DOMAIN_READ_REQUIRES_PRINCIPAL, DOMAIN_MUTATION_BEARER_OR_SESSION (a bearer agent can update and delete;
 *   no principal gets 401), DOMAIN_ID_IS_IMMUTABLE, DOMAIN_DELETE_REFUSES_NONEMPTY, DOMAIN_BASELINE_IS_PROTECTED,
 *   DOMAIN_ERRORS_ARE_TYPED.
 * Side-effects: none (container + auth mocked, fake in-memory store)
 * Links: src/app/api/v1/knowledge/domains/[domain]/route.ts, packages/node-contracts/src/knowledge.domains.v1.contract.ts
 * @internal
 */

import { DomainsErrorResponseSchema } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import {
  KnowledgeBusyError,
  KnowledgeWriteOutcomeUnknownError,
} from "@cogni/knowledge-store";
import { testApiHandler } from "next-test-api-route-handler";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => null) }));
vi.mock("@/auth", () => ({
  authSecret: "test-secret",
  authOptions: { secret: "test-secret" },
}));

// resolveRequestIdentity() returns exactly this shape for a valid bearer token.
const BEARER_AGENT: SessionUser = {
  id: "agent-user",
  walletAddress: null,
  displayName: "agent",
  avatarColor: null,
};
let currentUser: SessionUser | null = BEARER_AGENT;
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => currentUser),
}));

let mockStore: FakeKnowledgeStoreAdapter;
let unhandledErrorPolicy: "rethrow" | "respond_500" = "rethrow";
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log,
    clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
    config: { unhandledErrorPolicy },
    knowledgeStorePort: mockStore,
  })),
}));

import * as itemRoute from "@/app/api/v1/knowledge/domains/[domain]/route";
import * as collectionRoute from "@/app/api/v1/knowledge/domains/route";
import { getContainer } from "@/bootstrap/container";
import { proxy } from "@/proxy";

const JSON_HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer cogni_ag_sk_v1_test.signature",
};

async function seed() {
  mockStore = new FakeKnowledgeStoreAdapter();
  await mockStore.registerDomain({ id: "meta", name: "Meta" });
  await mockStore.registerDomain({
    id: "build-evals",
    name: "build-evals",
    description: "probe",
  });
  await mockStore.registerDomain({ id: "empty-shelf", name: "Empty" });
  await mockStore.withWrite(
    { operationId: "test.seed", message: "seed" },
    async (write) => {
      await write.upsertKnowledge({
        id: "entry-a",
        domain: "build-evals",
        title: "Entry A",
        content: "alpha",
        sourceType: "agent",
      });
    }
  );
}

async function call(
  domain: string,
  method: "GET" | "PATCH" | "DELETE",
  body?: unknown
) {
  let out: { status: number; body: unknown } = { status: 0, body: null };
  await testApiHandler({
    appHandler: itemRoute,
    params: { domain },
    url: `/api/v1/knowledge/domains/${domain}`,
    async test({ fetch }) {
      const res = await fetch({
        method,
        headers: JSON_HEADERS,
        ...(body !== undefined
          ? {
              body: typeof body === "string" ? body : JSON.stringify(body),
            }
          : {}),
      });
      out = { status: res.status, body: await res.json() };
    },
  });
  return out as { status: number; body: Record<string, unknown> };
}

/** Every error body an item route emits must parse as the typed contract. */
function expectTypedError(body: unknown, errorCode: string) {
  const parsed = DomainsErrorResponseSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  expect(
    parsed.success && "errorCode" in parsed.data && parsed.data.errorCode
  ).toBe(errorCode);
}

beforeEach(async () => {
  vi.clearAllMocks();
  log.child.mockImplementation(() => log);
  currentUser = BEARER_AGENT;
  unhandledErrorPolicy = "rethrow";
  await seed();
});

describe("GET /knowledge/domains/[domain] — DOMAIN_READ_REQUIRES_PRINCIPAL", () => {
  it("returns the domain with its live entry count to a bearer agent", async () => {
    currentUser = BEARER_AGENT;
    const res = await call("build-evals", "GET");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "build-evals",
      name: "build-evals",
      description: "probe",
      entryCount: 1,
    });
  });

  it("404 domain_not_found for an unknown id; 400 invalid_input for a malformed one", async () => {
    currentUser = BEARER_AGENT;
    const missing = await call("zz-nope", "GET");
    expect(missing.status).toBe(404);
    expectTypedError(missing.body, "domain_not_found");
    const bad = await call("Bad_ID", "GET");
    expect(bad.status).toBe(400);
    expectTypedError(bad.body, "invalid_input");
  });

  it("401 without a principal (the route wrapper owns the body)", async () => {
    currentUser = null;
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const res = await call(
        "build-evals",
        method,
        method === "GET" ? undefined : {}
      );
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Session required" });
      expect(DomainsErrorResponseSchema.parse(res.body)).toEqual(res.body);
    }
  });
});

describe("domain item shared perimeter", () => {
  it.each(["GET", "PATCH", "DELETE"] as const)(
    "validates the real wrapper %s bootstrap 503",
    async (method) => {
      vi.mocked(getContainer).mockImplementationOnce(() => {
        throw new Error("container unavailable");
      });
      const response = await call(
        "empty-shelf",
        method,
        method === "PATCH" ? { name: "Updated" } : undefined
      );
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: "error",
        reason: "CONTAINER_INIT_FAILED",
        message: "container unavailable",
      });
      expect(DomainsErrorResponseSchema.parse(response.body)).toEqual(
        response.body
      );
      expect(await mockStore.getDomain("empty-shelf")).toMatchObject({
        name: "Empty",
      });
    }
  );

  it.each(["GET", "PATCH", "DELETE"] as const)(
    "validates the real wrapper %s production error conversion",
    async (method) => {
      unhandledErrorPolicy = "respond_500";
      // Params are awaited inside each real route handler, within the wrapper.
      const route = {
        GET: itemRoute.GET,
        PATCH: itemRoute.PATCH,
        DELETE: itemRoute.DELETE,
      }[method];
      const response = await route(
        new NextRequest(
          "http://localhost/api/v1/knowledge/domains/empty-shelf",
          { method }
        ),
        { params: Promise.reject(new Error("private handler failure")) }
      );
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "Internal server error" });
      expect(DomainsErrorResponseSchema.parse(body)).toEqual(body);
      expect(await mockStore.getDomain("empty-shelf")).toMatchObject({
        name: "Empty",
      });
    }
  );

  it.each(["GET", "PATCH", "DELETE"])(
    "validates the middleware-owned %s 401",
    async (method) => {
      const response = await proxy(
        new NextRequest(
          "http://localhost/api/v1/knowledge/domains/build-evals",
          { method }
        )
      );
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toEqual({ error: "Unauthorized" });
      expect(DomainsErrorResponseSchema.parse(body)).toEqual(body);
    }
  );
});

describe("PATCH /knowledge/domains/[domain] — DOMAIN_MUTATION_BEARER_OR_SESSION", () => {
  it("a bearer agent updates the description (the build-evals 'probe' fix) and name; one commit each", async () => {
    const commitsBefore = mockStore.commitLog.length;
    const res = await call("build-evals", "PATCH", {
      description: "Evals: scorecards, harnesses and benchmark datasets.",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "build-evals",
      description: "Evals: scorecards, harnesses and benchmark datasets.",
      entryCount: 1,
    });
    expect(mockStore.commitLog.length).toBe(commitsBefore + 1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        domainId: "build-evals",
        changedFields: ["description"],
      }),
      "knowledge.domains.update_success"
    );

    const renamed = await call("build-evals", "PATCH", {
      name: "Build: Evals",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Build: Evals");
    // The list route (the other reader) sees the same row.
    let listed: Array<{ id: string; name: string }> = [];
    await testApiHandler({
      appHandler: collectionRoute,
      url: "/api/v1/knowledge/domains",
      async test({ fetch }) {
        const r = await fetch({ method: "GET", headers: JSON_HEADERS });
        listed = (await r.json()).domains;
      },
    });
    expect(listed.find((d) => d.id === "build-evals")?.name).toBe(
      "Build: Evals"
    );
  });

  it("description:null clears it; an identical patch makes no commit", async () => {
    const cleared = await call("build-evals", "PATCH", { description: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.description).toBeNull();
    const commits = mockStore.commitLog.length;
    const noop = await call("build-evals", "PATCH", { description: null });
    expect(noop.status).toBe(200);
    expect(mockStore.commitLog.length).toBe(commits);
  });

  it("400 invalid_input for empty body, unknown key, id in body, and bad types; 400 invalid_json for non-JSON", async () => {
    for (const body of [{}, { id: "other" }, { domain: "x1" }, { name: 5 }]) {
      const res = await call("build-evals", "PATCH", body);
      expect(res.status).toBe(400);
      expectTypedError(res.body, "invalid_input");
    }
    const notJson = await call("build-evals", "PATCH", "{not json");
    expect(notJson.status).toBe(400);
    expectTypedError(notJson.body, "invalid_json");
    expect((await mockStore.getDomain("build-evals"))?.description).toBe(
      "probe"
    );
  });

  it("404 domain_not_found for an unknown id", async () => {
    const res = await call("zz-nope", "PATCH", { name: "x" });
    expect(res.status).toBe(404);
    expectTypedError(res.body, "domain_not_found");
  });

  it("maps typed store failures: outcome unknown 409, busy 503 + Retry-After", async () => {
    vi.spyOn(mockStore, "updateDomain").mockRejectedValueOnce(
      new KnowledgeWriteOutcomeUnknownError("op-1", "dolt-op/x", "a".repeat(32))
    );
    const unknown = await call("build-evals", "PATCH", { name: "n1" });
    expect(unknown.status).toBe(409);
    expectTypedError(unknown.body, "knowledge_write_outcome_unknown");
    expect(unknown.body).toMatchObject({
      retryable: false,
      operationId: "op-1",
    });

    vi.spyOn(mockStore, "updateDomain").mockRejectedValueOnce(
      new KnowledgeBusyError()
    );
    const busy = await call("build-evals", "PATCH", { name: "n2" });
    expect(busy.status).toBe(503);
    expectTypedError(busy.body, "knowledge_busy");
  });
});

describe("DELETE /knowledge/domains/[domain] — DOMAIN_MUTATION_BEARER_OR_SESSION + DOMAIN_DELETE_REFUSES_NONEMPTY", () => {
  it("a bearer agent deletes an empty domain; it disappears from list and get", async () => {
    const res = await call("empty-shelf", "DELETE");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "empty-shelf", deleted: true });
    expect(await mockStore.domainExists("empty-shelf")).toBe(false);
    expect((await call("empty-shelf", "GET")).status).toBe(404);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ domainId: "empty-shelf" }),
      "knowledge.domains.delete_success"
    );
    // Re-register restores the id: delete is recoverable.
    await mockStore.registerDomain({ id: "empty-shelf", name: "Empty" });
    expect(await mockStore.domainExists("empty-shelf")).toBe(true);
  });

  it("409 domain_not_empty with entryCount; nothing is deleted or cascaded", async () => {
    const res = await call("build-evals", "DELETE");
    expect(res.status).toBe(409);
    expectTypedError(res.body, "domain_not_empty");
    expect(res.body.entryCount).toBe(1);
    expect(await mockStore.domainExists("build-evals")).toBe(true);
    expect(await mockStore.getKnowledge("entry-a")).not.toBeNull();
  });

  it("409 domain_protected for a baseline domain even when empty", async () => {
    const res = await call("meta", "DELETE");
    expect(res.status).toBe(409);
    expectTypedError(res.body, "domain_protected");
    expect(await mockStore.domainExists("meta")).toBe(true);
  });

  it("404 domain_not_found for an unknown id", async () => {
    const res = await call("zz-nope", "DELETE");
    expect(res.status).toBe(404);
    expectTypedError(res.body, "domain_not_found");
  });
});
