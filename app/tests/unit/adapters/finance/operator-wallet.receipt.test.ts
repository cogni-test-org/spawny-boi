// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Tests real adapter receipt interpretation with fake Privy/RPC; no network or signing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivyOperatorWalletAdapter } from "@cogni/operator-wallet/adapters/privy";
const fake = { receipt: vi.fn(), send: vi.fn(), hash: `0x${"a".repeat(64)}`, address: "0x1111111111111111111111111111111111111111" };
const network = vi.fn(() => { throw new Error("Network forbidden in receipt tests"); });
function adapter(): PrivyOperatorWalletAdapter {
  // Bypass SDK/transport construction; exercise only the actual public method.
  return Object.assign(Object.create(PrivyOperatorWalletAdapter.prototype), {
    walletId: "fake-wallet", stewardAddress: fake.address, maxTopUpUsd: 10, authContext: {},
    client: { wallets: () => ({ ethereum: () => ({ sendTransaction: fake.send }) }) },
    rpcClient: { waitForTransactionReceipt: fake.receipt },
  });
}
describe("steward receipt outcomes", () => {
 beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", network); fake.send.mockResolvedValue({ hash: fake.hash }); });
 afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
 it.each(["success", "reverted"] as const)("preserves %s rather than treating any mined receipt as funding", async (status) => {
  fake.receipt.mockResolvedValue({ status, transactionHash: fake.hash });
  await expect(adapter().withdrawToSteward(1_000_000n)).resolves.toEqual({ txHash: fake.hash, receiptStatus: status });
  expect(fake.send).toHaveBeenCalledTimes(1);
 });
 it.each([
  ["cancellation", { status: "success", transactionHash: `0x${"b".repeat(64)}` }],
  ["unrelated replacement", { status: "success", transactionHash: `0x${"c".repeat(64)}` }],
  ["repricing", { status: "success", transactionHash: `0x${"d".repeat(64)}` }],
  ["reverted replacement", { status: "reverted", transactionHash: `0x${"b".repeat(64)}` }],
  ["missing identity", { status: "success" }],
  ["invalid identity", { status: "success", transactionHash: "0xabc" }],
  ["unsupported status", { status: "unknown", transactionHash: fake.hash }],
 ])("keeps original broadcast pending for %s", async (_reason, receipt) => {
  fake.receipt.mockResolvedValue(receipt);
  await expect(adapter().withdrawToSteward(1_000_000n)).resolves.toEqual({ txHash: fake.hash, receiptStatus: "pending" });
 });
 it("compares receipt identity without hex-letter case sensitivity", async () => {
  fake.receipt.mockResolvedValue({ status: "success", transactionHash: `0x${"A".repeat(64)}` });
  await expect(adapter().withdrawToSteward(1_000_000n)).resolves.toEqual({ txHash: fake.hash, receiptStatus: "success" });
 });
 it("keeps a pending broadcast hash when receipt reading fails", async () => {
  fake.receipt.mockRejectedValue(new Error("RPC timeout"));
  await expect(adapter().withdrawToSteward(1_000_000n)).resolves.toEqual({ txHash: fake.hash, receiptStatus: "pending" });
 });
});
