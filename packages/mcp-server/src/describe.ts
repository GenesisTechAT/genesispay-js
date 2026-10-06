/**
 * How a payment, a commerce purchase, a quote or a listing reads to the model:
 * the JSON payloads the tools return on success, built from the agent SDK's
 * records with every figure in exact decimals of integer minor units (MR-101).
 * Pure: nothing here calls the agent.
 */
import type {
  AgentPaymentRecord,
  AgentPaymentResult,
  CommercePurchase,
  CommerceQuote,
  DiscoveredPayableService,
  DiscoveredQuoteProduct,
  DiscoveredService,
  ExternalService,
  GenesisPayOutcomeWaitTimeoutError,
  GenesisPayPaymentOutcomeUnknownError,
  TrendingProduct,
} from "@genesis-tech/genesispay-agent";

import {
  APPROVAL_GUIDANCE,
  APPROVED_GUIDANCE,
  BUYER_FEE_TOTAL_GUIDANCE,
  COMMERCE_REFUSAL_GUIDANCE,
  NEW_ADDRESS_APPROVAL_NOTE,
  NOT_CONFIRMED_GUIDANCE,
  POLICY_BLOCKED_GUIDANCE,
  PURCHASE_PROCESSING_GUIDANCE,
  PURCHASE_RESUME_BLOCKED_GUIDANCE,
  PURCHASE_SETTLED_GUIDANCE,
  QUOTE_GUIDANCE,
  QUOTE_PURCHASE_STEP_GUIDANCE,
  SETTLED_REPLAY_GUIDANCE,
  SETTLEMENT_ACCEPTANCE_NOTE,
  UNRESOLVED_GUIDANCE,
  contentGuidance,
  hasApprovalHistory,
  isStaleReplay,
  lateDeliveryGuidance,
  purchaseApprovalGuidance,
  staleReplayGuidance,
} from "./tool-guidance.js";

export const MAX_INLINE_BODY_CHARS = 50_000;

/**
 * A quote as the model sees it: every figure as the server sent it (exact
 * decimals of integer minor units, MR-101), the request echoed so the model
 * can name what was quoted, and the next step for the address it ships to.
 */
export function describeQuote(quote: CommerceQuote, request: { productId: string; quantity: number }): Record<string, unknown> {
  const confirmed = quote.addressStatus === "confirmed";
  return {
    productId: request.productId,
    quantity: request.quantity,
    shipTo: quote.shipTo,
    // Anything but "confirmed" is read as needing the owner (D3).
    addressStatus: quote.addressStatus,
    options: quote.options,
    quoteToken: quote.quoteToken,
    expiresAt: quote.expiresAt,
    instructions: [QUOTE_GUIDANCE, ...(confirmed ? [] : [NEW_ADDRESS_APPROVAL_NOTE]), QUOTE_PURCHASE_STEP_GUIDANCE].join(" "),
  };
}

/**
 * A commerce purchase as the model sees it, for the quote form of
 * `genesispay_pay` and for `genesispay_payment_status` with a purchaseId.
 * Every figure as the server sent it (exact decimals, MR-101); the guidance
 * comes from the status and the allowlisted code only.
 */
export function describePurchase(purchase: CommercePurchase): Record<string, unknown> {
  const { purchase: row } = purchase;
  return {
    purchaseId: purchase.purchaseId,
    status: purchase.status,
    replayed: purchase.replayed,
    product: { productId: row.productId, name: row.productName, quantity: row.quantity },
    shop: { name: row.shopName },
    shippingOptionId: row.shippingOptionId,
    subtotalUsdc: row.subtotalUsdc,
    shippingUsdc: row.shippingUsdc,
    taxUsdc: row.taxUsdc,
    totalUsdc: purchase.totalUsdc,
    ...(row.approvalReasons.length > 0 ? { approvalReasons: row.approvalReasons } : {}),
    order: purchase.order,
    paymentId: purchase.paymentId,
    ...(purchase.payment ? { paymentStatus: purchase.payment.status, amountUsdc: formatUsdcMinor(purchase.payment.amountUsdcMinor) } : {}),
    txHash: purchase.txHash,
    approvalUrl: purchase.approvalUrl,
    ...(purchase.code ? { code: purchase.code } : {}),
    ...(purchase.reason ? { reason: purchase.reason } : {}),
    ...(purchase.replayed && purchase.status === "settled" && isStaleReplay(row.createdAt) &&
      row.approvalReasons.length === 0 && !row.approvalExpiresAt && !hasApprovalHistory(purchase.payment)
      ? { outcome: "earlier_purchase", instructions: `${staleReplayGuidance(row.createdAt, "settled")} ${purchaseGuidance(purchase)}` }
      : { instructions: purchaseGuidance(purchase) }),
  };
}

function purchaseGuidance(purchase: CommercePurchase): string {
  const { status, payment } = purchase;
  if (status === "settled" && payment) return PURCHASE_SETTLED_GUIDANCE;
  if (status === "pending_approval" && !payment) return purchaseApprovalGuidance(purchase.approvalUrl);
  if (status === "processing" && !payment) {
    return purchase.code === "commerce_purchase_resume_blocked" ? PURCHASE_RESUME_BLOCKED_GUIDANCE : PURCHASE_PROCESSING_GUIDANCE;
  }
  if ((status === "failed" || status === "denied" || status === "expired") && !payment) {
    const code = purchase.code ?? purchase.purchase.failureCode;
    if (code === "policy_blocked") return POLICY_BLOCKED_GUIDANCE;
    const reason = purchase.reason ?? (status === "denied" ? "commerce_purchase_denied" : status === "expired" ? "approval_expired" : null);
    return reason ? COMMERCE_REFUSAL_GUIDANCE[reason]
      : "This purchase did not go through. Nothing was charged. Tell the user; quote again only if they still want it.";
  }
  if (status === "failed") {
    return "The payment for this purchase failed, so nothing was charged. Tell the user; quote again and buy with a " +
      "new key from genesispay_purchase_key only if they still want it.";
  }
  if (status === "approved" || status === "executing") return APPROVED_GUIDANCE;
  // `unresolved`, or a state this connector predates: a charge cannot be ruled out (MR-306).
  return UNRESOLVED_GUIDANCE;
}

/**
 * A quote-only physical product as the model sees it. Nothing on it is
 * payable: no resourceUrl, no price but the catalogue hint, and the quote URL
 * is left out because the model reaches it only through genesispay_quote.
 */
export function describeQuoteProduct(listing: DiscoveredQuoteProduct): Record<string, unknown> {
  // MR-102: the listed price is in `asset`; a non-USDC product is marked like
  // any other listing in another asset, never shown as a bare USDC figure.
  return {
    ...notPayableMarker(listing.asset, "product"),
    id: listing.id,
    source: listing.source ?? "genesispay",
    kind: listing.kind,
    ...(listing.reviewSummary ? { reviewSummary: listing.reviewSummary } : {}),
    title: listing.title,
    description: listing.description,
    ...(listing.imageUrl !== undefined ? { imageUrl: listing.imageUrl } : {}),
    category: listing.category,
    ...(listing.shop ? { shop: listing.shop } : {}),
    ...(listing.asset !== undefined ? { asset: listing.asset } : {}),
    purchase: { mode: "quote", productId: listing.purchase.productId, listedPriceUsdc: listing.purchase.listedPriceUsdc },
    nextStep: "Physical product: call genesispay_quote with this productId and the quantity the user wants to see the " +
      "shipping options and exact total for the saved address. listedPriceUsdc is only a catalogue hint. " +
      "Never pay it by URL: the quote answer says how to buy it with genesispay_pay.",
  };
}

/**
 * A curated external service inside `genesispay_discover`: the fields a model
 * compares, the buyer fee spelled out, and a pointer to the full contract
 * (genesispay_describe_service) instead of the contract itself.
 */
export function describeExternalListing(service: ExternalService): Record<string, unknown> {
  const { buyerFee } = describeExternalServiceFee(service);
  const priceUsdc = formatUsdcMinor(service.priceHint.amountMinor);
  return {
    id: service.id,
    source: "external",
    kind: "api",
    title: service.title,
    description: service.description,
    provider: service.provider,
    priceUsdc,
    asset: service.priceHint.asset,
    method: service.method,
    resourceUrl: service.resourceUrl,
    checkedAt: service.checkedAt,
    serviceContract: { schemaVersion: service.contract.schemaVersion, revision: service.contract.revision },
    ...(buyerFee ? { buyerFee } : {}),
    purchase: { mode: "pay", resourceUrl: service.resourceUrl, method: service.method, priceUsdc, asset: service.priceHint.asset },
    nextStep: "Independent provider, not a verified GenesisPay merchant. Read its inputs with " +
      "genesispay_describe_service(id) first; then, with the user's authorization, get a key from " +
      "genesispay_purchase_key and pay resourceUrl with " +
      "genesispay_pay (maxAmountUsdc = priceUsdc" + (service.method === "POST" ? ", method \"POST\" and the exact JSON body" : "") +
      "). " + (buyerFee
        ? "Tell the user the total including the GenesisPay fee (buyerFee)."
        // MR-1013: an absent hint is not "no fee".
        : "A GenesisPay fee may be added on top of the price; its exact amount is reported with the payment. " +
          "Tell the user so and never estimate it."),
  };
}

export function describePayResult(result: AgentPaymentResult): Record<string, unknown> {
  const buyerFee = describeBuyerFee(result.payment);

  if (result.pendingApproval) {
    return {
      status: "pending_approval",
      paymentId: result.paymentId,
      approvalUrl: result.approvalUrl,
      amountUsdc: formatUsdcMinor(result.payment.amountUsdcMinor),
      ...buyerFee,
      resourceUrl: result.payment.resourceUrl,
      instructions: "feeSummary" in buyerFee
        ? `${APPROVAL_GUIDANCE} ${BUYER_FEE_TOTAL_GUIDANCE}`
        : APPROVAL_GUIDANCE,
    };
  }

  const resource = describeCapturedResource(result);

  return {
    status: "settled",
    paymentId: result.paymentId,
    txHash: result.txHash,
    amountUsdc: formatUsdcMinor(result.payment.amountUsdcMinor),
    ...buyerFee,
    resourceUrl: result.payment.resourceUrl,
    // The purchase request the server confirmed; absent on a server that
    // predates the echo (then it was a GET — the SDK refuses a POST without it).
    ...(result.requestMethod ? { requestMethod: result.requestMethod } : {}),
    ...(result.bodySha256 ? { bodySha256: result.bodySha256 } : {}),
    resource,
    // A replay returns the retained payment, never a second resource fetch
    // (ADR-0076). Without this a model reads `resource: null` as "the purchase
    // delivered nothing" and buys again under a new key.
    ...settledReplayGuidance(result.replayed, resource === null, result.payment),
    ...(!result.replayed && !deliveredInCall(result) ? {
      instructions: contentGuidance(result),
      ...(result.lateDeliveryPending ? { lateDeliveryPending: true, lateDeliveryUntil: result.lateDeliveryUntil } : {}),
    } : {}),
  };
}

/** A fresh settled pay delivered its content when it captured a 2xx response. */
function deliveredInCall(result: AgentPaymentResult): boolean {
  const status = result.response?.status;
  return status !== undefined && status >= 200 && status < 300;
}

/**
 * A settled replay (ADR-0076). One that is older than a turn is most likely a
 * key reused for a new purchase (MR-307): it says so, so the model neither
 * reports the old result as today's purchase nor buys again under that key.
 */
function settledReplayGuidance(
  replayed: boolean,
  withoutResource: boolean,
  payment: AgentPaymentRecord,
): Record<string, unknown> {
  if (!replayed) return {};
  const { createdAt } = payment;
  if (isStaleReplay(createdAt) && !hasApprovalHistory(payment)) {
    return {
      outcome: "earlier_purchase",
      instructions: `${staleReplayGuidance(createdAt, "settled")} ${withoutResource ? SETTLED_REPLAY_GUIDANCE : ""}`.trim(),
    };
  }
  return withoutResource ? { instructions: SETTLED_REPLAY_GUIDANCE } : {};
}

function describeCapturedResource(
  result: AgentPaymentResult,
): Record<string, unknown> | null {
  if (!result.response) {
    return null;
  }

  const { status, mimeType } = result.response;

  // A foreign 202 can be an unfinished service job. Only the server's validated
  // acceptance classification identifies the GenesisPay settlement envelope.
  const acceptance = status === 202 ? { note: result.response.kind === "settlement_acceptance"
    ? SETTLEMENT_ACCEPTANCE_NOTE
    : "HTTP 202: an asynchronous provider response. Payment and service completion are separate; the finished result is not confirmed. Do not pay again." } : {};

  if (!isTextLikeMimeType(mimeType)) {
    return {
      status,
      mimeType,
      note: "Binary response body omitted.",
      ...acceptance,
    };
  }

  const body = result.body();
  const truncated = body.length > MAX_INLINE_BODY_CHARS;
  return {
    status,
    mimeType,
    kind: result.response.kind,
    ...(truncated ? { bodyPreview: body.slice(0, MAX_INLINE_BODY_CHARS) } : { body }),
    truncated,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    resultId: result.paymentId,
    ...(truncated ? { instructions: "This is only a preview. Use genesispay_result with this paymentId and nextOffset to retrieve complete stored JSON; storage may be unavailable. Do not pay again." } : {}),
    ...acceptance,
  };
}

/**
 * The `genesispay_pay` answer after the bounded wait ran out (MR-306). Built
 * from the payment row, not from the SDK's error message, so the text the model
 * reads is exactly the guidance and never calls the payment failed.
 */
export function describeNotConfirmed(
  error: GenesisPayOutcomeWaitTimeoutError,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    status: error.payment.status,
    outcome: "not_confirmed_yet",
    paymentId: error.payment.id,
    amountUsdc: formatUsdcMinor(error.payment.amountUsdcMinor),
    ...describeBuyerFee(error.payment),
    resourceUrl: error.payment.resourceUrl,
    idempotencyKey: error.idempotencyKey ?? idempotencyKey,
    ...lateDeliveryNote(error, NOT_CONFIRMED_GUIDANCE),
  };
}

/**
 * MR-307 (2026-10-04): an unconfirmed (usually `unresolved`) pay whose server
 * said a late resend is pending gets the late-delivery line after its own
 * guidance; otherwise the guidance is unchanged.
 */
export function lateDeliveryNote(
  error: GenesisPayPaymentOutcomeUnknownError,
  guidance: string,
): Record<string, unknown> {
  if (!error.lateDeliveryPending) return { instructions: guidance };
  return {
    lateDeliveryPending: true,
    lateDeliveryUntil: error.lateDeliveryUntil,
    instructions: `${guidance} ${lateDeliveryGuidance(error.lateDeliveryUntil)}`,
  };
}

/** Buyer-fee states in which the fee no longer moves (it is not in the total). */
const BUYER_FEE_DROPPED_STATUSES: ReadonlySet<string> = new Set(["not_charged", "waived"]);

/**
 * MR-1013 (ADR-0101 S5): the payer-paid GenesisPay fee of a payment, as the
 * model sees it — nothing at all when the payment carries none (absent, from
 * an older server, or "0"), so a fee-less answer is unchanged.
 *
 * All arithmetic is on integer minor units (bigint). The fee is shown out of
 * the total only when the server says both that it no longer moves
 * (`not_charged`/`waived`) and that the total is the price alone; any other
 * combination shows price + fee, so the figure can overstate the debit but
 * never understate it.
 */
function describeBuyerFee(payment: Pick<AgentPaymentRecord,
  "amountUsdcMinor" | "asset" | "buyerFeeMinor" | "totalDebitMinor" | "buyerFeeStatus">): Record<string, unknown> {
  const feeMinor = parseMinorUnits(payment.buyerFeeMinor);
  if (feeMinor === null || feeMinor === 0n) return {};
  const amountMinor = BigInt(payment.amountUsdcMinor);
  const status = payment.buyerFeeStatus ?? null;
  const dropped = status !== null && BUYER_FEE_DROPPED_STATUSES.has(status) &&
    parseMinorUnits(payment.totalDebitMinor) === amountMinor;
  const totalMinor = dropped ? amountMinor : amountMinor + feeMinor;
  const asset = payment.asset ?? "USDC";
  const amount = formatUsdcMinor(amountMinor.toString());
  const fee = formatUsdcMinor(feeMinor.toString());
  return {
    genesisPayFeeUsdc: fee,
    totalUsdc: formatUsdcMinor(totalMinor.toString()),
    buyerFeeStatus: status,
    feeSummary: dropped
      ? `${amount} ${asset}; GenesisPay fee ${fee} ${status === "waived" ? "waived" : "not charged"}`
      : buyerFeeSummary(amountMinor, feeMinor, asset),
  };
}

/** "0.001 + GenesisPay fee 0.005 = 0.006 USDC", from integer minor units. */
function buyerFeeSummary(amountMinor: bigint, feeMinor: bigint, asset: string): string {
  return `${formatUsdcMinor(amountMinor.toString())} + GenesisPay fee ${formatUsdcMinor(feeMinor.toString())} = ` +
    `${formatUsdcMinor((amountMinor + feeMinor).toString())} ${asset}`;
}

/**
 * An external service with its buyer-fee hint spelled out. The hint's own
 * figures are kept as sent; a service without a hint (or an inactive one)
 * is returned unchanged.
 */
export function describeExternalServiceFee(service: ExternalService): Record<string, unknown> {
  if (!service.buyerFee?.active) return { ...service };
  return {
    ...service,
    buyerFee: {
      ...service.buyerFee,
      feeSummary: buyerFeeSummary(BigInt(service.priceHint.amountMinor), BigInt(service.buyerFee.feeMinor),
        service.priceHint.asset),
    },
  };
}

function parseMinorUnits(value: string | undefined): bigint | null {
  return value !== undefined && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
}

/**
 * A listing as the model sees it: the additive fields only when the server sent
 * them. A non-USDC listing is kept (the user may want to know it exists) but
 * marked `notPayable`: this server can only select USDC, and the engine applies
 * the `maxAmountUsdc` ceiling only to a payment in the filtered asset, so paying
 * such a listing here would be either refused or unguarded.
 */
export function describeListing(listing: DiscoveredService): Record<string, unknown> {
  if (listing.purchase?.mode === "quote") return describeQuoteProduct(listing as DiscoveredQuoteProduct);
  return describePayableListing(listing as DiscoveredPayableService);
}

function describePayableListing(listing: DiscoveredPayableService): Record<string, unknown> {
  const notPayable = notPayableMarker(listing.asset, "listing");
  return {
    ...notPayable,
    ...(listing.id !== undefined ? { id: listing.id } : {}),
    source: listing.source ?? "genesispay",
    ...(listing.serviceContract ? { serviceContract: listing.serviceContract } : {}),
    ...(listing.reviewSummary ? { reviewSummary: listing.reviewSummary } : {}),
    title: listing.title,
    description: listing.description,
    ...(listing.imageUrl !== undefined ? { imageUrl: listing.imageUrl } : {}),
    priceUsdc: listing.priceUsdc,
    kind: listing.kind,
    resourceUrl: listing.resourceUrl,
    category: listing.category,
    ...(listing.method !== undefined ? { method: listing.method } : {}),
    ...(listing.asset !== undefined ? { asset: listing.asset } : {}),
    ...(listing.shop ? { shop: listing.shop } : {}),
    // Built from the listing's own fields (the SDK refuses a server hint that
    // contradicts them), so an older server's listing reads the same way.
    purchase: {
      mode: "pay", resourceUrl: listing.resourceUrl, priceUsdc: listing.priceUsdc,
      ...(listing.method !== undefined ? { method: listing.method } : {}),
      ...(listing.asset !== undefined ? { asset: listing.asset } : {}),
    },
    nextStep: "notPayable" in notPayable
      ? "Not payable with this agent wallet (see note); tell the user."
      : (listing.serviceContract ? "Read its inputs with genesispay_describe_service(id) first. " : "") +
        "With the user's authorization, get a key from genesispay_purchase_key and pay resourceUrl with " +
        "genesispay_pay (maxAmountUsdc = priceUsdc" +
        (listing.method === "POST" ? ", method \"POST\" and the exact JSON body" : "") + ").",
  };
}

/**
 * A trending product as the model sees it, with the same asset guard as a
 * discovery listing: a non-USDC product is kept but marked `notPayable`.
 */
export function describeTrendingProduct(product: TrendingProduct): Record<string, unknown> {
  return {
    ...notPayableMarker(product.asset, "product"),
    rank: product.rank,
    id: product.id,
    ...(product.serviceContract ? { serviceContract: product.serviceContract } : {}),
    ...(product.reviewSummary ? { reviewSummary: product.reviewSummary } : {}),
    title: product.title,
    description: product.description,
    ...(product.imageUrl !== undefined ? { imageUrl: product.imageUrl } : {}),
    priceUsdc: product.priceUsdc,
    priceMinor: product.priceMinor,
    asset: product.asset,
    method: product.method,
    resourceUrl: product.resourceUrl,
    category: product.category,
    ...(product.shop ? { shop: product.shop } : {}),
    signal: product.signal,
  };
}

/**
 * The one asset guard for everything this server offers to buy. Absent means a
 * pre-EURC server, which only ever advertised USDC.
 */
function notPayableMarker(
  asset: string | undefined,
  noun: "listing" | "product",
): Record<string, unknown> {
  if (asset === undefined || asset === "USDC") return {};
  return {
    notPayable: true,
    note: `Settles in ${asset}, not USDC. Do not call genesispay_pay for this ${noun}; tell the user it cannot be bought with this agent wallet.`,
  };
}

export function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml")
  );
}

// Mirrors src/lib/money.ts toTokenAmount (non-negative input) by the packages boundary.
function formatUsdcMinor(amountUsdcMinor: string): string {
  const amount = BigInt(amountUsdcMinor);
  const whole = amount / 1_000_000n;
  const fractional = amount % 1_000_000n;

  if (fractional === 0n) {
    return whole.toString();
  }

  return `${whole}.${fractional.toString().padStart(6, "0").replace(/0+$/, "")}`;
}
