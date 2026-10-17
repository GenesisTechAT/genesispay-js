import { describe, expect, it, vi } from "vitest";
import { digestPurchaseConversation, parsePurchaseIntent } from "@genesis-tech/genesispay-protocol";

import { createPurchaseIntent, GenesisPayAgent, GenesisPayCommerceError, GenesisPayPaymentRejectedError,
  PURCHASE_INTENT_ERROR_CODES, type CreatePurchaseIntentInput, type PayOptions, type CommercePurchaseInput } from "./index.js";

const quote = "Buy this for at most 12.50 USDC.";
const conversation = [{ role: "assistant" as const, content: "A private purchase turn.  \n" },
  { role: "user" as const, content: quote }];
const input: CreatePurchaseIntentInput = { item: { url: "https://EXAMPLE.com:443/a/../report" },
  maxTotal: "12.50", approvalQuote: quote, conversation };
const commerceItem = { productId: "prod_12345678", quantity: 2, shippingOptionId: "flat_rate:1" };

function wire(status = 422, code = "purchase_intent_required") {
  const fetchFn = vi.fn(async () => Response.json({ error: "Refused", code }, { status }));
  return { fetchFn, agent: new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesispay.example", fetchFn }) };
}

describe("purchase intent (MR-101/MR-507)", () => {
  it("normalizes URLs, uses exact minor units and hashes only local verbatim turns", () => {
    const intent = createPurchaseIntent(input);
    expect(intent).toEqual({ version: 1, item: { kind: "x402_resource", url: "https://example.com/report" },
      maxTotal: { asset: "USDC", amountMinor: "12500000" }, delivery: null, approvalQuote: quote,
      conversationDigest: digestPurchaseConversation(conversation) });
    expect(JSON.stringify(intent)).not.toContain("private purchase turn");
    expect(createPurchaseIntent({ ...input, maxTotal: "0.000001", asset: "EURC" }).maxTotal)
      .toEqual({ asset: "EURC", amountMinor: "1" });
    expect(createPurchaseIntent({ ...input, maxTotal: "9223372036854.775807" }).maxTotal.amountMinor)
      .toBe("9223372036854775807");
  });

  it("builds saved-profile commerce intent or accepts a precomputed digest", () => {
    const intent = createPurchaseIntent({ ...input, item: commerceItem });
    expect(intent.item).toEqual({ kind: "commerce_product", ...commerceItem });
    expect(intent.delivery).toEqual({ kind: "saved_shipping_profile" });
    expect(createPurchaseIntent({ item: input.item, maxTotal: input.maxTotal, approvalQuote: quote,
      conversationDigest: digestPurchaseConversation(conversation) })).toEqual(createPurchaseIntent(input));
  });

  it.each(["0", "-1", "1.0000001", "1e3", " 1", "01.2", "9223372036854.775808"])("refuses invalid maximum %s", (maxTotal) => {
    expect(() => createPurchaseIntent({ ...input, maxTotal })).toThrow();
  });

  it("requires exactly one digest source and a verbatim approval in a user turn", () => {
    expect(() => createPurchaseIntent({ ...input, conversationDigest: digestPurchaseConversation(conversation) } as unknown as CreatePurchaseIntentInput))
      .toThrow("exactly one");
    expect(() => createPurchaseIntent({ ...input, conversation: undefined } as unknown as CreatePurchaseIntentInput)).toThrow("exactly one");
    expect(() => createPurchaseIntent({ ...input, conversation: [{ role: "user", content: "Different" }, { role: "assistant", content: quote }] }))
      .toThrow("verbatim");
    expect(() => createPurchaseIntent({ ...input, approvalQuote: "Buy\u200b this", conversation: [{ role: "user", content: "Buy\u200b this" }] })).toThrow("visible");
  });

  it.each(["pay", "purchase"] as const)("%s sends intent and only the conversation digest", async (method) => {
    const { agent, fetchFn } = wire();
    const intent = createPurchaseIntent({ ...input, ...(method === "purchase" ? { item: commerceItem } : {}) });
    const run = method === "pay" ? agent.pay("https://example.com/report", { idempotencyKey: "saved-key", purchaseIntent: intent })
      : agent.purchase({ quoteToken: "gp_cq_abc", shippingOptionId: commerceItem.shippingOptionId, idempotencyKey: "saved-key", purchaseIntent: intent });
    await expect(run).rejects.toThrow();
    const init = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0][1];
    const body = String(init.body);
    expect(JSON.parse(body).purchaseIntent).toEqual(intent);
    expect(body).toContain('"conversationDigest"');
    expect(body).not.toContain('"conversation"');
    expect(body).not.toContain("private purchase turn");
  });

  it("null is explicit in types, omitted on both wires, and malformed intent never sends", async () => {
    const { agent, fetchFn } = wire();
    await expect(agent.pay("https://example.com", { idempotencyKey: "key", purchaseIntent: null })).rejects.toThrow();
    await expect(agent.purchase({ quoteToken: "gp_cq_abc", shippingOptionId: "a", idempotencyKey: "key", purchaseIntent: null })).rejects.toThrow();
    for (const [, init] of fetchFn.mock.calls as unknown as [string, RequestInit][]) expect(JSON.parse(String(init.body))).not.toHaveProperty("purchaseIntent");
    fetchFn.mockClear();
    const bad = { ...createPurchaseIntent(input), conversation: conversation };
    await expect(agent.pay("https://example.com", { idempotencyKey: "key", purchaseIntent: bad })).rejects.toThrow("not allowed");
    await expect(agent.purchase({ quoteToken: "gp_cq_abc", shippingOptionId: "a", idempotencyKey: "key", purchaseIntent: bad })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    // @ts-expect-error 2.0 requires an explicit intent decision
    const payOptions: PayOptions = { idempotencyKey: "key" };
    // @ts-expect-error 2.0 requires an explicit intent decision
    const purchaseInput: CommercePurchaseInput = { quoteToken: "gp_cq_abc", shippingOptionId: "a", idempotencyKey: "key" };
    expect(payOptions).toBeDefined(); expect(purchaseInput).toBeDefined();
    expect(parsePurchaseIntent(createPurchaseIntent(input))).toEqual(createPurchaseIntent(input));
  });

  it.each(PURCHASE_INTENT_ERROR_CODES)("%s is a typed not-charged refusal on both routes", async (code) => {
    const status = code === "purchase_evidence_unavailable" ? 503 : code === "purchase_intent_invalid" ? 400 : 422;
    const { agent } = wire(status, code);
    await expect(agent.pay("https://example.com", { idempotencyKey: "key", purchaseIntent: null }))
      .rejects.toBeInstanceOf(GenesisPayPaymentRejectedError);
    await expect(agent.purchase({ quoteToken: "gp_cq_abc", shippingOptionId: "a", idempotencyKey: "key", purchaseIntent: null }))
      .rejects.toMatchObject({ name: GenesisPayCommerceError.name, code });
  });
});
