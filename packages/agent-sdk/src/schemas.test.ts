import { describe, expect, it } from "vitest";

import {
  agentPaymentRecordSchema,
  parseDiscoveryEntry,
  storedResultResponseSchema,
  strictAgentPayResponseSchema,
} from "./schemas.js";

// The refinements these schemas own, proved on the schemas directly. The
// client-level cases in `client.test.ts` (discovery's MR-102 purchase-hint
// contradictions, the MR-1013 malformed-fee refusals, late delivery through
// pay()) are not repeated here.

const TX = `0x${"ab".repeat(32)}`;
const payment = {
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
  txHash: TX,
  failureReason: null,
  approvalExpiresAt: null,
  resolvedAt: "2026-10-06T12:00:00.000Z",
  settledAt: "2026-10-06T12:00:00.000Z",
  createdAt: "2026-10-06T11:59:59.000Z",
};

const envelope = {
  apiVersion: 2,
  idempotencyKey: "order-1",
  replayed: false,
  paymentId: payment.id,
  status: "settled",
  payment,
  txHash: TX,
  response: null,
  approvalUrl: null,
  statusUrl: `/api/v1/agent/payments/${payment.id}`,
};

describe("strictAgentPayResponseSchema", () => {
  it("reads an envelope that names one original payment", () => {
    expect(strictAgentPayResponseSchema.safeParse(envelope).success).toBe(true);
  });

  it.each([
    ["names another payment than its record", { paymentId: "pay_2" }],
    ["reports another status than its record", { status: "failed" }],
    ["reports another transaction than its record", { txHash: `0x${"cd".repeat(32)}` }],
    ["reports no transaction for a record that has one", { txHash: null }],
  ])("MR-306: an envelope that %s is never believed", (_label, overrides) => {
    expect(strictAgentPayResponseSchema.safeParse({ ...envelope, ...overrides }).success).toBe(false);
  });

  it("MR-307: a malformed late-delivery signal reads as absent instead of failing the pay call", () => {
    const parsed = strictAgentPayResponseSchema.parse({ ...envelope, lateDeliveryPending: "yes", lateDeliveryUntil: "soon" });
    expect(parsed.lateDeliveryPending).toBeUndefined();
    expect(parsed.lateDeliveryUntil).toBeUndefined();
  });
});

describe("agentPaymentRecordSchema", () => {
  it("a status this SDK predates still parses as its string", () => {
    expect(agentPaymentRecordSchema.parse({ ...payment, status: "refunded" }).status).toBe("refunded");
  });

  it.each([
    ["a leading zero", "05000"],
    ["a plus sign", "+5000"],
    ["an empty string", ""],
  ])("MR-1013: refuses a buyer fee with %s instead of reading it as no fee", (_label, buyerFeeMinor) => {
    expect(agentPaymentRecordSchema.safeParse({ ...payment, buyerFeeMinor }).success).toBe(false);
  });

  it("MR-1013: zero is a valid fee figure", () => {
    expect(agentPaymentRecordSchema.parse({ ...payment, buyerFeeMinor: "0", totalDebitMinor: "10000" }))
      .toMatchObject({ buyerFeeMinor: "0", totalDebitMinor: "10000" });
  });
});

describe("storedResultResponseSchema", () => {
  const response = {
    status: 200, mimeType: "application/json", kind: "json", body: "{}", bodyBytes: 2, bodySha256: "a".repeat(64),
  };
  const available = {
    paymentId: "pay_1", paymentStatus: "settled",
    result: { state: "available", capturedAt: "2026-10-06T12:00:00Z", expiresAt: "2026-10-13T12:00:00Z", response },
  };

  it("reads an available result with its response and retention times", () => {
    expect(storedResultResponseSchema.safeParse(available).success).toBe(true);
  });

  it.each([
    ["no response", { response: undefined }],
    ["no capture time", { capturedAt: undefined }],
    ["no expiry", { expiresAt: undefined }],
  ])("an available result with %s is refused", (_label, overrides) => {
    expect(storedResultResponseSchema.safeParse({ ...available, result: { ...available.result, ...overrides } }).success).toBe(false);
  });

  it.each(["expired", "unavailable"])("a %s result that still carries content is refused", (state) => {
    expect(storedResultResponseSchema.safeParse({ ...available, result: { state, response } }).success).toBe(false);
    expect(storedResultResponseSchema.safeParse({ ...available, result: { state } }).success).toBe(true);
  });

  it("a stored response is a 2xx: an error page is never presented as the purchased result", () => {
    const errorPage = { ...available, result: { ...available.result, response: { ...response, status: 500 } } };
    expect(storedResultResponseSchema.safeParse(errorPage).success).toBe(false);
  });
});

describe("parseDiscoveryEntry", () => {
  const quoteProduct = {
    id: "prod_0kQkjzgoRSCRm3f3", kind: "product", title: "Chewing gum", description: null, category: null,
    purchase: { mode: "quote", productId: "prod_0kQkjzgoRSCRm3f3", listedPriceUsdc: "0.01" },
  };

  it.each([null, "listing", 42, undefined])("drops a non-object entry (%s)", (entry) => {
    expect(parseDiscoveryEntry(entry)).toBeNull();
  });

  it("reads a quote-only product", () => {
    expect(parseDiscoveryEntry(quoteProduct)).toMatchObject({ id: quoteProduct.id, purchase: { mode: "quote" } });
  });

  it.each([
    ["a resourceUrl", { resourceUrl: "https://shop.example/checkout" }],
    ["a priceUsdc", { priceUsdc: "0.01" }],
    ["a method", { method: "GET" }],
  ])("ADR-0108: drops a quote-only product that also carries %s (something that looks payable)", (_label, extra) => {
    expect(parseDiscoveryEntry({ ...quoteProduct, ...extra })).toBeNull();
  });

  it("drops a quote product whose listed price is not a decimal", () => {
    expect(parseDiscoveryEntry({ ...quoteProduct, purchase: { ...quoteProduct.purchase, listedPriceUsdc: "1e3" } })).toBeNull();
  });
});
