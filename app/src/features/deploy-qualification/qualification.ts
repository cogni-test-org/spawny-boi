// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Test-node-only signed qualification. Private ephemeral PK write/read, no product DB. */
import { hkdfSync } from "node:crypto";
import { jwtVerify } from "jose";
import { z } from "zod";
import { makeLogger } from "@/shared/observability";

const PURPOSE = "cogni-release-qualification-v1";
const HELPER = "fixture-helper";
const SHA = z.string().regex(/^[a-f0-9]{40}$/);
const ID = z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/);
const DIGEST = z
  .string()
  .max(512)
  .regex(/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/);
const identitySchema = z.object({ buildSha: SHA, bootId: z.string().uuid() });
const readinessSchema = z
  .object({
    port: z.literal(9101),
    path: z
      .string()
      .max(200)
      .regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/),
  })
  .strict();
const claimsSchema = z
  .object({
    iss: z.literal("cogni-operator"),
    aud: z.literal("cogni-release-qualification"),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: ID,
    nodeId: z.string().uuid(),
    env: z.enum(["candidate-a", "preview"]),
    releaseId: ID,
    sourceSha: SHA,
    bundleDigest: DIGEST,
    services: z.object({ app: DIGEST, "fixture-helper": DIGEST }).strict(),
    attemptId: ID,
    allocation: ID,
    mode: z.enum(["qualify", "readback"]),
    helperBootId: z.string().uuid().nullable(),
    companionReadiness: z
      .object({ "fixture-helper": readinessSchema })
      .strict(),
    companionBootIds: z
      .object({ "fixture-helper": z.string().uuid() })
      .strict()
      .nullable(),
  })
  .strict();
const receiptSchema = z
  .object({
    subject: z.record(z.string(), z.unknown()),
    value: z.literal(1),
    evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const observedReadinessSchema = readinessSchema.extend({
  status: z.literal(200),
  observedAt: z.string().datetime(),
});
const companionSchema = identitySchema
  .extend({ ready: observedReadinessSchema })
  .strict();
export const qualificationResponseSchema = claimsSchema
  .pick({
    nodeId: true,
    env: true,
    releaseId: true,
    sourceSha: true,
    bundleDigest: true,
    services: true,
    attemptId: true,
    allocation: true,
  })
  .extend({
    status: z.literal("qualified"),
    helper: identitySchema.extend({ service: z.literal(HELPER) }).strict(),
    evidenceId: receiptSchema.shape.evidenceId,
    observedAt: z.string().datetime(),
    nonce: ID,
    companions: z.object({ "fixture-helper": companionSchema }).strict(),
  })
  .strict();

export interface FixtureRuntime {
  authSecret: string;
  nodeId: string;
  env: string | undefined;
  sourceSha: string | undefined;
  helperUrl: string | undefined;
}

/** Bounded streaming read also applies while awaiting a stalled body chunk. */
async function readJson(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  max: number,
  checkLifetime: () => void
): Promise<unknown> {
  if (!body) throw new Error("missing_body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    checkLifetime();
    for (;;) {
      checkLifetime();
      const part = await reader.read();
      checkLifetime();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw new Error("body_too_large");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    // A producer may never settle cancellation; do not delay the response.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function same(a: unknown, b: unknown): boolean {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)])
          )
        : v;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

export async function qualifyFixture(
  request: Request,
  runtime: FixtureRuntime
): Promise<Response> {
  const controller = new AbortController();
  const actionDeadline = Date.now() + 19_000;
  let timer = setTimeout(() => controller.abort(), 19_000);
  const signal = AbortSignal.any([controller.signal, request.signal]);
  let deadline = actionDeadline;
  const checkLifetime = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("deadline");
  };
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  let authenticated = false;
  try {
    if (
      !runtime.authSecret ||
      !["candidate-a", "preview"].includes(runtime.env ?? "")
    )
      return reply({ error: "fixture_unavailable" }, 404);
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 16_384)
      return reply({ error: "unauthorized" }, 401);
    const key = new Uint8Array(
      hkdfSync("sha256", runtime.authSecret, PURPOSE, PURPOSE, 32)
    );
    const { payload, protectedHeader } = await jwtVerify(
      authorization.slice(7),
      key,
      {
        algorithms: ["HS256"],
        issuer: "cogni-operator",
        audience: "cogni-release-qualification",
        requiredClaims: ["iat", "exp", "jti"],
      }
    );
    const c = claimsSchema.parse(payload);
    deadline = Math.min(actionDeadline, c.exp * 1000);
    const now = Math.floor(Date.now() / 1000);
    if (
      protectedHeader.typ !== "JWT" ||
      c.iat > now ||
      c.exp - c.iat > 60 ||
      c.exp <= c.iat ||
      c.nodeId !== runtime.nodeId ||
      c.env !== runtime.env ||
      c.sourceSha !== runtime.sourceSha ||
      (c.mode === "qualify"
        ? c.helperBootId !== null || c.companionBootIds !== null
        : !c.helperBootId || c.companionBootIds?.[HELPER] !== c.helperBootId)
    )
      throw new Error("invalid_subject");
    authenticated = true;
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - Date.now())
    );
    checkLifetime();
    if (
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return reply({ error: "content_type" }, 400);
    const body = z
      .object({ mode: z.literal(c.mode) })
      .strict()
      .parse(await readJson(request.body, signal, 128, checkLifetime));
    checkLifetime();
    if (body.mode !== c.mode) throw new Error("mode_mismatch");
    if (!runtime.helperUrl) throw new Error("missing_binding");
    const base = new URL(runtime.helperUrl);
    if (
      base.protocol !== "http:" ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      base.hostname !== HELPER ||
      base.port !== "9101"
    )
      throw new Error("invalid_binding");
    const call = async (path: string, subject?: unknown) => {
      checkLifetime();
      const res = await fetch(new URL(path, base), {
        method: subject ? "POST" : "GET",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          "X-Fixture-Deadline-Ms": String(deadline),
          ...(subject ? { "Content-Type": "application/json" } : {}),
        },
        ...(subject
          ? {
              body: JSON.stringify(subject),
            }
          : {}),
      });
      try {
        checkLifetime();
        if (res.status !== 200) throw new Error("helper_refused");
        const result = await readJson(res.body, signal, 8192, checkLifetime);
        checkLifetime();
        return result;
      } finally {
        await res.body?.cancel().catch(() => {});
      }
    };
    const declaration = c.companionReadiness[HELPER];
    const observe = async () => {
      checkLifetime();
      const version = identitySchema.parse(await call("/version"));
      if (
        version.buildSha !== c.sourceSha ||
        (c.mode === "readback" && version.bootId !== c.helperBootId)
      )
        throw new Error("helper_identity");
      const ready = identitySchema
        .extend({ ready: z.literal(true) })
        .parse(await call(declaration.path));
      if (!same(version, { buildSha: ready.buildSha, bootId: ready.bootId }))
        throw new Error("readiness_identity");
      checkLifetime();
      return {
        ...version,
        ready: {
          ...declaration,
          status: 200 as const,
          observedAt: new Date().toISOString(),
        },
      };
    };
    const before = await observe();
    const subject = {
      nodeId: c.nodeId,
      env: c.env,
      releaseId: c.releaseId,
      sourceSha: c.sourceSha,
      bundleDigest: c.bundleDigest,
      services: c.services,
      attemptId: c.attemptId,
      allocation: c.allocation,
      helperBootId: before.bootId,
      companionReadiness: c.companionReadiness,
    };
    const receiptPath = `/fixture/${encodeURIComponent(c.releaseId)}`;
    if (c.mode === "qualify") {
      try {
        const reservation = z
          .object({ inserted: z.boolean() })
          .strict()
          .parse(await call("/fixture/reserve", subject));
        if (reservation.inserted) await call(`${receiptPath}/commit`, subject);
      } catch {
        /* Unknown commit result authorizes readback only. Never repeat POST here. */
      }
    }
    // Always re-read the committed row; a POST reply is not saved useful-work evidence.
    const receipt = receiptSchema.parse(await call(receiptPath));
    if (!same(receipt.subject, subject)) throw new Error("receipt_subject");
    const after = await observe();
    if (before.bootId !== after.bootId) throw new Error("helper_restarted");
    checkLifetime();
    const result = qualificationResponseSchema.parse({
      status: "qualified",
      nodeId: subject.nodeId,
      env: subject.env,
      releaseId: subject.releaseId,
      sourceSha: subject.sourceSha,
      bundleDigest: subject.bundleDigest,
      services: subject.services,
      attemptId: subject.attemptId,
      allocation: subject.allocation,
      helper: {
        service: HELPER,
        buildSha: after.buildSha,
        bootId: after.bootId,
      },
      companions: { [HELPER]: after },
      evidenceId: receipt.evidenceId,
      observedAt: new Date().toISOString(),
      nonce: c.jti,
    });
    checkLifetime();
    makeLogger({ nodeId: c.nodeId }).info(
      { event: "fixture.qualification", mode: c.mode, ...result },
      "fixture.qualification"
    );
    checkLifetime();
    const response = reply(result);
    checkLifetime();
    return response;
  } catch {
    return reply(
      { error: authenticated ? "qualification_failed" : "unauthorized" },
      authenticated ? 503 : 401
    );
  } finally {
    clearTimeout(timer);
  }
}
