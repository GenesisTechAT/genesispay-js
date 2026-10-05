import { z } from "zod";

/**
 * Physical commerce through the agent API (ADR-0108): the owner's saved
 * shipping profile and the read-only, address-bound merchant quote. Nothing
 * here orders, signs or pays; the purchase that spends a quote is a separate
 * call.
 *
 * The server stays the authority on every field: the input schemas below are
 * structural guards (lengths, shapes) so a call that cannot succeed is refused
 * before it is sent, and the server's country-aware address rules still apply.
 */

/** A WooCommerce product as GenesisPay Discovery names it (`prod_…`). */
export const commerceProductIdSchema = z.string().regex(/^prod_[A-Za-z0-9_-]{8,187}$/);

/** `quote()` input: the product and how many. There is no destination field. */
export const commerceQuoteInputSchema = z.strictObject({
  productId: commerceProductIdSchema,
  quantity: z.number().int().min(1).max(20),
});
export type CommerceQuoteInput = z.infer<typeof commerceQuoteInputSchema>;

/**
 * The saved shipping profile as an agent writes it (`setShippingProfile()`).
 * An omitted `email` means "use the owner's account email". Field limits are
 * the merchant destination's, so a profile that saves is one a merchant order
 * accepts.
 */
export const shippingProfileInputSchema = z.strictObject({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().max(254).optional()
    .describe("Recipient email for delivery updates; omit to use the account owner's email."),
  phone: z.string().trim().max(50).optional(),
  address: z.strictObject({
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)
      .describe('ISO 3166-1 alpha-2 country code in upper case, e.g. "AT".'),
    state: z.string().trim().max(100).optional()
      .describe("State, province or region, where the country uses one."),
    postalCode: z.string().trim().min(1).max(32),
    city: z.string().trim().min(1).max(100),
    line1: z.string().trim().min(1).max(200).describe("Street and house number."),
    line2: z.string().trim().max(200).optional().describe("Apartment, floor or c/o, if any."),
  }),
});
export type ShippingProfileInput = z.infer<typeof shippingProfileInputSchema>;

/**
 * Refusal reasons a caller may branch on (`GenesisPayCommerceError.reason`).
 * The first group is the merchant plugin's fixed quote refusals plus
 * GenesisPay's own minimum-plugin refusal; the second is GenesisPay's own
 * commerce refusals; the third is the purchase step's (`purchase()`), each of
 * which the server raises only when no payment exists. Closed on purpose: a
 * value outside this list is never surfaced as a reason, so a merchant cannot
 * inject its own text.
 */
export const COMMERCE_REFUSAL_REASONS = [
  "shipping_unavailable",
  "insufficient_stock",
  "product_unavailable",
  "unsupported_product_type",
  "unsupported_shipping_packages",
  "backorders_not_supported",
  "quote_unavailable",
  "unsupported_currency",
  "merchant_plugin_outdated",
  "shipping_profile_missing",
  "shipping_profile_unavailable",
  "commerce_quote_unavailable",
  "storefront_product_not_found",
  "email_required",
  "agent_not_active",
  // purchase()
  "idempotency_conflict",
  "commerce_purchase_unavailable",
  "commerce_quote_invalid",
  "commerce_quote_expired",
  "commerce_quote_already_used",
  "shipping_option_not_quoted",
  "quote_total_mismatch",
  "shipping_address_changed",
  "quote_changed",
  "merchant_connection_changed",
  "merchant_network_mismatch",
  "seller_unavailable",
  "seller_payments_frozen",
  "seller_eligibility_required",
  "seller_eligibility_unavailable",
  "merchant_order_refused",
  "commerce_purchase_denied",
  "approval_expired",
  "commerce_authorization_lapsed",
  "order_payment_unavailable",
  "commerce_dispatch_invalid",
  "agent_busy",
] as const;
export type CommerceRefusalReason = (typeof COMMERCE_REFUSAL_REASONS)[number];

const REFUSAL_REASONS: ReadonlySet<string> = new Set(COMMERCE_REFUSAL_REASONS);

/** The allowlisted reason of a refusal body: its `reason` first, else its `code`. */
export function commerceRefusalReason(code: unknown, reason: unknown): CommerceRefusalReason | null {
  if (typeof reason === "string" && REFUSAL_REASONS.has(reason)) return reason as CommerceRefusalReason;
  if (typeof code === "string" && REFUSAL_REASONS.has(code)) return code as CommerceRefusalReason;
  return null;
}

/**
 * Open like the payment status: a value the server adds later still parses,
 * and every caller treats anything but the known "good" value conservatively.
 */
const openEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string()]);

export const agentShippingProfileSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  /** `m…@example.com`; the full email is never returned to an agent. */
  emailMasked: z.string().nullable(),
  /** True when no email is saved and the owner's account email is used. */
  emailIsAccountDefault: z.boolean(),
  /** `…67`, or null when none is saved. */
  phoneMasked: z.string().nullable(),
  address: z.object({
    country: z.string(),
    state: z.string().nullable(),
    postalCode: z.string(),
    city: z.string(),
    line1: z.string(),
    line2: z.string().nullable(),
  }),
});
export type AgentShippingProfile = z.infer<typeof agentShippingProfileSchema>;

const profileStatusSchema = openEnum(["confirmed", "unconfirmed"]);

const savedProfileFields = {
  shippingProfile: agentShippingProfileSchema,
  /** `confirmed` only when the owner confirmed this exact name and address. */
  status: profileStatusSchema,
  setBy: openEnum(["owner_web", "agent"]),
  updatedAt: z.iso.datetime({ offset: true }),
};

/** `GET /api/v1/agent/shipping-profile`. */
export const shippingProfileReadSchema = z.union([
  z.object({ shippingProfile: z.null(), instructions: z.string().nullish().transform((value) => value ?? null) }),
  z.object(savedProfileFields),
]);
export type ShippingProfileRead = z.infer<typeof shippingProfileReadSchema>;

/**
 * `PUT /api/v1/agent/shipping-profile`. `confirmationRequired` never reads
 * false for an address that is not `confirmed`: an inconsistent answer is
 * taken as the cautious one (the first order to it needs the owner's approval).
 */
export const shippingProfileWriteSchema = z.object({
  ...savedProfileFields,
  confirmationRequired: z.boolean(),
  instructions: z.string().nullish().transform((value) => value ?? null),
}).transform((value) => ({ ...value, confirmationRequired: value.confirmationRequired || value.status !== "confirmed" }));
export type ShippingProfileWrite = z.infer<typeof shippingProfileWriteSchema>;

/** Exact decimal USDC, at most six places, as the server renders minor units. */
const usdcDecimalSchema = z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,6})?$/);

/** "12.5" ⇒ 12_500_000n. Only for strings `usdcDecimalSchema` accepted. */
export function usdcDecimalToMinor(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export const commerceQuoteOptionSchema = z.object({
  /** Pass unchanged to the purchase step. */
  id: z.string().min(1).max(300),
  /** The merchant's shipping method name: untrusted display text. */
  label: z.string().min(1).max(300),
  subtotalUsdc: usdcDecimalSchema,
  shippingUsdc: usdcDecimalSchema,
  taxUsdc: usdcDecimalSchema,
  totalUsdc: usdcDecimalSchema,
}).refine(
  // MR-101: the total a user is shown is exactly its parts, in minor units.
  (option) => usdcDecimalToMinor(option.subtotalUsdc) + usdcDecimalToMinor(option.shippingUsdc) +
    usdcDecimalToMinor(option.taxUsdc) === usdcDecimalToMinor(option.totalUsdc),
  "A quote option's total is not subtotal + shipping + tax.",
);
export type CommerceQuoteOption = z.infer<typeof commerceQuoteOptionSchema>;

/** Where the quote ships: the saved name and address in full, email masked. */
export const commerceShipToSchema = z.object({
  name: z.string(),
  lines: z.array(z.string()).min(1).max(2),
  postalCode: z.string(),
  city: z.string(),
  state: z.string().nullable(),
  country: z.string(),
  emailMasked: z.string().nullable(),
});
export type CommerceShipTo = z.infer<typeof commerceShipToSchema>;

/** `POST /api/v1/agent/commerce/quotes`. Read-only: nothing is ordered. */
export const commerceQuoteSchema = z.object({
  /** `gp_cq_…`, bound to this agent, minutes-long; spent by the purchase step. */
  quoteToken: z.string().regex(/^gp_cq_[A-Za-z0-9_-]+$/).max(24_000),
  expiresAt: z.iso.datetime({ offset: true }),
  shipTo: commerceShipToSchema,
  /**
   * `confirmed`, or `new_requires_approval`: the first order to this address
   * waits for the owner's dashboard approval even under the spending caps.
   * Open: treat any other value like `new_requires_approval`.
   */
  addressStatus: openEnum(["confirmed", "new_requires_approval"]),
  options: z.array(commerceQuoteOptionSchema).min(1).max(20),
  instructions: z.string().nullish().transform((value) => value ?? null),
}).refine(
  (quote) => new Set(quote.options.map((option) => option.id)).size === quote.options.length,
  "A quote names the same shipping option twice.",
);
export type CommerceQuote = z.infer<typeof commerceQuoteSchema>;
