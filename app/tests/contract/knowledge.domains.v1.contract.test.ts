// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/knowledge.domains.v1.contract`
 * Purpose: Pin the wire shape of the knowledge domain operations — get, update, delete — and their typed error body.
 * Scope: Pure Zod schema validation. Does not test HTTP transport, auth, or storage.
 * Invariants: DOMAIN_ID_IS_IMMUTABLE (strict update body), DOMAIN_ERRORS_ARE_TYPED, CONTRACTS_ARE_TRUTH.
 * Side-effects: none
 * Links: packages/node-contracts/src/knowledge.domains.v1.contract.ts
 * @internal
 */

import {
  DomainSchema,
  DomainsCreateResponseSchema,
  DomainsErrorCodeSchema,
  DomainsErrorResponseSchema,
  DomainsUpdateBodySchema,
  domainsDeleteOperation,
  domainsGetOperation,
  domainsUpdateOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const DOMAIN = {
  id: "build-evals",
  name: "build-evals",
  description: "probe",
  confidencePct: 40,
  entryCount: 2,
  createdAt: "2026-10-29T19:39:03.367Z",
};

describe("domain item operations", () => {
  it("get returns the shared DomainSchema (create and get cannot drift)", () => {
    expect(domainsGetOperation.output).toBe(DomainSchema);
    expect(DomainsCreateResponseSchema).toBe(DomainSchema);
    expect(domainsUpdateOperation.output).toBe(DomainSchema);
    expect(domainsGetOperation.output.safeParse(DOMAIN).success).toBe(true);
  });

  it("rejects a malformed domain id in every operation input", () => {
    for (const op of [domainsGetOperation, domainsDeleteOperation]) {
      expect(op.input.safeParse({ domain: "Bad Id" }).success).toBe(false);
      expect(op.input.safeParse({ domain: "x" }).success).toBe(false);
      expect(op.input.safeParse({ domain: "ok-id_1" }).success).toBe(true);
    }
  });

  it("update body: partial, null clears, empty and unknown keys fail", () => {
    expect(DomainsUpdateBodySchema.safeParse({ name: "New" }).success).toBe(
      true
    );
    expect(
      DomainsUpdateBodySchema.safeParse({ description: "fixed" }).success
    ).toBe(true);
    const cleared = DomainsUpdateBodySchema.safeParse({ description: null });
    expect(cleared.success && cleared.data.description).toBeNull();
    // At least one field.
    expect(DomainsUpdateBodySchema.safeParse({}).success).toBe(false);
    // Strict: id and domain can never ride in the body (DOMAIN_ID_IS_IMMUTABLE).
    expect(
      DomainsUpdateBodySchema.safeParse({ id: "other", name: "x" }).success
    ).toBe(false);
    expect(
      DomainsUpdateBodySchema.safeParse({ domain: "other", name: "x" }).success
    ).toBe(false);
    // Bounds mirror create.
    expect(DomainsUpdateBodySchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      DomainsUpdateBodySchema.safeParse({ name: "n".repeat(129) }).success
    ).toBe(false);
    expect(
      DomainsUpdateBodySchema.safeParse({ description: "d".repeat(513) })
        .success
    ).toBe(false);
  });

  it("update input pairs the path domain with the strict body", () => {
    expect(
      domainsUpdateOperation.input.safeParse({
        domain: "build-evals",
        body: { description: "Eval harness and scorecards" },
      }).success
    ).toBe(true);
    expect(
      domainsUpdateOperation.input.safeParse({
        domain: "build-evals",
        body: {},
      }).success
    ).toBe(false);
  });

  it("delete output is a literal deleted:true receipt", () => {
    expect(
      domainsDeleteOperation.output.safeParse({ id: "x1", deleted: true })
        .success
    ).toBe(true);
    expect(
      domainsDeleteOperation.output.safeParse({ id: "x1", deleted: false })
        .success
    ).toBe(false);
  });
});

describe("DomainsErrorResponseSchema", () => {
  it("accepts every code with its typed detail", () => {
    const bodies = [
      { error: "x", errorCode: "domain_not_found" },
      { error: "x", errorCode: "domain_not_empty", entryCount: 2 },
      { error: "x", errorCode: "domain_protected" },
      { error: "x", errorCode: "invalid_input", issues: [{ path: ["name"] }] },
      { error: "x", errorCode: "unauthorized" },
      { error: "x", errorCode: "invalid_json" },
      { error: "x", errorCode: "store_not_configured" },
      {
        error: "x",
        errorCode: "knowledge_write_outcome_unknown",
        retryable: false,
        operationId: "op",
        branch: "b",
        commitHash: null,
      },
      {
        error: "x",
        errorCode: "knowledge_write_scope_required",
        retryable: false,
      },
      {
        error: "x",
        errorCode: "knowledge_write_conflict",
        retryable: false,
        entryId: "e",
      },
      { error: "x", errorCode: "knowledge_busy", retryable: true },
    ];
    for (const b of bodies)
      expect(DomainsErrorResponseSchema.safeParse(b).success).toBe(true);
    // Every enum member is exercised above: adding a code fails this test until covered.
    expect(new Set(bodies.map((b) => b.errorCode))).toEqual(
      new Set(DomainsErrorCodeSchema.options)
    );
  });

  it("requires codes for domain errors and rejects unrecognized auth shapes", () => {
    for (const body of [
      { error: "domain not found" },
      { error: "unauthorized" },
      { error: "Unauthorized", errorCode: "nope" },
      { error: "Session required", retryable: true },
    ])
      expect(DomainsErrorResponseSchema.safeParse(body).success).toBe(false);
  });

  it("accepts only exact shared infrastructure error shapes", () => {
    for (const body of [
      {
        status: "error",
        reason: "CONTAINER_INIT_FAILED",
        message: "unavailable",
      },
      { error: "Internal server error" },
    ]) {
      expect(DomainsErrorResponseSchema.parse(body)).toEqual(body);
    }
    for (const body of [
      { status: "error", reason: "OTHER", message: "unavailable" },
      { status: "error", reason: "CONTAINER_INIT_FAILED" },
      { status: "error", reason: "CONTAINER_INIT_FAILED", message: 123 },
      {
        status: "error",
        reason: "CONTAINER_INIT_FAILED",
        message: "x",
        extra: true,
      },
      { error: "Internal server error", errorCode: "nope" },
      { error: "Internal server error", retryable: true },
      { error: "internal server error" },
    ]) {
      expect(DomainsErrorResponseSchema.safeParse(body).success).toBe(false);
    }
  });

  it("rejects an unknown code", () => {
    expect(
      DomainsErrorResponseSchema.safeParse({ error: "x", errorCode: "nope" })
        .success
    ).toBe(false);
  });
});
