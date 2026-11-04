// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/knowledge.read-principal`
 * Purpose: Lock in KNOWLEDGE_READ_REQUIRES_PRINCIPAL — bearer-token agents may
 *   read the knowledge plane (list, single entry, citation graph, domain
 *   registry) just like cookie-session humans. Regression guard for the v0
 *   guard that 403'd every bearer browse request.
 * Scope: Exercises the four GET read routes and mutation failure receipts with an `Authorization: Bearer`
 *   header against a seeded fake store or a failing contribution service.
 * Invariants: a bearer-bearing read returns 200 (never 403); link-pulling
 *   (graph edges) is reachable by agents.
 * Side-effects: none (container + auth mocked, fake in-memory store)
 * Links: src/app/api/v1/knowledge, docs/spec/knowledge-syntropy.md
 * @internal
 */

import {
  KnowledgeBusyError,
  KnowledgeWriteConflictError,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeWriteScopeRequiredError,
} from "@cogni/knowledge-store";
import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fresh fake store per test (reassigned in beforeEach); the container mock
// hands the current instance to every route. Lazy factory => reads latest value.
let mockStore: FakeKnowledgeStoreAdapter;
const mockContributions = vi.hoisted(() => ({
  create: vi.fn(),
  appendCommit: vi.fn(),
  merge: vi.fn(),
  close: vi.fn(),
  createEdoHypothesisContribution: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      })),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
    config: { unhandledErrorPolicy: "rethrow" },
    knowledgeStorePort: mockStore,
    knowledgeContributionService: mockContributions,
  })),
}));

// A resolved session user models a *successful bearer-token auth*: the real
// resolveRequestIdentity returns a SessionUser for a valid `cogni_ag_sk_v1_`
// token. We send a Bearer header on every request so the old guard — which
// keyed off that header — would have returned 403.
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

import * as entryHandler from "@/app/api/v1/knowledge/[id]/route";
import * as domainsHandler from "@/app/api/v1/knowledge/domains/route";
import * as graphHandler from "@/app/api/v1/knowledge/graph/route";
import * as listHandler from "@/app/api/v1/knowledge/route";

import * as contributionMutations from "@/app/api/v1/knowledge/contributions/_handlers";
import * as domainMutations from "@/app/api/v1/knowledge/domains/_handlers";
import * as edoMutations from "@/app/api/v1/edo/_handlers";

const BEARER = { authorization: "Bearer cogni_ag_sk_v1_test.signature" };

async function seedStore(store: FakeKnowledgeStoreAdapter) {
  await store.registerDomain({ id: "eng", name: "Engineering" });
  await store.withWrite(
    { operationId: "test.seed", message: "Seed read fixtures" },
    async (write) => {
      await write.upsertKnowledge({
        id: "entry-a",
        domain: "eng",
        title: "Entry A",
        content: "alpha",
        sourceType: "agent",
      });
      await write.upsertKnowledge({
        id: "entry-b",
        domain: "eng",
        title: "Entry B",
        content: "beta",
        sourceType: "agent",
      });
      // Citation edge so the graph route proves agent link-pulling, not just nodes.
      await write.addCitation({
        citingId: "entry-a",
        citedId: "entry-b",
        citationType: "extends",
      });
    }
  );
}

describe("knowledge read routes — KNOWLEDGE_READ_REQUIRES_PRINCIPAL", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockStore = new FakeKnowledgeStoreAdapter();
    await seedStore(mockStore);
  });

  it("GET /knowledge returns 200 for a bearer agent (not 403)", async () => {
    await testApiHandler({
      appHandler: listHandler,
      url: "/api/v1/knowledge",
      async test({ fetch }) {
        const res = await fetch({ method: "GET", headers: BEARER });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.items).toHaveLength(2);
        expect(body.domains).toContain("eng");
      },
    });
  });

  it("GET /knowledge/[id] returns 200 for a bearer agent (not 403)", async () => {
    await testApiHandler({
      appHandler: entryHandler,
      params: { id: "entry-a" },
      url: "/api/v1/knowledge/entry-a",
      async test({ fetch }) {
        const res = await fetch({ method: "GET", headers: BEARER });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe("entry-a");
      },
    });
  });

  it.each([
    { id: "entry-a", useWhen: "Use when reviewing this entry." },
    { id: "entry-b", useWhen: null },
  ])("serializes the retrieval trigger for $id at the read boundary", async ({
    id,
    useWhen,
  }) => {
    const entry = await mockStore.getKnowledge(id);
    if (!entry) throw new Error("Seeded entry is missing");
    const getKnowledge = vi.spyOn(mockStore, "getKnowledge");
    // The immutable 0.3.3 fake write path omits useWhen. Supply its typed
    // read result only for projection coverage, not persistence proof.
    if (useWhen !== null) {
      getKnowledge.mockResolvedValueOnce({ ...entry, useWhen });
    }
    try {
      await testApiHandler({
        appHandler: entryHandler,
        params: { id },
        url: `/api/v1/knowledge/${id}`,
        async test({ fetch }) {
          const res = await fetch({ method: "GET", headers: BEARER });
          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.id).toBe(id);
          expect(body.useWhen).toBe(useWhen);
        },
      });
      expect(getKnowledge).toHaveBeenCalledTimes(1);
      expect(getKnowledge).toHaveBeenCalledWith(id);
    } finally {
      getKnowledge.mockRestore();
    }
  });

  it("GET /knowledge/graph returns 200 + edges for a bearer agent (link-pulling)", async () => {
    await testApiHandler({
      appHandler: graphHandler,
      url: "/api/v1/knowledge/graph",
      async test({ fetch }) {
        const res = await fetch({ method: "GET", headers: BEARER });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.nodes).toHaveLength(2);
        expect(body.edges).toEqual([
          expect.objectContaining({
            source: "entry-a",
            target: "entry-b",
            citationType: "extends",
          }),
        ]);
      },
    });
  });

  it("GET /knowledge/domains returns 200 for a bearer agent (not 403)", async () => {
    await testApiHandler({
      appHandler: domainsHandler,
      url: "/api/v1/knowledge/domains",
      async test({ fetch }) {
        const res = await fetch({ method: "GET", headers: BEARER });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.domains.map((d: { id: string }) => d.id)).toContain("eng");
      },
    });
  });
});

/** Actual handlers must preserve the typed service failure across the HTTP boundary. */
describe("knowledge mutation failure receipts", () => {
  beforeEach(() => {
    mockStore = new FakeKnowledgeStoreAdapter();
    Object.values(mockContributions).forEach((method) => method.mockReset());
  });
  function request(body: unknown) {
    return new Request("https://node.test/api/v1/knowledge/contributions", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const operations = [
    {
      name: "create",
      method: () => mockContributions.create,
      invoke: () =>
        contributionMutations.handleCreate(
          request({ message: "Create" }),
          TEST_SESSION_USER_1
        ),
    },
    {
      name: "append",
      method: () => mockContributions.appendCommit,
      invoke: () =>
        contributionMutations.handleAppendCommit(
          request({
            message: "Append",
            edits: [
              {
                op: "patch",
                targetRowId: "entry-a",
                entry: { useWhen: "Inspect after timeout" },
              },
            ],
          }),
          "contrib-a",
          TEST_SESSION_USER_1
        ),
    },
    {
      name: "merge",
      method: () => mockContributions.merge,
      invoke: () =>
        contributionMutations.handleMerge(
          request({}),
          "contrib-a",
          TEST_SESSION_USER_1
        ),
    },
    {
      name: "close",
      method: () => mockContributions.close,
      invoke: () =>
        contributionMutations.handleClose(
          request({ reason: "Close" }),
          "contrib-a",
          TEST_SESSION_USER_1
        ),
    },
    {
      name: "domain create",
      method: () => vi.spyOn(mockStore, "registerDomain"),
      invoke: () =>
        domainMutations.handleCreate(
          request({ id: "eng", name: "Engineering" }),
          TEST_SESSION_USER_1
        ),
    },
    {
      name: "EDO create",
      method: () => mockContributions.createEdoHypothesisContribution,
      invoke: () =>
        edoMutations.handleHypothesize(
          request({
            id: "hypothesis-a",
            domain: "eng",
            title: "A falsifiable claim",
            content: "Evidence and prediction",
            evaluateAt: "2026-12-01T00:00:00.000Z",
          }),
          TEST_SESSION_USER_1
        ),
    },
  ];
  const failures = [
    {
      name: "unknown outcome",
      error: () =>
        new KnowledgeWriteOutcomeUnknownError(
          "operation-a",
          "cogni/operation-a",
          "a".repeat(32)
        ),
      status: 409,
      expected: {
        errorCode: "knowledge_write_outcome_unknown",
        retryable: false,
        operationId: "operation-a",
        branch: "cogni/operation-a",
        commitHash: "a".repeat(32),
      },
    },
    {
      name: "closed scope",
      error: () => new KnowledgeWriteScopeRequiredError(),
      status: 500,
      expected: {
        errorCode: "knowledge_write_scope_required",
        retryable: false,
      },
    },
    {
      name: "conflicting write",
      error: () => new KnowledgeWriteConflictError("entry-a"),
      status: 409,
      expected: {
        errorCode: "knowledge_write_conflict",
        retryable: false,
        entryId: "entry-a",
      },
    },
    {
      name: "pre-admission busy",
      error: () => new KnowledgeBusyError(),
      status: 503,
      expected: { retryable: true },
    },
  ];
  for (const operation of operations) {
    for (const failure of failures) {
      it(`${operation.name} preserves ${failure.name} without replay`, async () => {
        const method = operation.method();
        const error = failure.error();
        method.mockRejectedValueOnce(error);
        const response = await operation.invoke();
        expect(response.status).toBe(failure.status);
        expect(await response.json()).toEqual({
          error: error.message,
          ...failure.expected,
        });
        expect(response.headers.get("Retry-After")).toBe(
          failure.status === 503 ? "2" : null
        );
        expect(method).toHaveBeenCalledTimes(1);
      });
    }
  }
  for (const operation of operations.slice(0, 4)) {
    it(`${operation.name} preserves an unknown outcome with no acknowledged hash`, async () => {
      const method = operation.method();
      method.mockRejectedValueOnce(
        new KnowledgeWriteOutcomeUnknownError("before-ack", "contrib/retained")
      );
      const response = await operation.invoke();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        retryable: false,
        operationId: "before-ack",
        branch: "contrib/retained",
        commitHash: null,
      });
      expect(method).toHaveBeenCalledTimes(1);
    });
  }
  it("keeps unrelated failures for the normal server-error policy", async () => {
    const failure = new Error("unexpected implementation failure");
    mockContributions.create.mockRejectedValueOnce(failure);
    await expect(operations[0]!.invoke()).rejects.toBe(failure);
  });
});
