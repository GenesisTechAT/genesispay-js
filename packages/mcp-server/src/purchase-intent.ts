import { createPurchaseIntent, GenesisPayPaymentRejectedError, type CreatePurchaseIntentInput } from "@genesis-tech/genesispay-agent";
import { z } from "zod";

export const PURCHASE_INTENT_TOOL_GUIDANCE =
  "For purchaseIntent, copy the user's exact approval sentence as approvalQuote and the visible purchase turns " +
  "verbatim as conversation (user/assistant only). maxTotal bounds the total including buyer fees. " +
  "The buyer can recompute the digest from these tool-call arguments in their own chat history. " +
  "Conversation text is hashed in this MCP process; only intent fields and the digest go to the payment API. " +
  "For a quote purchase also pass productId and quantity from genesispay_quote. " +
  "On every retry with the same idempotencyKey resend the identical purchaseIntent: the same conversation array " +
  "as the first call, without later turns (a changed conversation is a different purchase and is refused). " +
  "It does not replace server spending policy or owner approval.";

export const purchaseIntentToolSchema = z.strictObject({
  maxTotal: z.string().regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/),
  asset: z.enum(["USDC", "EURC"]).default("USDC"),
  approvalQuote: z.string().min(1).max(500),
  conversation: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(16_000),
  })).min(1).max(100).superRefine((messages, ctx) => {
    const bytes = messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).byteLength, 0);
    if (bytes > 128 * 1024) ctx.addIssue({ code: "custom", message: "Conversation content must be at most 128 KiB UTF-8" });
  }),
});

export type PurchaseIntentToolInput = z.infer<typeof purchaseIntentToolSchema>;

/** Local validation failures prove no request was sent; preserve that in MCP guidance. */
export function toolPurchaseIntent(item: CreatePurchaseIntentInput["item"], input?: PurchaseIntentToolInput) {
  if (!input) return null;
  try {
    return createPurchaseIntent({ item, ...input });
  } catch (error) {
    throw new GenesisPayPaymentRejectedError(error instanceof Error ? error.message : "Invalid purchase intent", {
      status: 0, code: "purchase_intent_invalid",
    });
  }
}
