// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/steward-withdrawal.route`
 * Purpose: Exercise the real withdrawal handler's guards and outcome classification.
 * Scope: Fake session, config, container and wallet; real request parsing and response.
 * Invariants: No SDK construction, signing, credentials or network. Guards never send.
 * Side-effects: none
 * Links: src/app/api/v1/payments/steward-withdrawal/route.ts
 * @internal
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  steward: vi.fn(),
  container: vi.fn(),
  session: vi.fn(),
  withdraw: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  network: vi.fn(() => {
    throw new Error("Network forbidden in route tests");
  }),
}));

vi.mock("@cogni/node-shared", () => ({
  EVENT_NAMES: { PAYMENTS_STEWARD_WITHDRAWAL: "payments.steward_withdrawal" },
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: fake.session }));
vi.mock("@/shared/config", () => ({ getStewardWalletConfig: fake.steward }));
vi.mock("@/bootstrap/container", () => ({ getContainer: fake.container }));
// This seam deliberately does not prove the authentication/logging wrapper.
// The route's own steward identity check and every handler branch remain real.
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: unknown,
        request: Request,
        session: unknown
      ) => Promise<Response>
    ) =>
    (request: Request) =>
      handler(
        { log: { info: fake.info, warn: fake.warn, error: fake.error } },
        request,
        fake.session()
      ),
}));

import { POST } from "@/app/api/v1/payments/steward-withdrawal/route";

const steward = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const txHash = `0x${"a".repeat(64)}`;
async function post(body: unknown = { amountUsd: 2.5 }): Promise<Response> {
  return POST(
    new NextRequest("https://node.example/api/v1/payments/steward-withdrawal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("steward withdrawal route with fake wallet", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fake.network);
    fake.steward.mockReturnValue({ address: steward });
    fake.session.mockReturnValue({ walletAddress: steward.toUpperCase() });
    fake.container.mockReturnValue({
      operatorWallet: { withdrawToSteward: fake.withdraw },
    });
    fake.withdraw.mockResolvedValue({ txHash, receiptStatus: "success" });
  });
  afterEach(() => {
    expect(fake.network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([
    ["success", "steward wallet funded"],
    ["reverted", "steward wallet funding reverted"],
    ["pending", "steward wallet funding broadcast, pending"],
  ])("preserves %s and logs the actual outcome", async (receiptStatus, message) => {
    fake.withdraw.mockResolvedValue({ txHash, receiptStatus });
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      txHash,
      receiptStatus,
      amountUsd: 2.5,
    });
    expect(fake.withdraw).toHaveBeenCalledExactlyOnceWith(2_500_000n);
    expect(fake.info).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash,
        receiptStatus,
        amountUsdcAtomic: "2500000",
        steward,
      }),
      message
    );
  });

  it.each([
    "STEWARD_NOT_CONFIGURED",
    "INVALID_AMOUNT",
    "MAX_TOPUP_CAP",
  ])("classifies the adapter's %s guard as a pre-broadcast refusal", async (guard) => {
    fake.withdraw.mockRejectedValue(
      new Error(`[OperatorWallet] ${guard}: refused`)
    );
    const response = await post();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "Steward withdrawal rejected",
    });
    expect(fake.info).not.toHaveBeenCalled();
  });

  it.each([
    "receipt wait timed out",
    "Privy socket closed after acceptance",
  ])("keeps %s unknown rather than safe to retry", async (message) => {
    fake.withdraw.mockRejectedValue(new Error(message));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Steward withdrawal result unknown",
      detail: message,
    });
    expect(fake.error).toHaveBeenCalledWith(
      expect.any(Object),
      "steward_withdrawal_result_unknown"
    );
    expect(fake.info).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "0x1111111111111111111111111111111111111111",
  ])("rejects missing or different caller wallet before touching the container: %s", async (walletAddress) => {
    fake.session.mockReturnValue({ walletAddress });
    expect((await post()).status).toBe(403);
    expect(fake.container).not.toHaveBeenCalled();
    expect(fake.withdraw).not.toHaveBeenCalled();
  });

  it.each([
    {},
    null,
    { amountUsd: 0 },
    { amountUsd: -1 },
    { amountUsd: 10_001 },
    { amountUsd: "1" },
  ])("rejects invalid body without touching the wallet: %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(fake.container).not.toHaveBeenCalled();
    expect(fake.withdraw).not.toHaveBeenCalled();
  });

  it("fails closed when the steward is unconfigured", async () => {
    fake.steward.mockReturnValue(null);
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "STEWARD_UNCONFIGURED",
    });
    expect(fake.container).not.toHaveBeenCalled();
    expect(fake.withdraw).not.toHaveBeenCalled();
  });

  it("fails closed when the operator wallet is unconfigured", async () => {
    fake.container.mockReturnValue({ operatorWallet: undefined });
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "OPERATOR_WALLET_UNCONFIGURED",
    });
    expect(fake.withdraw).not.toHaveBeenCalled();
  });

  it("passes only the amount to the wallet, ignoring caller-supplied destinations", async () => {
    await post({
      amountUsd: 1,
      to: "0x1111111111111111111111111111111111111111",
    });
    expect(fake.withdraw).toHaveBeenCalledExactlyOnceWith(1_000_000n);
  });
});
