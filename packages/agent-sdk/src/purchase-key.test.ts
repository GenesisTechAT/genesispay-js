import { describe, expect, it, vi } from "vitest";

import { GenesisPayAgent } from "./client.js";
import {
  GenesisPayApiError,
  GenesisPayAuthError,
  GenesisPayCommerceError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
} from "./errors.js";
import { isIssuedPurchaseKey, isPurchaseKeyErrorCode, PURCHASE_KEY_ERROR_CODES } from "./purchase-key.js";

const BASE_URL = "https://genesispay.example";
const ISSUED_KEY = "gpk1_mg9x2k1c_q8Zr1Ck0sJw3mXbV7tYp2A_Yh3kLm9QwErTyUiOp4AsDfg";
const EXPIRES_AT = "2026-10-04T10:00:00.000Z";

type Call = { url: string; method: string; body: unknown; authorization: string | null };

function agentWith(responses: Response[]) {
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
    return next;
  });
  return { agent: new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: BASE_URL, fetchFn: fetchFn as unknown as typeof fetch }), calls };
}

function settledV2(idempotencyKey: string) {
  const payment = {
    id: "pay_1", agentAccountId: "acct_1", resourceUrl: "https://api.example.com/premium", description: null,
    destinationWallet: "0x1111111111111111111111111111111111111111", amountUsdcMinor: "5000", feeUsdcMinor: "0",
    chainId: 84532, status: "settled", txHash: `0x${"ab".repeat(32)}`, failureReason: null, approvalExpiresAt: null,
    resolvedAt: null, settledAt: "2026-10-03T10:00:01.000Z", createdAt: "2026-10-03T10:00:00.000Z",
  };
  return {
    apiVersion: 2, idempotencyKey, replayed: false, paymentId: payment.id, status: "settled", payment,
    txHash: payment.txHash, approvalUrl: null, statusUrl: `/api/v1/agent/payments/${payment.id}`,
    response: { status: 200, headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from("{}").toString("base64"), mimeType: "application/json" },
  };
}

const quotePurchase = {
  quoteToken: "gp_cq_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
  shippingOptionId: "flat_rate:1",
  idempotencyKey: ISSUED_KEY,
  expectedTotalUsdc: "4.912",
};

describe("createPurchaseKey()", () => {
  it("MR-307: asks GenesisPay for an issued key with one authenticated POST and no input", async () => {
    const { agent, calls } = agentWith([Response.json({ apiVersion: 2, purchaseKey: ISSUED_KEY, expiresAt: EXPIRES_AT })]);
    await expect(agent.createPurchaseKey()).resolves.toEqual({ purchaseKey: ISSUED_KEY, expiresAt: EXPIRES_AT });
    expect(calls).toEqual([{ url: `${BASE_URL}/api/v2/agent/purchase-keys`, method: "POST", body: undefined,
      authorization: "Bearer gp_ag_test" }]);
  });

  it("MR-307: refuses a key that is not GenesisPay's or would not fit both purchase forms", async () => {
    for (const purchaseKey of ["forecast-20261003-k7q2xm", `gpk1_${"a".repeat(200)}`, "gpk1_with space"]) {
      const { agent } = agentWith([Response.json({ apiVersion: 2, purchaseKey, expiresAt: EXPIRES_AT })]);
      await expect(agent.createPurchaseKey()).rejects.toMatchObject({ code: "invalid_response" });
    }
    const { agent } = agentWith([Response.json({ apiVersion: 1, purchaseKey: ISSUED_KEY, expiresAt: EXPIRES_AT })]);
    await expect(agent.createPurchaseKey()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps 401, 429 and a deployment without the route to typed errors", async () => {
    const unauthorized = agentWith([Response.json({ error: "Unauthorized.", code: "unauthorized" }, { status: 401 })]);
    await expect(unauthorized.agent.createPurchaseKey()).rejects.toBeInstanceOf(GenesisPayAuthError);

    const limited = agentWith([Response.json({ error: "Too many requests.", code: "rate_limited" }, { status: 429 })]);
    await expect(limited.agent.createPurchaseKey()).rejects.toMatchObject({ status: 429, code: "rate_limited" });

    const older = agentWith([new Response("<html>Not Found</html>", { status: 404 })]);
    const error = await older.agent.createPurchaseKey().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect(error).toMatchObject({ status: 404, code: "purchase_keys_unavailable" });
  });
});

describe("requireIssuedKey", () => {
  it("MR-307: pay() with a free-form key and no flag sends the pre-1.7 request unchanged", async () => {
    const { agent, calls } = agentWith([Response.json(settledV2("forecast-20261003-k7q2xm"))]);
    await agent.pay("https://api.example.com/premium", { idempotencyKey: "forecast-20261003-k7q2xm", requireIssuedKey: false });
    expect(calls[0].body).toEqual({ url: "https://api.example.com/premium", idempotencyKey: "forecast-20261003-k7q2xm" });
  });

  it("MR-307: pay() sends requireIssuedKey only when true, beside the unchanged terms", async () => {
    const { agent, calls } = agentWith([Response.json(settledV2(ISSUED_KEY))]);
    const result = await agent.pay("https://api.example.com/premium", { idempotencyKey: ISSUED_KEY, maxAmountUsdc: "0.01",
      requireIssuedKey: true });
    expect(result.settled).toBe(true);
    expect(calls[0].body).toEqual({ url: "https://api.example.com/premium", idempotencyKey: ISSUED_KEY,
      maxAmountUsdc: "0.01", requireIssuedKey: true });
  });

  it("MR-307: purchase() sends requireIssuedKey only when true", async () => {
    const refusal = () => Response.json({ error: "Get a purchase key.", code: "purchase_key_required" }, { status: 400 });
    const { agent, calls } = agentWith([refusal(), refusal()]);
    await agent.purchase(quotePurchase, { requireIssuedKey: true }).catch(() => undefined);
    await agent.purchase(quotePurchase).catch(() => undefined);
    expect(calls[0].body).toEqual({ ...quotePurchase, requireIssuedKey: true });
    expect(calls[1].body).toEqual(quotePurchase);
  });

  it.each(PURCHASE_KEY_ERROR_CODES)("MR-307: pay() types a 400 %s as rejected before anything was signed", async (code) => {
    const { agent } = agentWith([Response.json({ error: "Refused purchase key.", code }, { status: 400 })]);
    const error = await agent.pay("https://api.example.com/premium", { idempotencyKey: ISSUED_KEY, requireIssuedKey: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentRejectedError);
    expect(error).toMatchObject({ status: 400, code, idempotencyKey: ISSUED_KEY });
  });

  it.each(PURCHASE_KEY_ERROR_CODES)("MR-307: purchase() keeps the 400 %s code on a no-charge refusal", async (code) => {
    const { agent } = agentWith([Response.json({ error: "Refused purchase key.", code }, { status: 400 })]);
    const error = await agent.purchase(quotePurchase, { requireIssuedKey: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayCommerceError);
    expect(error).toMatchObject({ status: 400, code, reason: null, idempotencyKey: ISSUED_KEY });
  });
});

describe("purchase keys unavailable (503)", () => {
  const keyUnavailable = () => Response.json(
    { error: "Purchase keys cannot be verified right now. Nothing was charged. Retry later with the same key.", code: "purchase_key_unavailable" },
    { status: 503 });

  it("MR-307: pay() types admission's dedicated 503 purchase_key_unavailable as rejected before signing", async () => {
    const { agent } = agentWith([keyUnavailable()]);
    const error = await agent.pay("https://api.example.com/premium", { idempotencyKey: ISSUED_KEY, requireIssuedKey: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentRejectedError);
    expect(error).toMatchObject({ status: 503, code: "purchase_key_unavailable", idempotencyKey: ISSUED_KEY });
  });

  it("MR-306: pay() keeps a bare 503 service_unavailable an unknown outcome, even with requireIssuedKey", async () => {
    const { agent } = agentWith([Response.json({ error: "Unavailable.", code: "service_unavailable" }, { status: 503 })]);
    const error = await agent.pay("https://api.example.com/premium", { idempotencyKey: ISSUED_KEY, requireIssuedKey: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
  });

  it("MR-307: purchase() keeps admission's purchase_key_unavailable as a no-charge refusal", async () => {
    const { agent } = agentWith([keyUnavailable()]);
    const error = await agent.purchase(quotePurchase, { requireIssuedKey: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayCommerceError);
    expect(error).toMatchObject({ status: 503, code: "purchase_key_unavailable" });
  });

  it("createPurchaseKey() surfaces the mint's 503 with its code", async () => {
    const { agent } = agentWith([Response.json({ error: "Purchase keys cannot be issued right now. Retry later.",
      code: "service_unavailable" }, { status: 503 })]);
    await expect(agent.createPurchaseKey()).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
  });
});

describe("purchase key helpers", () => {
  it("tells an issued key and a purchase-key code apart", () => {
    expect(isIssuedPurchaseKey(ISSUED_KEY)).toBe(true);
    expect(isIssuedPurchaseKey("forecast-20261003-k7q2xm")).toBe(false);
    expect(isPurchaseKeyErrorCode("purchase_key_expired")).toBe(true);
    expect(isPurchaseKeyErrorCode("idempotency_conflict")).toBe(false);
    expect(isPurchaseKeyErrorCode(null)).toBe(false);
  });
});
