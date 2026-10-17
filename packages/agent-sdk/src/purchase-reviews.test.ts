import { describe, expect, it } from "vitest";

import {
  preparedPurchaseReviewSchema,
  purchaseReviewsRequestSchema,
  reviewOpportunitySchema,
  reviewTargetSchema,
} from "./purchase-reviews.js";

// The wire contract of target-aware reviews (ADR-0091, ADR-0093). `client.test.ts`
// ("target-aware purchase reviews") proves the client binds the answer to the
// payment and service it asked about; this file proves what the schemas
// themselves accept and refuse.

const PAYMENT_ID = "01000000-0000-4000-8000-000000000001";
const draft = {
  reviewId: PAYMENT_ID,
  target: { kind: "external_service", serviceId: "ext_exa_search", title: "Exa" },
  pseudonym: "Buyer-123456789abc",
  state: "draft",
  version: 1,
  stars: 4,
  comment: "Useful",
  contentSha256: "a".repeat(64),
  draftExpiresAt: "2026-09-29T12:00:00Z",
  publishedAt: null,
  hidden: false,
  verifiedPurchase: true,
};

describe("purchaseReviewsRequestSchema", () => {
  it.each([
    ["a local product id", "prod_0kQkjzgoRSCRm3f3"],
    ["an external service id", "ext_exa_search"],
  ])("accepts %s and defaults the page size to 10", (_label, id) => {
    expect(purchaseReviewsRequestSchema.parse({ id })).toEqual({ id, limit: 10 });
  });

  it.each([
    ["an id of neither kind", { id: "lst_1234567890" }],
    ["a too-short product id", { id: "prod_short" }],
    ["an upper-case external id", { id: "ext_Exa_Search" }],
    ["a limit of 0", { id: "ext_exa_search", limit: 0 }],
    ["a limit over 50", { id: "ext_exa_search", limit: 51 }],
    ["a fractional limit", { id: "ext_exa_search", limit: 2.5 }],
    ["a cursor with URL syntax", { id: "ext_exa_search", cursor: "a&limit=50" }],
    ["an unknown key", { id: "ext_exa_search", productId: "prod_0kQkjzgoRSCRm3f3" }],
  ])("refuses %s before any request", (_label, input) => {
    expect(purchaseReviewsRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe("reviewTargetSchema", () => {
  it("reads both target kinds", () => {
    expect(reviewTargetSchema.parse({ kind: "local_product", productId: "prod_0kQkjzgoRSCRm3f3" }))
      .toEqual({ kind: "local_product", productId: "prod_0kQkjzgoRSCRm3f3" });
    expect(reviewTargetSchema.parse({ kind: "external_service", serviceId: "ext_exa_search" }))
      .toEqual({ kind: "external_service", serviceId: "ext_exa_search" });
  });

  it.each([
    ["an unknown kind", { kind: "seller", sellerId: "s_1" }],
    ["a local target without its product", { kind: "local_product", serviceId: "ext_exa_search" }],
    ["an external target with a malformed id", { kind: "external_service", serviceId: "exa" }],
  ])("refuses %s", (_label, target) => {
    expect(reviewTargetSchema.safeParse(target).success).toBe(false);
  });
});

describe("reviewOpportunitySchema", () => {
  const opportunity = {
    paymentId: PAYMENT_ID, state: "eligible", permission: "enabled",
    target: draft.target, promptKey: "f".repeat(64), nextAction: "ask_after_use",
  };

  it("reads an eligible opportunity and one with an existing draft", () => {
    expect(reviewOpportunitySchema.parse(opportunity)).toEqual(opportunity);
    const withDraft = { ...opportunity, state: "draft", permission: "required", nextAction: "ask_to_replace_draft", draft };
    expect(reviewOpportunitySchema.parse(withDraft)).toEqual(withDraft);
  });

  it.each([
    ["a payment id that is not a UUID", { paymentId: "pay_1" }],
    ["a state this SDK does not know", { state: "maybe" }],
    ["a prompt key that is not 64 hex characters", { promptKey: "F".repeat(64) }],
    ["an unknown next action", { nextAction: "publish_now" }],
  ])("refuses %s", (_label, overrides) => {
    expect(reviewOpportunitySchema.safeParse({ ...opportunity, ...overrides }).success).toBe(false);
  });
});

describe("preparedPurchaseReviewSchema", () => {
  it("names the target instead of a productId", () => {
    expect(preparedPurchaseReviewSchema.parse(draft)).toEqual(draft);
    expect(preparedPurchaseReviewSchema.safeParse({ ...draft, target: undefined }).success).toBe(false);
  });

  it("a draft is never already published or hidden", () => {
    expect(preparedPurchaseReviewSchema.safeParse({ ...draft, publishedAt: "2026-09-28T12:00:00Z" }).success).toBe(false);
    expect(preparedPurchaseReviewSchema.safeParse({ ...draft, hidden: true }).success).toBe(false);
  });
});
