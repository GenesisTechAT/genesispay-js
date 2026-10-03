import { serviceContractRefSchema, serviceContractSchema } from "./service-contract.js";
import { reviewSummarySchema } from "./reviews.js";
import { z } from "zod";

/**
 * Deliberately open, not a closed `z.enum`.
 *
 * A closed enum makes every future status a **breaking** change for already
 * published clients: the server adds one, and an old SDK throws a parse error on
 * exactly the payments its agent most needs to look at. That happened — the
 * `unresolved` status was added server-side while this list was closed. A status
 * the client does not recognise now passes through as a string, so the SDK keeps
 * reading the payment and the caller can decide what to do with it.
 */
/**
 * Open unions, for the same reason the status one is open: a published client
 * that throws `invalid_response` on a value the server added later breaks the
 * WHOLE call — including reading a payment the caller urgently needs to see.
 * The known members stay listed so editors still autocomplete them.
 */
const openEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string()]);

/** Integer minor units as a decimal string, no sign, no leading zeros. */
const minorUnitsSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);

const agentPaymentStatusSchema = z.union([
  z.enum([
    "pending_approval",
    "approved",
    "denied",
    "executing",
    "settled",
    "failed",
    "expired",
    /** Authorization was delivered; whether it settled is not yet known. */
    "unresolved",
  ]),
  z.string(),
]);

export const agentPaymentRecordSchema = z.object({
  id: z.string(),
  agentAccountId: z.string(),
  // Null only for a commerce purchase's payment: the server never returns
  // the shop order's own pay link (ADR-0108 S5).
  resourceUrl: z.string().nullable(),
  description: z.string().nullable(),
  destinationWallet: z.string(),
  asset: openEnum(["USDC", "EURC"]).optional(),
  amountUsdcMinor: z.string(),
  feeUsdcMinor: z.string(),
  // MR-1013 (ADR-0101 S5): additive, so a server that predates them still
  // parses. A malformed money figure is refused, never read as "no fee": the
  // pay call maps that to an unknown outcome, which cannot understate a debit.
  buyerFeeMinor: minorUnitsSchema.optional(),
  totalDebitMinor: minorUnitsSchema.optional(),
  buyerFeeStatus: openEnum(["none", "quoted", "pending", "collected", "not_charged", "waived"]).optional(),
  chainId: z.number().int(),
  status: agentPaymentStatusSchema,
  txHash: z.string().nullable(),
  failureReason: z.string().nullable(),
  approvalExpiresAt: z.string().nullable(),
  authorizationValidBefore: z.string().nullable().optional(),
  resolvedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  createdAt: z.string(),
});

export const agentHttpResponseCaptureSchema = z.object({
  kind: z.string().optional(),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  bodyBase64: z.string(),
  mimeType: z.string(),
});

export const storedResultResponseSchema = z.object({
  paymentId: z.string(), paymentStatus: agentPaymentStatusSchema,
  result: z.object({
    state: z.string(), capturedAt: z.iso.datetime().optional(), expiresAt: z.iso.datetime().optional(),
    response: z.object({
      status: z.number().int().min(200).max(299), mimeType: z.string(), kind: z.string(),
      body: z.string().max(1_048_576), bodyBytes: z.number().int().min(1).max(1_048_576),
      bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).optional(),
  }).refine((result) => result.state !== "available" || Boolean(result.response && result.capturedAt && result.expiresAt),
    "available results need a complete response and retention times")
    .refine((result) => !["expired", "unavailable"].includes(result.state) || result.response === undefined,
      "unavailable content must not be returned"),
});

export const settledPayResponseSchema = z.object({
  paymentId: z.string(),
  status: z.literal("settled"),
  txHash: z.string().nullable(),
  response: agentHttpResponseCaptureSchema.nullable().optional(),
  payment: agentPaymentRecordSchema,
});

export const pendingApprovalPayResponseSchema = z.object({
  paymentId: z.string(),
  status: z.literal("pending_approval"),
  approvalUrl: z.string().optional(),
  payment: agentPaymentRecordSchema,
});

export const failedPayResponseSchema = z.object({
  paymentId: z.string(),
  status: z.literal("failed"),
  error: z.string(),
  payment: agentPaymentRecordSchema,
});

/**
 * The 409 a duplicate `idempotencyKey` produces. `paymentId` is nullable because
 * the row is looked up after the constraint fired, and the payment block is
 * optional so an older server that answers a bare `{ error, code }` still
 * degrades to a typed duplicate error rather than a generic one.
 */
export const duplicatePayResponseSchema = z.object({
  code: z.literal("payment_already_requested"),
  paymentId: z.string().nullable().optional(),
  /** The ORIGINAL payment's status — not this response's outcome. */
  paymentStatus: z.string().nullable().optional(),
  payment: agentPaymentRecordSchema.nullable().optional(),
});

/**
 * The 502 for a payment whose authorization was delivered and whose outcome is
 * unknown. Same envelope as `failedPayResponseSchema` but a different `status`,
 * because the two demand opposite retry decisions (MR-306).
 */
export const unresolvedPayResponseSchema = z.object({
  paymentId: z.string(),
  status: z.literal("unresolved"),
  error: z.string(),
  payment: agentPaymentRecordSchema,
});

export const paymentStatusResponseSchema = z.object({
  payment: agentPaymentRecordSchema,
});

export const accountResponseSchema = z.object({
  name: z.string(),
  walletAddress: z.string(),
  chainId: z.number().int(),
  status: openEnum(["active", "paused"]),
  usdcBalance: z.string().nullable(),
  policy: z.object({
    perPaymentCapUsdcMinor: z.string().nullable(),
    dailyCapUsdcMinor: z.string().nullable(),
    monthlyCapUsdcMinor: z.string().nullable(),
    allowlistEnabled: z.boolean(),
  }),
  spentTodayUsdcMinor: z.string(),
  spentThisMonthUsdcMinor: z.string(),
});

/**
 * An additive field a newer server may send. `.catch(undefined)` makes a
 * malformed value read as absent instead of failing the whole search: none of
 * these fields carries payment authority (the resource's 402 does), so losing
 * one degrades a listing, while a parse error would lose every listing.
 */
const lenientOptional = <Schema extends z.ZodType>(schema: Schema) =>
  schema.optional().catch(undefined);

const publicImageUrlSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
});

const discoveryShopSchema = z.object({ id: z.string(), name: z.string(), storefrontUrl: z.string().nullable() });

/**
 * Which directory a result comes from (ADR-0108). Sent by a server with
 * physical commerce on; absent on older ones (then it is GenesisPay's own).
 */
const discoverySourceSchema = lenientOptional(openEnum(["genesispay", "external"]));

/** `purchase` of a directly payable listing: copies of its own fields. */
const payPurchaseSchema = z.object({
  mode: z.literal("pay"),
  resourceUrl: z.string(),
  method: openEnum(["GET", "POST"]),
  priceUsdc: z.string(),
  asset: openEnum(["USDC", "EURC"]),
});

/** Catalogue-hint decimal, never the payable total. */
const listedPriceSchema = z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,6})?$/);

export const discoveredServiceSchema = z.object({
  reviewSummary: lenientOptional(reviewSummarySchema),
  serviceContract: lenientOptional(serviceContractRefSchema),
  imageUrl: lenientOptional(publicImageUrlSchema.nullable()),
  id: lenientOptional(z.string()),
  source: discoverySourceSchema,
  title: z.string(),
  description: z.string().nullable(),
  priceUsdc: z.string(),
  kind: openEnum(["api", "link", "product"]),
  resourceUrl: z.string(),
  category: z.string().nullable(),
  method: lenientOptional(openEnum(["GET", "POST"])),
  asset: lenientOptional(openEnum(["USDC", "EURC"])),
  shop: lenientOptional(discoveryShopSchema.nullable()),
  purchase: lenientOptional(payPurchaseSchema),
}).superRefine((listing, context) => {
  // A purchase hint that names another URL, price, method or asset than the
  // listing itself is a contradiction about what would be paid: the listing
  // is not used. An absent listing method/asset means GET/USDC (pre-POST,
  // pre-EURC servers), so a hint saying otherwise contradicts it too (MR-102).
  const { purchase } = listing;
  if (purchase && (purchase.resourceUrl !== listing.resourceUrl || purchase.priceUsdc !== listing.priceUsdc ||
      purchase.method !== (listing.method ?? "GET") ||
      purchase.asset !== (listing.asset ?? "USDC"))) {
    context.addIssue({ code: "custom", message: "A listing's purchase hint contradicts the listing." });
  }
});

/**
 * A quote-only physical product (ADR-0108): no payable URL or price. The only
 * way to buy it is `quote()` with `purchase.productId`, which decides
 * shipping, tax, stock and the exact total for the owner's saved address.
 */
export const discoveredQuoteProductSchema = z.object({
  reviewSummary: lenientOptional(reviewSummarySchema),
  imageUrl: lenientOptional(publicImageUrlSchema.nullable()),
  id: z.string().regex(/^prod_[A-Za-z0-9_-]{8,187}$/),
  source: discoverySourceSchema,
  kind: z.literal("product"),
  title: z.string(),
  description: z.string().nullable(),
  asset: lenientOptional(openEnum(["USDC", "EURC"])),
  category: z.string().nullable(),
  shop: lenientOptional(discoveryShopSchema.nullable()),
  purchase: z.object({
    mode: z.literal("quote"),
    productId: z.string().regex(/^prod_[A-Za-z0-9_-]{8,187}$/),
    /** A catalogue hint only; the quote decides the amount. */
    listedPriceUsdc: listedPriceSchema,
    quoteUrl: lenientOptional(z.string()),
  }),
}).refine((product) => product.purchase.productId === product.id, "A quote product names another product.");

/**
 * One raw discovery entry, as this client reads it. A quote-only product
 * must carry nothing that looks payable; an entry that is neither a valid
 * payable listing nor a valid quote-only product is dropped, so one entry a
 * newer server shapes differently never fails the whole search.
 */
export function parseDiscoveryEntry(entry: unknown):
  | z.output<typeof discoveredServiceSchema>
  | z.output<typeof discoveredQuoteProductSchema>
  | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const purchase = record.purchase as { mode?: unknown } | null | undefined;
  if (purchase && typeof purchase === "object" && purchase.mode === "quote") {
    if ("resourceUrl" in record || "priceUsdc" in record || "method" in record) return null;
    const parsed = discoveredQuoteProductSchema.safeParse(entry);
    return parsed.success ? parsed.data : null;
  }
  const parsed = discoveredServiceSchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

/** Entries are parsed one by one (see `parseDiscoveryEntry`). */
export const discoveryResponseSchema = z.object({
  listings: z.array(z.unknown()),
});

const payableServiceDescriptionSchema = z.object({
  listing: discoveredServiceSchema,
  contract: serviceContractSchema,
}).superRefine(({ listing, contract }, context) => {
  if (!listing.id || listing.resourceUrl !== contract.resourceUrl || listing.method !== contract.method ||
      listing.serviceContract?.revision !== contract.revision || listing.serviceContract?.schemaVersion !== contract.schemaVersion) {
    context.addIssue({ code: "custom", message: "Service description does not match its listing" });
  }
});

/** A quote-only product has no contract: the server says to quote first. */
const quoteFirstServiceDescriptionSchema = z.object({
  listing: discoveredQuoteProductSchema,
  contract: z.null(),
  instructions: z.string().max(2000),
});

export const serviceDescriptionSchema = z.union([payableServiceDescriptionSchema, quoteFirstServiceDescriptionSchema]);

/**
 * One entry of `GET /api/v1/discovery/shops`. Optional descriptive fields
 * normalize to null so a server that omits them still yields a usable shop.
 */
export const discoveredShopSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish().catch(null).transform((value) => value ?? null),
  storefrontUrl: z.string().nullable(),
  category: z.string().nullish().catch(null).transform((value) => value ?? null),
  productCount: z.number().int().nonnegative().nullish().catch(null).transform((value) => value ?? null),
});

/** Entries are parsed one by one (see `GenesisPayAgent.shops`): a malformed shop is dropped, not fatal. */
export const shopsResponseSchema = z.object({
  shops: z.array(z.unknown()),
});

/**
 * One entry of `GET /api/v1/discovery/trending`. The identity, price and
 * payable URL are required (an entry without them cannot be acted on and is
 * dropped); descriptive fields normalize to null.
 */
export const trendingProductSchema = z.object({
  reviewSummary: lenientOptional(reviewSummarySchema),
  serviceContract: lenientOptional(serviceContractRefSchema),
  imageUrl: lenientOptional(publicImageUrlSchema.nullable()),
  rank: z.number().int().positive(),
  id: z.string(),
  title: z.string(),
  description: z.string().nullish().catch(null).transform((value) => value ?? null),
  asset: openEnum(["USDC", "EURC"]),
  priceMinor: z.string().regex(/^\d+$/),
  priceUsdc: z.string(),
  method: openEnum(["GET", "POST"]),
  resourceUrl: z.string(),
  category: z.string().nullish().catch(null).transform((value) => value ?? null),
  shop: z.object({ id: z.string(), name: z.string(), storefrontUrl: z.string().nullable() })
    .nullish().catch(null).transform((value) => value ?? null),
  signal: openEnum(["sales", "new"]),
});

/** Entries are parsed one by one (see `GenesisPayAgent.trending`): a malformed product is dropped, not fatal. */
export const trendingResponseSchema = z.object({
  products: z.array(z.unknown()),
});

export const apiErrorBodySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

/**
 * The commerce routes' refusal body: the shared error body plus the optional
 * `reason` refinement, next-step `instructions` and per-field `issues`. Each
 * extra is lenient, so a malformed one degrades to absent.
 */
export const commerceErrorBodySchema = apiErrorBodySchema.extend({
  reason: z.string().max(100).optional().catch(undefined),
  instructions: z.string().max(2000).optional().catch(undefined),
  issues: z.array(z.object({ path: z.string().max(200), message: z.string().max(500) })).max(50)
    .optional().catch(undefined),
});

/** V2 success/acceptance always names one original payment, even while it is unresolved. */
export const strictAgentPayResponseSchema = z.object({
  apiVersion: z.literal(2), idempotencyKey: z.string().min(1).max(200), replayed: z.boolean(),
  paymentId: z.string().min(1), status: agentPaymentStatusSchema, payment: agentPaymentRecordSchema,
  txHash: z.string().nullable(), response: agentHttpResponseCaptureSchema.nullable(),
  approvalUrl: z.string().nullable(), statusUrl: z.string(),
  // Additive echo of the purchase request the server understood (2026-09-24).
  // Lenient on purpose: the client, not the parser, decides what a missing or
  // malformed echo means — for a POST purchase it is an unknown outcome.
  requestMethod: z.string().optional().catch(undefined),
  bodySha256: z.string().optional().catch(undefined),
}).superRefine((value, context) => {
  if (value.paymentId !== value.payment.id || value.status !== value.payment.status || value.txHash !== value.payment.txHash) {
    context.addIssue({ code: "custom", message: "The original payment identifiers or outcome disagree." });
  }
});
