import {
  digestPurchaseConversation,
  parsePurchaseIntent,
  type PurchaseConversationMessage,
  type PurchaseDigest,
  type PurchaseIntent,
} from "@genesis-tech/genesispay-protocol";

import { usdcDecimalToMinor } from "./commerce.js";

export type CreatePurchaseIntentInput = {
  item: { url: string } | { productId: string; quantity: number; shippingOptionId: string };
  /** Total debit including buyer fees, as an exact decimal with at most six places. */
  maxTotal: string;
  asset?: "USDC" | "EURC";
  approvalQuote: string;
} & (
  | { conversation: readonly PurchaseConversationMessage[]; conversationDigest?: never }
  | { conversationDigest: PurchaseDigest; conversation?: never }
);

/**
 * MR-101/MR-507: builds a refusal-only ceiling, hashing visible turns locally.
 * Conversation text is never included in the returned intent or sent by the SDK.
 * Checking that the verbatim quote occurs in a user turn is a client convenience,
 * not spending authority or proof of who wrote the conversation. Policy remains server-side.
 */
export function createPurchaseIntent(input: CreatePurchaseIntentInput): PurchaseIntent {
  if (typeof input.maxTotal !== "string" || !/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/.test(input.maxTotal)) {
    throw new Error("maxTotal must be an exact decimal string with at most six decimal places");
  }
  if ((input.conversation !== undefined) === (input.conversationDigest !== undefined)) {
    throw new Error("Provide exactly one of conversation or conversationDigest");
  }
  const conversationDigest = input.conversation !== undefined
    ? digestPurchaseConversation(input.conversation)
    : input.conversationDigest;
  if (input.conversation !== undefined && !input.conversation.some(
    (message) => message.role === "user" && message.content.includes(input.approvalQuote),
  )) {
    throw new Error("approvalQuote must appear verbatim in at least one user message");
  }
  const item = "url" in input.item
    ? { kind: "x402_resource", url: new URL(input.item.url).href }
    : { kind: "commerce_product", productId: input.item.productId, quantity: input.item.quantity,
      shippingOptionId: input.item.shippingOptionId };
  return parsePurchaseIntent({
    version: 1, item,
    maxTotal: { asset: input.asset ?? "USDC", amountMinor: usdcDecimalToMinor(input.maxTotal).toString() },
    delivery: item.kind === "commerce_product" ? { kind: "saved_shipping_profile" } : null,
    approvalQuote: input.approvalQuote, conversationDigest,
  });
}
