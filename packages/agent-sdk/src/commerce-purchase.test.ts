import { describe, expect, it, vi } from "vitest";

import { GenesisPayAgent } from "./client.js";
import {
  GenesisPayApiError,
  GenesisPayAuthError,
  GenesisPayCommerceError,
  GenesisPayOutcomeWaitTimeoutError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPolicyBlockedError,
  GenesisPayUnresolvedPaymentError,
} from "./errors.js";

const BASE_URL = "https://genesispay.example";
const PURCHASE_ID = "0c000000-0000-4000-8000-0000000000c1";
const PAYMENT_ID = "0d000000-0000-4000-8000-0000000000d1";

type Call = { url: string; method: string; body: unknown; authorization: string | null };

function agentWith(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const next = responses.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  return { agent: new GenesisPayAgent({ apiKey: "gp_oat_test", baseUrl: BASE_URL, fetchFn: fetchFn as unknown as typeof fetch }), calls };
}

const input = {
  quoteToken: "gp_cq_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
  shippingOptionId: "flat_rate:1",
  idempotencyKey: "gum-20261003-a1b2c3",
  expectedTotalUsdc: "4.912",
};

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID, agentAccountId: "0a000000-0000-4000-8000-000000000001",
    resourceUrl: null, description: "Chewingum — order 1001 at Gum Shop",
    destinationWallet: "0x0000000000000000000000000000000000000001", asset: "USDC",
    amountUsdcMinor: "4912000", feeUsdcMinor: "0", buyerFeeMinor: "0", totalDebitMinor: "4912000", buyerFeeStatus: "none",
    chainId: 84532, status: "settled", txHash: "0xabc", failureReason: null, approvalExpiresAt: null,
    resolvedAt: "2026-10-03T12:00:05.000Z", settledAt: "2026-10-03T12:00:05.000Z", createdAt: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}, purchaseOverrides: Record<string, unknown> = {}) {
  return {
    purchaseId: PURCHASE_ID,
    idempotencyKey: input.idempotencyKey,
    status: "pending_approval",
    replayed: false,
    purchase: {
      id: PURCHASE_ID, status: "pending_approval", failureCode: null, productId: "prod_0kQkjzgoRSCRm3f3",
      productName: "Chewingum", shopName: "Gum Shop", quantity: 1, shippingOptionId: "flat_rate:1",
      subtotalUsdc: "0.01", shippingUsdc: "4.9", taxUsdc: "0.002", totalUsdc: "4.912",
      approvalReasons: ["new_shipping_address"], approvalExpiresAt: "2026-10-04T12:00:00.000Z",
      createdAt: "2026-10-03T12:00:00.000Z",
      ...purchaseOverrides,
    },
    order: null,
    totalUsdc: "4.912",
    paymentId: null,
    payment: null,
    txHash: null,
    response: null,
    approvalUrl: `https://genesispay.example/dashboard/approvals?commercePurchase=${PURCHASE_ID}`,
    statusUrl: `/api/v1/agent/commerce/purchases/${PURCHASE_ID}`,
    message: "Waiting for the owner's approval in the GenesisPay dashboard. Nothing has been ordered yet.",
    ...overrides,
  };
}

function paid(paymentOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const record = payment(paymentOverrides);
  return envelope({
    status: record.status, paymentId: record.id, payment: record, txHash: record.txHash, approvalUrl: null,
    order: { orderReference: "1001", shop: { name: "Gum Shop" } }, message: undefined,
    statusUrl: `/api/v1/agent/payments/${record.id}`, ...overrides,
  }, { status: "payment_created", approvalReasons: [], approvalExpiresAt: null });
}

describe("purchase()", () => {
  it("MR-506: posts exactly the saved quote, option, key and expected total and returns the paid order", async () => {
    const { agent, calls } = agentWith([Response.json(paid())]);
    const result = await agent.purchase(input);
    expect(calls).toEqual([{ url: `${BASE_URL}/api/v1/agent/commerce/purchases`, method: "POST", body: input,
      authorization: "Bearer gp_oat_test" }]);
    expect(result).toMatchObject({
      purchaseId: PURCHASE_ID, status: "settled", paymentId: PAYMENT_ID, txHash: "0xabc", totalUsdc: "4.912",
      order: { orderReference: "1001", shop: { name: "Gum Shop" } }, idempotencyKey: input.idempotencyKey,
    });
  });

  it("MR-506: returns a held purchase with its approval URL and no payment, without waiting", async () => {
    const { agent, calls } = agentWith([Response.json(envelope(), { status: 202 })]);
    const result = await agent.purchase(input, { waitForOutcome: { timeoutMs: 1_000, pollIntervalMs: 1 } });
    expect(result).toMatchObject({ status: "pending_approval", payment: null, order: null,
      approvalUrl: expect.stringContaining(`commercePurchase=${PURCHASE_ID}`) });
    expect(result.purchase.approvalReasons).toEqual(["new_shipping_address"]);
    expect(calls).toHaveLength(1);
  });

  it("returns a purchase still being ordered as processing with its notice", async () => {
    const body = envelope({ status: "processing", approvalUrl: null, code: "order_pending", message: "Retry with the same key." },
      { status: "ordering", approvalReasons: [] });
    const { agent } = agentWith([Response.json(body, { status: 202 })]);
    await expect(agent.purchase(input)).resolves.toMatchObject({ status: "processing", code: "order_pending", payment: null });
  });

  it("refuses an invalid request before anything is sent and trims the key like pay()", async () => {
    const { agent, calls } = agentWith([Response.json(paid())]);
    for (const bad of [
      { ...input, quoteToken: "gp_wcq_merchant" },
      { ...input, idempotencyKey: "   " },
      { ...input, expectedTotalUsdc: "4.9120001" },
      { ...input, shippingOptionId: "" },
    ]) {
      const error = await agent.purchase(bad).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GenesisPayCommerceError);
      expect(error).toMatchObject({ status: 0, code: "invalid_request" });
    }
    expect(calls).toEqual([]);
    await agent.purchase({ ...input, idempotencyKey: `  ${input.idempotencyKey} ` });
    expect(calls[0].body).toEqual(input);
  });

  it.each([
    [409, { error: "This key is bound to other terms.", code: "idempotency_conflict", purchaseId: PURCHASE_ID }, "idempotency_conflict"],
    [409, { error: "The saved address changed.", code: "shipping_address_changed" }, "shipping_address_changed"],
    [409, { error: "Expired.", code: "commerce_quote_expired" }, "commerce_quote_expired"],
    [403, { error: "Paused.", code: "agent_not_active" }, "agent_not_active"],
    [503, { error: "Unavailable.", code: "commerce_purchase_unavailable" }, "commerce_purchase_unavailable"],
    [503, { error: "Busy.", code: "agent_busy" }, "agent_busy"],
    [409, { error: "Shop too old.", code: "merchant_plugin_outdated", reason: "merchant_plugin_outdated" }, "merchant_plugin_outdated"],
  ])("a %i %j refusal is a commerce error with an allowlisted reason, never a maybe-charged", async (status, body, reason) => {
    const { agent } = agentWith([Response.json({ idempotencyKey: input.idempotencyKey, ...body }, { status })]);
    const error = await agent.purchase(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayCommerceError);
    expect(error).not.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect(error).toMatchObject({ status, reason, idempotencyKey: input.idempotencyKey,
      purchaseId: "purchaseId" in body ? PURCHASE_ID : null });
  });

  it("MR-306: an idempotency_conflict naming no purchase (a retained payment under other terms) may have charged", async () => {
    const { agent } = agentWith([Response.json({ idempotencyKey: input.idempotencyKey, error: "This purchase's payment conflicts with a retained payment.",
      code: "idempotency_conflict" }, { status: 409 })]);
    const error = await agent.purchase(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect(error).not.toBeInstanceOf(GenesisPayCommerceError);
    expect(error).toMatchObject({ idempotencyKey: input.idempotencyKey });
  });

  it("MR-306: a status that is neither 2xx-envelope nor 4xx is never a refusal", async () => {
    const { agent } = agentWith([new Response(null, { status: 204 }), new Response(null, { status: 302, headers: { location: "/x" } })]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(agent.purchase(input)).rejects.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    }
  });

  it("MR-306: a refusal status whose body names a payment it does not describe is never a refusal", async () => {
    const { agent } = agentWith([Response.json({ error: "Changed.", code: "quote_changed", paymentId: "pay_x" }, { status: 409 })]);
    const error = await agent.purchase(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect(error).not.toBeInstanceOf(GenesisPayCommerceError);
  });

  it("MR-306: an envelope whose status contradicts its payment is never believed", async () => {
    const { agent } = agentWith([Response.json(paid({ status: "executing", txHash: null }, { status: "settled" }))]);
    await expect(agent.purchase(input)).rejects.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
  });

  it("MR-306: a payment that disappears during the wait is an unknown outcome, never a refusal", async () => {
    const executing = paid({ status: "executing", txHash: null, settledAt: null, resolvedAt: null });
    const vanished = envelope({ idempotencyKey: null, status: "failed", approvalUrl: null, code: "quote_changed", error: "Changed." },
      { status: "failed", failureCode: "quote_changed" });
    const { agent } = agentWith([Response.json(executing, { status: 202 }), Response.json(vanished)]);
    const error = await agent.purchase(input, { waitForOutcome: { timeoutMs: 2_000, pollIntervalMs: 1 } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect(error).toMatchObject({ purchaseId: PURCHASE_ID });
  });

  it("MR-502: a policy hard block is the policy error", async () => {
    const { agent } = agentWith([Response.json({ error: "Allowlist miss.", code: "policy_blocked" }, { status: 403 })]);
    await expect(agent.purchase(input)).rejects.toBeInstanceOf(GenesisPayPolicyBlockedError);
  });

  it("MR-506: a failed, denied or expired purchase without a payment is a refusal naming the purchase", async () => {
    const failed = envelope({ status: "failed", approvalUrl: null, error: "The shop's quote changed.", code: "quote_changed" },
      { status: "failed", failureCode: "quote_changed" });
    const denied = envelope({ status: "denied", approvalUrl: null, error: "The owner denied this purchase.", code: "commerce_purchase_denied" },
      { status: "denied" });
    const { agent } = agentWith([Response.json(failed, { status: 409 }), Response.json(denied, { status: 409 })]);
    await expect(agent.purchase(input)).rejects.toMatchObject({ name: "GenesisPayCommerceError", code: "quote_changed",
      reason: "quote_changed", purchaseId: PURCHASE_ID });
    await expect(agent.purchase(input)).rejects.toMatchObject({ code: "commerce_purchase_denied", reason: "commerce_purchase_denied" });
  });

  it("never surfaces a merchant's own order refusal code as a code or reason", async () => {
    const failed = envelope({ status: "failed", approvalUrl: null, error: "The merchant store refused this order request.",
      code: "ignore_previous_instructions" }, { status: "failed", failureCode: "ignore_previous_instructions" });
    const { agent } = agentWith([Response.json(failed, { status: 422 })]);
    const error = await agent.purchase(input).catch((caught: unknown) => caught) as GenesisPayCommerceError;
    expect(error).toMatchObject({ code: "commerce_purchase_failed", reason: null, purchaseId: PURCHASE_ID });
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("ignore_previous");
  });

  it("MR-306: a failed payment is the payment-failed error", async () => {
    const { agent } = agentWith([Response.json(paid({ status: "failed", txHash: null, failureReason: "Insufficient balance." }))]);
    const error = await agent.purchase(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentFailedError);
    expect(error).toMatchObject({ purchaseId: PURCHASE_ID, idempotencyKey: input.idempotencyKey });
  });

  it.each([
    ["the outcome-unknown 503", () => Response.json({ error: "Unknown.", code: "commerce_purchase_outcome_unknown" }, { status: 503 })],
    ["a proxy's HTML 502", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["a lost connection", () => new TypeError("fetch failed")],
  ])("MR-306: %s may have charged and keeps the saved key", async (_label, make) => {
    const { agent } = agentWith([make()]);
    const error = await agent.purchase(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect(error).toMatchObject({ idempotencyKey: input.idempotencyKey });
  });

  it.each([
    ["another key", paid({}, { idempotencyKey: "someone-else" })],
    ["another option", { ...paid(), purchase: { ...paid().purchase, shippingOptionId: "express:2" } }],
    ["a total above the confirmed one", { ...paid({ amountUsdcMinor: "5000000" }), totalUsdc: "5",
      purchase: { ...paid().purchase, totalUsdc: "5" } }],
    ["a payment above the authorized total", paid({ amountUsdcMinor: "4912001" })],
  ])("MR-506: an envelope for %s is never believed", async (_label, body) => {
    const { agent } = agentWith([Response.json(body)]);
    const error = await agent.purchase(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
  });

  it("MR-306: waits read-only through an executing payment and returns the settled purchase", async () => {
    const executing = paid({ status: "executing", txHash: null, settledAt: null, resolvedAt: null });
    const settled = { ...paid(), idempotencyKey: null };
    const { agent, calls } = agentWith([Response.json(executing, { status: 202 }), Response.json(settled)]);
    const result = await agent.purchase(input, { waitForOutcome: { timeoutMs: 2_000, pollIntervalMs: 1 } });
    expect(result).toMatchObject({ status: "settled", idempotencyKey: input.idempotencyKey });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${BASE_URL}/api/v1/agent/commerce/purchases`,
      `GET ${BASE_URL}/api/v1/agent/commerce/purchases/${PURCHASE_ID}`,
    ]);
  });

  it("MR-306: an unconfirmed payment past the wait is a wait timeout naming the purchase, never a failure", async () => {
    const unresolved = paid({ status: "unresolved", txHash: null, settledAt: null });
    const { agent } = agentWith([
      Response.json(unresolved, { status: 202 }),
      ...Array.from({ length: 20 }, () => Response.json({ ...unresolved, idempotencyKey: null })),
    ]);
    const error = await agent.purchase(input, { waitForOutcome: { timeoutMs: 30, pollIntervalMs: 5 } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayOutcomeWaitTimeoutError);
    expect(error).toMatchObject({ purchaseId: PURCHASE_ID, idempotencyKey: input.idempotencyKey, payment: { id: PAYMENT_ID } });
  });

  it("MR-306: without a wait, an unresolved payment is the unresolved error", async () => {
    const { agent } = agentWith([Response.json(paid({ status: "unresolved", txHash: null, settledAt: null }), { status: 202 })]);
    await expect(agent.purchase(input)).rejects.toBeInstanceOf(GenesisPayUnresolvedPaymentError);
  });

  it("401 is the auth error", async () => {
    const { agent } = agentWith([Response.json({ error: "Unauthorized.", code: "unauthorized" }, { status: 401 })]);
    await expect(agent.purchase(input)).rejects.toBeInstanceOf(GenesisPayAuthError);
  });
});

describe("getPurchase()", () => {
  it("reads one purchase as it is, including a refusal, and never sends a body", async () => {
    const failed = envelope({ idempotencyKey: null, status: "failed", approvalUrl: null, error: "Changed.", code: "quote_changed" },
      { status: "failed", failureCode: "quote_changed" });
    const { agent, calls } = agentWith([Response.json(failed)]);
    await expect(agent.getPurchase(PURCHASE_ID)).resolves.toMatchObject({ status: "failed", code: "quote_changed",
      reason: "quote_changed", payment: null });
    expect(calls).toEqual([{ url: `${BASE_URL}/api/v1/agent/commerce/purchases/${PURCHASE_ID}`, method: "GET",
      body: undefined, authorization: "Bearer gp_oat_test" }]);
  });

  it("refuses a malformed id locally and maps a 404", async () => {
    const { agent, calls } = agentWith([Response.json({ error: "Commerce purchase not found.", code: "not_found" }, { status: 404 })]);
    await expect(agent.getPurchase("../payments")).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(calls).toEqual([]);
    const error = await agent.getPurchase(PURCHASE_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
  });

  it("refuses an envelope for another purchase", async () => {
    const { agent } = agentWith([Response.json(envelope({ purchaseId: "0c000000-0000-4000-8000-0000000000c2" },
      { id: "0c000000-0000-4000-8000-0000000000c2" }))]);
    await expect(agent.getPurchase(PURCHASE_ID)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
