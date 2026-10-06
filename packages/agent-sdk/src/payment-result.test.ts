import { describe, expect, it } from "vitest";

import { AgentPaymentResult } from "./payment-result.js";
import type { AgentHttpResponseCapture, AgentPaymentRecord } from "./types.js";

// The client-level cases (`client.test.ts`) prove which envelope becomes which
// result and the two "nothing to read" refusals. This file proves what the
// result object itself decides: defaults, the late-delivery pairing, and that
// the captured body is read byte-exact.

const payment: AgentPaymentRecord = {
  id: "pay_1",
  agentAccountId: "acct_1",
  resourceUrl: "https://seller.example/forecast",
  description: null,
  destinationWallet: `0x${"4".repeat(40)}`,
  asset: "USDC",
  amountUsdcMinor: "10000",
  feeUsdcMinor: "0",
  chainId: 84532,
  status: "settled",
  txHash: `0x${"ab".repeat(32)}`,
  failureReason: null,
  approvalExpiresAt: null,
  resolvedAt: "2026-10-06T12:00:00.000Z",
  settledAt: "2026-10-06T12:00:00.000Z",
  createdAt: "2026-10-06T11:59:59.000Z",
};

function capture(bytes: Uint8Array): AgentHttpResponseCapture {
  return {
    status: 200,
    headers: {},
    bodyBase64: btoa(String.fromCharCode(...bytes)),
    mimeType: "application/octet-stream",
  };
}

const UNTIL = "2026-10-06T12:05:00.000Z";

describe("AgentPaymentResult", () => {
  it("defaults every optional field to null/false, never to undefined", () => {
    const result = new AgentPaymentResult({ paymentId: "pay_1", status: "settled", payment });

    expect(result).toMatchObject({
      idempotencyKey: null,
      replayed: false,
      txHash: null,
      approvalUrl: null,
      response: null,
      requestMethod: null,
      bodySha256: null,
      lateDeliveryPending: false,
      lateDeliveryUntil: null,
    });
    expect(result.settled).toBe(true);
    expect(result.pendingApproval).toBe(false);
  });

  it("a pending approval is not settled and offers no resource body", () => {
    const result = new AgentPaymentResult({
      paymentId: "pay_1",
      status: "pending_approval",
      payment: { ...payment, status: "pending_approval", txHash: null },
      approvalUrl: "https://genesispay.test/dashboard/approvals",
    });

    expect(result.settled).toBe(false);
    expect(result.pendingApproval).toBe(true);
    expect(result.approvalUrl).toBe("https://genesispay.test/dashboard/approvals");
    expect(() => result.bytes()).toThrow("is pending_approval, not settled");
  });

  it("MR-307: lateDeliveryUntil is kept only beside lateDeliveryPending === true", () => {
    const pending = new AgentPaymentResult({
      paymentId: "pay_1", status: "settled", payment, lateDeliveryPending: true, lateDeliveryUntil: UNTIL,
    });
    const stray = new AgentPaymentResult({
      paymentId: "pay_1", status: "settled", payment, lateDeliveryPending: false, lateDeliveryUntil: UNTIL,
    });
    const absent = new AgentPaymentResult({ paymentId: "pay_1", status: "settled", payment, lateDeliveryUntil: UNTIL });

    expect(pending).toMatchObject({ lateDeliveryPending: true, lateDeliveryUntil: UNTIL });
    // A deadline without the promise promises nothing.
    expect(stray).toMatchObject({ lateDeliveryPending: false, lateDeliveryUntil: null });
    expect(absent).toMatchObject({ lateDeliveryPending: false, lateDeliveryUntil: null });
  });

  it("bytes() returns the captured body byte-exact, including bytes that are not UTF-8", () => {
    const raw = new Uint8Array([0x00, 0x7f, 0x80, 0xc3, 0x28, 0xff, 0xfe]);
    const result = new AgentPaymentResult({ paymentId: "pay_1", status: "settled", payment, response: capture(raw) });

    expect(Array.from(result.bytes())).toEqual(Array.from(raw));
  });

  it("body() decodes UTF-8 and json() parses it", () => {
    const text = JSON.stringify({ city: "Zürich", forecast: "☀" });
    const result = new AgentPaymentResult({
      paymentId: "pay_1", status: "settled", payment, response: capture(new TextEncoder().encode(text)),
    });

    expect(result.body()).toBe(text);
    expect(result.json()).toEqual({ city: "Zürich", forecast: "☀" });
  });

  it("MR-307: a settled payment without a capture says to recover delivery, never to pay again", () => {
    const result = new AgentPaymentResult({ paymentId: "pay_1", status: "settled", payment, response: null });

    expect(() => result.json()).toThrow("do not create another payment");
  });
});
