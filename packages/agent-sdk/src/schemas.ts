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
  resourceUrl: z.string(),
  description: z.string().nullable(),
  destinationWallet: z.string(),
  asset: openEnum(["USDC", "EURC"]).optional(),
  amountUsdcMinor: z.string(),
  feeUsdcMinor: z.string(),
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
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  bodyBase64: z.string(),
  mimeType: z.string(),
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

export const discoveredServiceSchema = z.object({
  id: lenientOptional(z.string()),
  title: z.string(),
  description: z.string().nullable(),
  priceUsdc: z.string(),
  kind: openEnum(["api", "link"]),
  resourceUrl: z.string(),
  category: z.string().nullable(),
  method: lenientOptional(openEnum(["GET", "POST"])),
  asset: lenientOptional(openEnum(["USDC", "EURC"])),
  shop: lenientOptional(
    z.object({ id: z.string(), name: z.string(), storefrontUrl: z.string().nullable() }).nullable(),
  ),
});

export const discoveryResponseSchema = z.object({
  listings: z.array(discoveredServiceSchema),
});

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
