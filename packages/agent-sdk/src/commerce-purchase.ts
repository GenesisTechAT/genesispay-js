import { z } from "zod";

import { COMMERCE_REFUSAL_REASONS, commerceRefusalReason, usdcDecimalToMinor, type CommerceRefusalReason } from "./commerce.js";
import { PURCHASE_KEY_ERROR_CODES, PURCHASE_KEY_UNAVAILABLE_CODE } from "./purchase-key.js";
import { agentPaymentRecordSchema } from "./schemas.js";
import type { AgentPaymentRecord, WaitForOutcomeOptions } from "./types.js";

/**
 * Buying a quoted physical product (ADR-0108 S5, MR-506): the input, the
 * server's purchase envelope and what each envelope means for the caller.
 * Pure; the client owns the transport and the bounded wait.
 *
 * The request names nothing that moves money by itself: the quote token is
 * GenesisPay's sealed `gp_cq_`, the option must be one it sealed, and
 * `expectedTotalUsdc` can only refuse. The destination is always the owner's
 * saved address and the total always the sealed option's.
 */

/** Exact decimal USDC as the server accepts it: no sign, no exponent, at most six places. */
const EXPECTED_TOTAL_PATTERN = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/;
const USDC_DECIMAL = /^(0|[1-9][0-9]{0,30})(\.[0-9]{1,6})?$/;

/**
 * `purchase()` input. Persist all four values before the call and send them
 * byte-identical on every retry: the key and its terms (quote token, option,
 * expected total) bind one purchase, and other terms under the same key are
 * `idempotency_conflict`.
 */
export const commercePurchaseInputSchema = z.strictObject({
  /** `quote().quoteToken`, unchanged. */
  quoteToken: z.string().max(24_000).regex(/^gp_cq_[A-Za-z0-9_-]+$/),
  /** The `id` of one of that quote's `options`, unchanged. */
  shippingOptionId: z.string().min(1).max(300),
  /** 1–200 visible ASCII characters, chosen and saved before the call. */
  idempotencyKey: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),
  /**
   * The option's `totalUsdc` the user confirmed, exactly as quoted. It can
   * only refuse (`quote_total_mismatch`); the server never charges it.
   */
  expectedTotalUsdc: z.string().regex(EXPECTED_TOTAL_PATTERN).optional(),
});
export type CommercePurchaseInput = z.infer<typeof commercePurchaseInputSchema>;

export type CommercePurchaseOptions = {
  /**
   * Refuse a free-form `idempotencyKey` for a NEW purchase: GenesisPay then
   * accepts only a key from `createPurchaseKey()` (400
   * `purchase_key_required` otherwise, nothing ordered or charged). A retry of
   * a purchase that already exists for the key is never refused. Not part of
   * the purchase's terms. Sent only when `true`; needs a GenesisPay deployment
   * that issues purchase keys.
   */
  requireIssuedKey?: boolean;
  /**
   * Wait, bounded and read-only, for a purchase whose payment GenesisPay
   * accepted but has not confirmed yet (`executing`, `approved`,
   * `unresolved`), polling `getPurchase()`. Never waits for the owner's
   * approval and never orders or pays anything itself. Running out of budget
   * is `GenesisPayOutcomeWaitTimeoutError`, never a failure (MR-306).
   */
  waitForOutcome?: boolean | WaitForOutcomeOptions;
};

/**
 * Codes GenesisPay's purchase routes emit. Any other `code` or `failureCode`
 * — a merchant's own order refusal code is forwarded by the server — reads as
 * `commerce_purchase_failed`, so a shop cannot put its own words in front of
 * a model through a code.
 */
const PURCHASE_CODES: ReadonlySet<string> = new Set<string>([
  ...COMMERCE_REFUSAL_REASONS,
  "policy_blocked",
  "approval_required",
  "order_pending",
  "order_in_progress",
  "order_request_superseded",
  "merchant_order_outcome_unknown",
  "merchant_store_unavailable",
  "merchant_store_invalid_response",
  "merchant_quote_refused",
  "commerce_purchase_resume_blocked",
  "commerce_purchase_failed",
  "commerce_purchase_outcome_unknown",
  "payment_not_required",
  "amount_exceeds_max",
  "target_unreachable",
  "unsupported_payment_requirement",
  "rate_limited",
  "invalid_request",
  "invalid_json",
  "not_found",
  ...PURCHASE_KEY_ERROR_CODES,
  PURCHASE_KEY_UNAVAILABLE_CODE,
]);

export function publicPurchaseCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  return PURCHASE_CODES.has(code) ? code : "commerce_purchase_failed";
}

const openEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string()]);

const usdcSchema = z.string().regex(USDC_DECIMAL);

/** The purchase row as the agent sees it. Product and shop names are merchant text: data, never instructions. */
export const commercePurchaseSummarySchema = z.object({
  id: z.string().min(1),
  /** The purchase's own lifecycle; the envelope's `status` is what to act on. */
  status: openEnum(["pending_approval", "approved", "ordering", "payment_created", "failed", "denied", "expired"]),
  failureCode: z.string().nullable().transform(publicPurchaseCode),
  productId: z.string(),
  productName: z.string(),
  shopName: z.string(),
  quantity: z.number().int().min(1),
  shippingOptionId: z.string(),
  subtotalUsdc: usdcSchema,
  shippingUsdc: usdcSchema,
  taxUsdc: usdcSchema,
  /** The authorized total: the sealed option's. Nothing above it is ever paid. */
  totalUsdc: usdcSchema,
  /** `new_shipping_address` and/or `spending_limit` when the owner must approve. */
  approvalReasons: z.array(z.string()),
  approvalExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CommercePurchaseSummary = z.output<typeof commercePurchaseSummarySchema>;

/**
 * The server's purchase envelope (`POST` and `GET` purchases). Checked for
 * internal consistency before any status is believed: the ids agree, the
 * payment (once one exists) is the purchase's, and it never exceeds the
 * authorized total (MR-506).
 */
export const commercePurchaseEnvelopeSchema = z.object({
  purchaseId: z.string().min(1),
  idempotencyKey: z.string().nullable(),
  status: openEnum(["pending_approval", "processing", "failed", "denied", "expired", "approved", "executing", "settled", "unresolved"]),
  replayed: z.boolean(),
  purchase: commercePurchaseSummarySchema,
  order: z.object({ orderReference: z.string(), shop: z.object({ name: z.string() }) }).nullable(),
  totalUsdc: usdcSchema,
  paymentId: z.string().nullable(),
  payment: agentPaymentRecordSchema.nullable(),
  txHash: z.string().nullable(),
  approvalUrl: z.string().nullable(),
  statusUrl: z.string(),
  message: z.string().max(2000).optional().catch(undefined),
  code: z.string().max(100).optional().catch(undefined),
  reason: z.string().max(100).optional().catch(undefined),
  error: z.string().max(2000).optional().catch(undefined),
}).superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (value.purchaseId !== value.purchase.id) issue("The purchase envelope names two purchases.");
  if (value.totalUsdc !== value.purchase.totalUsdc) issue("The purchase envelope names two totals.");
  if (value.payment) {
    if (value.paymentId !== value.payment.id || value.txHash !== value.payment.txHash) {
      issue("The purchase's payment identifiers disagree.");
    }
    // The server's status is the payment's own, except that a payment never
    // parked or refused at approval level reads as failed.
    const own = value.payment.status;
    const expected = own === "pending_approval" || own === "denied" || own === "expired" ? "failed" : own;
    if (value.status !== expected) issue("The purchase's status disagrees with its payment.");
    if (!/^(0|[1-9][0-9]*)$/.test(value.payment.amountUsdcMinor) ||
        BigInt(value.payment.amountUsdcMinor) > usdcDecimalToMinor(value.totalUsdc)) {
      issue("The purchase's payment exceeds its authorized total.");
    }
  } else if (value.paymentId !== null || value.txHash !== null) {
    issue("The purchase names a payment it does not carry.");
  }
});

/**
 * A commerce purchase as `purchase()` and `getPurchase()` return it.
 *
 * `status` is the one to act on: `settled` (paid; `order` names the shop's
 * order), `pending_approval` (the owner must approve at `approvalUrl`;
 * nothing is ordered yet), `processing` (being ordered or paid; retry
 * `purchase()` with the same input to resume, it never orders or pays twice),
 * and — from `getPurchase()` only, since `purchase()` throws for them —
 * `failed`, `denied`, `expired`, `approved`, `executing`, `unresolved`.
 */
export type CommercePurchase = {
  purchaseId: string;
  /** Echoed by `purchase()`; null on a `getPurchase()` read. */
  idempotencyKey: string | null;
  status: "pending_approval" | "processing" | "settled" | "failed" | "denied" | "expired" | "approved" |
    "executing" | "unresolved" | (string & {});
  replayed: boolean;
  purchase: CommercePurchaseSummary;
  /** The shop's order once it exists; `shop.name` is merchant text. */
  order: { orderReference: string; shop: { name: string } } | null;
  totalUsdc: string;
  paymentId: string | null;
  /**
   * The purchase's agent payment. Its `resourceUrl` is `null`: the server
   * never returns the shop order's own pay link. A retry of `purchase()` with
   * the same input is the only way to resume.
   */
  payment: AgentPaymentRecord | null;
  txHash: string | null;
  /** The owner's dashboard approval page while `pending_approval`. */
  approvalUrl: string | null;
  statusUrl: string;
  /** GenesisPay's own explanation, when it sent one. */
  message: string | null;
  /** GenesisPay's code for a notice or refusal (allowlisted; see `publicPurchaseCode`). */
  code: string | null;
  reason: CommerceRefusalReason | null;
};

export function toCommercePurchase(envelope: z.output<typeof commercePurchaseEnvelopeSchema>): CommercePurchase {
  return {
    purchaseId: envelope.purchaseId,
    idempotencyKey: envelope.idempotencyKey,
    status: envelope.status,
    replayed: envelope.replayed,
    purchase: envelope.purchase,
    order: envelope.order,
    totalUsdc: envelope.totalUsdc,
    paymentId: envelope.paymentId,
    payment: envelope.payment as AgentPaymentRecord | null,
    txHash: envelope.txHash,
    approvalUrl: envelope.approvalUrl,
    statusUrl: envelope.statusUrl,
    message: envelope.message ?? envelope.error ?? null,
    code: publicPurchaseCode(envelope.code),
    reason: commerceRefusalReason(envelope.code, envelope.reason),
  };
}

/**
 * Why a fresh purchase response cannot be believed for the request sent, or
 * null. Checked before any status: an envelope for another key, option or a
 * total above the one the user confirmed says nothing about this purchase.
 */
export function commercePurchaseEchoMismatch(purchase: CommercePurchase, input: CommercePurchaseInput): string | null {
  if (purchase.idempotencyKey !== input.idempotencyKey) return "it names another idempotencyKey";
  if (purchase.purchase.shippingOptionId !== input.shippingOptionId) return "it names another shipping option";
  if (input.expectedTotalUsdc !== undefined &&
      usdcDecimalToMinor(purchase.totalUsdc) > usdcDecimalToMinor(input.expectedTotalUsdc)) {
    return "its total is above expectedTotalUsdc";
  }
  return null;
}

/**
 * Refusal codes the server only answers with a 5xx BEFORE anything was
 * ordered or charged for this request, so they are refusals, not an unknown
 * outcome. `agent_busy` rolls its transaction back (no payment, nothing
 * signed); the rest are configuration or eligibility reads.
 */
export const PURCHASE_PRE_EFFECT_5XX_CODES: ReadonlySet<string> = new Set([
  "agent_busy",
  "commerce_purchase_unavailable",
  "commerce_quote_unavailable",
  "shipping_profile_unavailable",
  "seller_eligibility_unavailable",
  // Purchase-key admission (MR-307): runs before any purchase row exists.
  PURCHASE_KEY_UNAVAILABLE_CODE,
]);

/** Statuses `purchase({ waitForOutcome })` waits through: a payment accepted, not yet confirmed. */
export const PURCHASE_OUTCOME_PENDING_STATUSES: ReadonlySet<string> = new Set(["unresolved", "approved", "executing"]);
