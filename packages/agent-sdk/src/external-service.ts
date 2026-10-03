import { z } from "zod";
import { serviceContractSchema } from "./service-contract.js";

export const externalServiceIdSchema = z.string().regex(/^ext_[a-z0-9_]{3,64}$/);
export const externalServiceQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

/**
 * The opt-in extras a discovery request may ask for (`?include=…`). Only
 * `buyerFee` exists; the server refuses any other value, so this list is
 * closed on purpose — an unknown include would turn a free read into a 422.
 */
export const externalServiceIncludeSchema = z.array(z.literal("buyerFee")).optional();
export type ExternalServiceInclude = "buyerFee";

/**
 * `discoverExternalServices` options: the wire query plus the opt-in extras.
 * The query schema itself stays exactly the wire contract (the server parses
 * the query with it, after taking `include` out).
 */
export const externalServiceDiscoveryOptionsSchema = externalServiceQuerySchema.extend({
  include: externalServiceIncludeSchema,
});
export type ExternalServiceDiscoveryOptions = z.infer<typeof externalServiceDiscoveryOptionsSchema>;

/** `describeExternalService` options. */
export const externalServiceDescribeOptionsSchema = z.strictObject({ include: externalServiceIncludeSchema });
export type ExternalServiceDescribeOptions = z.infer<typeof externalServiceDescribeOptionsSchema>;

const httpsUrl = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
});
const minorUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const positiveMinorUnits = z.string().regex(/^[1-9][0-9]{0,77}$/);

/**
 * MR-1013 (ADR-0101 S5): the payer-paid GenesisPay fee an agent would pay ON
 * TOP of `priceHint` when buying this service, sent only when the request
 * asked for it (`include: ["buyerFee"]`). Integer minor units of the price
 * hint's asset, as decimal strings.
 *
 * - `active: true` — `feeMinor = max(floor(amountMinor × bps / 10000), minMinor)`
 *   and `totalMinor = amountMinor + feeMinor`.
 * - `active: false` — no buyer fee for this price right now (`feeMinor: "0"`,
 *   `totalMinor` equals the price hint).
 *
 * A hint, not a quote: the payment snapshots its own fee when it is created,
 * and a provider that turns out to be a GenesisPay seller pays no buyer fee.
 * Absent when the server could not compute it (or predates it) — absence
 * never means "no fee".
 */
export const externalServiceBuyerFeeSchema = z.discriminatedUnion("active", [
  z.strictObject({
    active: z.literal(true),
    bps: z.number().int().min(1).max(10_000),
    minMinor: minorUnits,
    feeMinor: positiveMinorUnits,
    totalMinor: positiveMinorUnits,
  }),
  z.strictObject({
    active: z.literal(false),
    bps: z.null(),
    minMinor: z.null(),
    feeMinor: z.literal("0"),
    totalMinor: positiveMinorUnits,
  }),
]);
export type ExternalServiceBuyerFee = z.infer<typeof externalServiceBuyerFeeSchema>;

function buyerFeeAddsUp(amountMinor: string, buyerFee: ExternalServiceBuyerFee): boolean {
  try {
    return BigInt(buyerFee.totalMinor) === BigInt(amountMinor) + BigInt(buyerFee.feeMinor);
  } catch {
    return false; // a malformed figure is already an issue of its own field
  }
}

export const externalServiceSchema = z.strictObject({
  id: externalServiceIdSchema,
  origin: z.literal("external_x402"),
  provider: z.string().min(1).max(100),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1500),
  resourceUrl: httpsUrl,
  method: z.enum(["GET", "POST"]),
  sources: z.array(httpsUrl).min(1).max(3),
  checkedAt: z.iso.datetime(),
  priceHint: z.strictObject({ asset: z.literal("USDC"), amountMinor: z.string().regex(/^[1-9][0-9]{0,77}$/), network: z.literal("eip155:8453") }),
  evidence: z.strictObject({ kind: z.literal("unsigned_402"), maxTimeoutSeconds: z.number().int().min(300).max(3600), purchaseTested: z.literal(false) }),
  contract: serviceContractSchema,
  buyerFee: externalServiceBuyerFeeSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.resourceUrl !== value.contract.resourceUrl || value.method !== value.contract.method || value.checkedAt !== value.contract.provenance.checkedAt) {
    ctx.addIssue({ code: "custom", message: "Inconsistent external service observation" });
  }
  // The total is the one figure a caller shows the user; a hint whose total
  // is not price + fee would understate or overstate it, so it is refused.
  if (value.buyerFee && !buyerFeeAddsUp(value.priceHint.amountMinor, value.buyerFee)) {
    ctx.addIssue({ code: "custom", message: "Inconsistent external service buyer fee" });
  }
});
export const externalServicePageSchema = z.strictObject({ services: z.array(externalServiceSchema).max(20) });
export type ExternalService = z.infer<typeof externalServiceSchema>;
export type ExternalServiceQuery = z.infer<typeof externalServiceQuerySchema>;

/** The `include` query value for these options, or null when none is requested. */
export function externalServiceIncludeParam(include: readonly ExternalServiceInclude[] | undefined): string | null {
  return include?.includes("buyerFee") ? "buyerFee" : null;
}
