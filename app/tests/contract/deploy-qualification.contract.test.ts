// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Real stdlib helper + signed app route. Only DNS is redirected to the test's local process. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { hkdfSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SignJWT } from "jose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type FixtureRuntime,
  qualifyFixture,
} from "@/features/deploy-qualification/qualification";

const sha = "a".repeat(40);
const digest = `ghcr.io/cogni-test-org/spawny-boi@sha256:${"b".repeat(64)}`;
const runtime: FixtureRuntime = {
  authSecret: "fixture-test-only-purpose-secret-32-characters",
  nodeId: "d520f82e-486a-40f1-9e4f-c8ef7a016e9a",
  env: "candidate-a",
  sourceSha: sha,
  helperUrl: "http://fixture-helper:9101",
};
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    AUTH_SECRET: runtime.authSecret,
    DEPLOY_ENVIRONMENT: runtime.env,
    APP_BUILD_SHA: runtime.sourceSha,
    FIXTURE_HELPER_URL: runtime.helperUrl,
  }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => runtime.nodeId }));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => ({ info: vi.fn() }),
}));

import { POST } from "@/app/api/v1/deploy/qualification/route";

const nativeFetch = globalThis.fetch;
const directory = mkdtempSync(resolve(tmpdir(), "spawny-proof-"));
const events: Record<string, unknown>[] = [];
let helper: ChildProcessWithoutNullStreams;
let origin: string;
let loseResponse = false;
let mutations = 0;
let dispatches = 0;
let loseReservationResponse = false;

async function start() {
  const child = spawn(
    "python3",
    [resolve(__dirname, "../../../fixtures/qualification/helper.py")],
    {
      env: {
        // biome-ignore lint/style/noProcessEnv: pass only PATH, not app secrets, to the stdlib helper.
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        APP_BUILD_SHA: sha,
        PORT: "0",
        FIXTURE_DB: resolve(directory, "fixture.sqlite"),
      },
    }
  );
  helper = child;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`helper boot timed out: ${stderr}`)),
      5000
    );
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`helper exit ${code}: ${stderr}`));
    });
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const event = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        events.push(event);
        if (event.event === "fixture.helper_boot") {
          origin = `http://127.0.0.1:${event.port}`;
          clearTimeout(timer);
          accept();
        }
      }
    });
  });
}
async function stop() {
  if (helper.exitCode !== null) return;
  helper.kill("SIGTERM");
  await once(helper, "exit");
}
function claims(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "cogni-operator",
    aud: "cogni-release-qualification",
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    nodeId: runtime.nodeId,
    env: runtime.env,
    releaseId: randomUUID(),
    sourceSha: sha,
    bundleDigest: digest,
    services: { app: digest, "fixture-helper": digest },
    attemptId: randomUUID(),
    allocation: "allocation-A",
    mode: "qualify",
    helperBootId: null,
    companionBootIds: null,
    companionReadiness: { "fixture-helper": { port: 9101, path: "/readyz" } },
    ...overrides,
  };
}
async function request(
  c = claims(),
  body: unknown = { mode: c.mode },
  keySecret = runtime.authSecret
) {
  const purpose = "cogni-release-qualification-v1";
  const key = new Uint8Array(
    hkdfSync("sha256", keySecret, purpose, purpose, 32)
  );
  const token = await new SignJWT(c)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(key);
  return new Request("https://spawny.example/api/v1/deploy/qualification", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function proof(c = claims()) {
  const response = await POST(await request(c));
  return { response, body: await response.json() };
}
function readback(c: ReturnType<typeof claims>, bootId: string) {
  return {
    ...c,
    mode: "readback",
    helperBootId: bootId,
    companionBootIds: { "fixture-helper": bootId },
  };
}

beforeAll(async () => {
  await start();
});
afterAll(async () => {
  await stop();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  loseResponse = false;
  mutations = 0;
  dispatches = 0;
  loseReservationResponse = false;
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("http://fixture-helper:9101");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    if (init?.method === "POST") mutations++;
    if (url.pathname.endsWith("/commit")) dispatches++;
    const response = await nativeFetch(new URL(url.pathname, origin), init);
    if (
      (loseResponse && url.pathname.endsWith("/commit")) ||
      (loseReservationResponse && url.pathname === "/fixture/reserve")
    ) {
      loseResponse = false;
      loseReservationResponse = false;
      await response.arrayBuffer();
      throw new Error("committed response lost");
    }
    return response;
  });
});

describe("signed qualification against real ephemeral transaction helper", () => {
  it("commits once under races, then re-reads without a write across caller restart", async () => {
    const c = claims();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => proof(c))
    );
    expect(results.some((r) => r.response.status === 200)).toBe(true);
    const successful = results.filter((r) => r.response.status === 200);
    expect(new Set(successful.map((r) => r.body.evidenceId)).size).toBe(1);
    const b = successful[0]?.body;
    expect(b.companions["fixture-helper"]).toMatchObject({
      buildSha: sha,
      bootId: b.helper.bootId,
      ready: { port: 9101, path: "/readyz", status: 200 },
    });
    const before = mutations;
    expect((await proof(readback(c, b.helper.bootId))).response.status).toBe(
      200
    );
    expect(mutations).toBe(before);
    expect(dispatches).toBe(1);
    expect(
      events.filter(
        (e) => e.event === "fixture.useful_work" && e.releaseId === c.releaseId
      )
    ).toHaveLength(1);
  });
  it("uses only readback after a lost committed response", async () => {
    const c = claims();
    loseResponse = true;
    expect((await proof(c)).response.status).toBe(200);
    expect(mutations).toBe(2);
    expect(
      events.filter(
        (e) => e.event === "fixture.useful_work" && e.releaseId === c.releaseId
      )
    ).toHaveLength(1);
  });
  it("does not dispatch an ambiguous reservation, including replay by a fresh caller", async () => {
    const c = claims();
    loseReservationResponse = true;
    expect((await proof(c)).response.status).toBe(503);
    expect(dispatches).toBe(0);
    expect((await proof(c)).response.status).toBe(503);
    const boot = (await (await nativeFetch(`${origin}/version`)).json()).bootId;
    expect((await proof(readback(c, boot))).response.status).toBe(503);
    expect(dispatches).toBe(0);
    expect(
      events.filter(
        (e) => e.event === "fixture.useful_work" && e.releaseId === c.releaseId
      )
    ).toHaveLength(0);
  });
  it("fails unknown results without a saved row; readback cannot insert", async () => {
    const c = claims();
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      if (init.method === "POST") {
        mutations++;
        throw new Error("unknown");
      }
      return nativeFetch(new URL(url.pathname, origin), init);
    });
    expect((await proof(c)).response.status).toBe(503);
    const boot = (await (await nativeFetch(`${origin}/version`)).json()).bootId;
    expect((await proof(readback(c, boot))).response.status).toBe(503);
    expect(mutations).toBe(1);
  });
  it("refuses another allocation, attempt, bundle or declaration on an existing release", async () => {
    const c = claims();
    const first = await proof(c);
    for (const change of [
      { allocation: "allocation-B" },
      { attemptId: randomUUID() },
      { bundleDigest: digest.replace("b".repeat(64), "c".repeat(64)) },
      {
        companionReadiness: {
          "fixture-helper": { port: 9101, path: "/readyz-alt" },
        },
      },
    ]) {
      expect(
        (await proof({ ...readback(c, first.body.helper.bootId), ...change }))
          .response.status
      ).toBe(503);
    }
  });
  it("observes the signed failing readiness path while version remains healthy", async () => {
    expect((await nativeFetch(`${origin}/version`)).status).toBe(200);
    const c = claims({
      companionReadiness: {
        "fixture-helper": { port: 9101, path: "/readyz-fail" },
      },
    });
    expect((await proof(c)).response.status).toBe(503);
    expect(mutations).toBe(0);
  });
  it("refuses old proof after helper restart, even with healthy readiness", async () => {
    const c = claims();
    const first = await proof(c);
    await stop();
    await start();
    expect((await nativeFetch(`${origin}/readyz`)).status).toBe(200);
    expect(
      (await proof(readback(c, first.body.helper.bootId))).response.status
    ).toBe(503);
    expect((await proof(c)).response.status).toBe(503);
    expect(
      events.filter(
        (e) => e.event === "fixture.useful_work" && e.releaseId === c.releaseId
      )
    ).toHaveLength(1);
  });
  it("rejects stale/wrong authority, identity and incomplete selected sets before IO", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      (
        await POST(
          new Request("https://spawny.example/api/v1/deploy/qualification", {
            method: "POST",
          })
        )
      ).status
    ).toBe(401);
    for (const change of [
      { nodeId: randomUUID() },
      { sourceSha: "c".repeat(40) },
      { env: "preview" },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { exp: Math.floor(Date.now() / 1000) + 600 },
      { services: { app: digest } },
      { companionReadiness: {} },
      {
        companionReadiness: {
          "fixture-helper": { port: 9101, path: "//elsewhere" },
        },
      },
      { mode: "readback", helperBootId: randomUUID(), companionBootIds: {} },
    ]) {
      expect((await proof(claims(change))).response.status).toBe(401);
    }
    expect(
      (await POST(await request(claims(), undefined, "wrong-secret"))).status
    ).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds input, rejects mode confusion and refuses production", async () => {
    expect(
      (await POST(await request(claims(), { mode: "readback" }))).status
    ).toBe(503);
    expect(
      (
        await POST(
          await request(claims(), { mode: "qualify", extra: "x".repeat(200) })
        )
      ).status
    ).toBe(503);
    const req = await request();
    expect(
      (await qualifyFixture(req, { ...runtime, env: "production" })).status
    ).toBe(404);
    expect(mutations).toBe(0);
  });
  it("aborts a stalled request body within the operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const signed = await request();
      const stalled = new Request(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: new ReadableStream({ start() {} }),
        duplex: "half",
      } as RequestInit);
      const pending = POST(stalled);
      await vi.advanceTimersByTimeAsync(19_001);
      expect((await pending).status).toBe(503);
      expect(mutations).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
