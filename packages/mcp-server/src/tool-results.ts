/**
 * How a GenesisPay MCP tool answers: the content blocks, the JSON success
 * result, and the error pipeline that turns anything a tool caught into the
 * guidance the model reads. errorResult stays one ordered function on
 * purpose: later branches overwrite or delete what earlier ones set (the
 * retry line above all), so the order of its branches is the contract, and
 * tool-errors.test.ts pins its output byte for byte.
 */
import {
  GenesisPayApiError,
  GenesisPayApprovalRejectedError,
  GenesisPayApprovalTimeoutError,
  GenesisPayCommerceError,
  GenesisPayDuplicatePaymentError,
  GenesisPayIdempotencyConflictError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
  GenesisPayPolicyBlockedError,
  isIssuedPurchaseKey,
  isPurchaseKeyErrorCode,
  PURCHASE_KEY_UNAVAILABLE_CODE,
} from "@genesis-tech/genesispay-agent";

import { lateDeliveryNote } from "./describe.js";
import {
  APPROVAL_GUIDANCE,
  APPROVED_GUIDANCE,
  COMMERCE_REFUSAL_GUIDANCE,
  ISSUED_KEY_CONFLICT_GUIDANCE,
  POLICY_BLOCKED_GUIDANCE,
  PURCHASE_KEY_REFUSED_GUIDANCE,
  PURCHASE_KEY_UNAVAILABLE_GUIDANCE,
  REGISTRY_UNAVAILABLE_GUIDANCE,
  SERVICE_QUARANTINED_GUIDANCE,
  SHIPPING_PROFILE_TRUST_RULE,
  UNRESOLVED_GUIDANCE,
  hasApprovalHistory,
  isStaleReplay,
  legacyKeyConflictGuidance,
  staleReplayGuidance,
} from "./tool-guidance.js";

/** The content blocks a GenesisPay MCP tool result is made of. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function jsonResult(payload: Record<string, unknown>): {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
} {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      ...(typeof payload.reviewInstructions === "string"
        ? [{ type: "text" as const, text: "GenesisPay follow-up instructions: " + payload.reviewInstructions }] : []),
    ],
    ...(payload.reviewOpportunity || payload.reviewFollowUp ? { structuredContent: payload } : {}),
  };
}

/**
 * A commerce refusal (profile or quote, ADR-0108): nothing was ordered or
 * charged on any path, so no retry or "may have been charged" guidance
 * applies. The next step comes from the allowlisted reason only.
 */
type ErrorContext = "commerce" | "shipping_profile_set" | "purchase";

function commerceGuidance(error: GenesisPayApiError, context: ErrorContext): string {
  const reason = error instanceof GenesisPayCommerceError ? error.reason : null;
  if (reason) return COMMERCE_REFUSAL_GUIDANCE[reason];
  if (context === "purchase") return purchaseRefusalGuidance(error);
  if (error.status === 429) {
    return context === "shipping_profile_set"
      ? "Not saved: the account owner's agents may change the saved shipping details at most five times a day. " +
        "Do not retry now. Tell the user; the owner can change the address in the GenesisPay dashboard settings."
      : "Too many requests right now. Nothing was ordered. Wait before trying again; do not retry in a loop.";
  }
  if (error.code === "invalid_request" && context === "shipping_profile_set") {
    return "Not saved: some shipping details were refused (see issues). Ask the user to correct exactly those " +
      "fields, then call genesispay_shipping_profile set again. " + SHIPPING_PROFILE_TRUST_RULE;
  }
  if (error.code === "commerce_unavailable") {
    return "This GenesisPay connection does not support physical-product quotes or saved shipping details yet. " +
      "Nothing was ordered or changed. Tell the user.";
  }
  if (error.code === "merchant_quote_refused") {
    return "The shop could not quote this product to the saved address. Nothing was ordered. Tell the user; do " +
      "not retry the same quote.";
  }
  return "Nothing was ordered or charged. Tell the user; retry only if the error says the problem is temporary.";
}

/**
 * A purchase refusal without an allowlisted reason. The SDK raises a commerce
 * error for a purchase only when the server said no payment exists, so each
 * says nothing was charged — and never that nothing was ordered, which an
 * unrecognised refusal cannot promise.
 */
function purchaseRefusalGuidance(error: GenesisPayApiError): string {
  if (isPurchaseKeyErrorCode(error.code)) return PURCHASE_KEY_REFUSED_GUIDANCE;
  if (error.code === PURCHASE_KEY_UNAVAILABLE_CODE) return PURCHASE_KEY_UNAVAILABLE_GUIDANCE;
  if (error.status === 429) {
    return "Too many requests right now. Nothing was charged. Wait, then retry once with exactly the same " +
      "quoteToken, shippingOptionId, expectedTotalUsdc and idempotencyKey; do not retry in a loop.";
  }
  if (error.code === "invalid_request" || error.code === "invalid_json") {
    return "The purchase request was refused before anything happened. Pass quoteToken and shippingOptionId " +
      "unchanged from one genesispay_quote answer, expectedTotalUsdc exactly as that option's totalUsdc, and a " +
      "saved idempotencyKey of visible characters without spaces.";
  }
  if (error.code === "commerce_unavailable") {
    return "This GenesisPay connection cannot buy quoted physical products yet. Nothing was ordered or charged. " +
      "Tell the user.";
  }
  return "This purchase did not go through. Nothing was charged. Tell the user; quote again only if they still " +
    "want it, and never retry it with a new idempotencyKey without the user's go-ahead.";
}

export function errorResult(error: unknown, idempotencyKey?: string, context?: ErrorContext) {
  const details: Record<string, unknown> = {
    error: error instanceof Error ? error.message : "Unknown error.",
  };

  // A purchase's payment outcomes (policy block, failed payment, may have
  // charged) take the payment path below, exactly as the URL form does.
  if (error instanceof GenesisPayCommerceError ||
      (context && context !== "purchase" && error instanceof GenesisPayApiError)) {
    const apiError = error as GenesisPayApiError;
    details.code = apiError.code;
    details.httpStatus = apiError.status;
    if (error instanceof GenesisPayCommerceError) {
      if (error.reason) details.reason = error.reason;
      if (error.issues.length > 0) details.issues = error.issues;
    }
    if (context === "purchase") {
      if (apiError.purchaseId) details.purchaseId = apiError.purchaseId;
      if (idempotencyKey) details.idempotencyKey = idempotencyKey;
      // A conflict names an earlier purchase that may be paid: never "not charged".
      const reason = error instanceof GenesisPayCommerceError ? error.reason : null;
      details.outcome = reason === "idempotency_conflict" || reason === "commerce_quote_already_used"
        ? "existing_purchase" : "not_charged";
    }
    details.instructions = commerceGuidance(apiError, context ?? "commerce");
    return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], isError: true };
  }

  if (idempotencyKey) {
    details.idempotencyKey = idempotencyKey;
  }
  if (error instanceof GenesisPayApiError && error.purchaseId) {
    details.purchaseId = error.purchaseId;
  }

  // Withheld only where the server has TOLD us nothing was created: a 4xx
  // rejection or hard block. There, "retry with the same key" sends the model
  // round a loop that can never succeed and reads as though a retry were the
  // remedy, when the remedy is to tell the user.
  //
  // Everything else keeps the guidance, including an error this layer cannot
  // classify at all — an unrecognised throw is not evidence that nothing
  // happened, and the conservative advice is the one that cannot double-charge.
  // Three ways to know nothing is out there to be charged: the server answered
  // 4xx, the SDK typed it as a pre-signing rejection (which can be a 502 —
  // `target_unreachable` is the seller's endpoint failing, not ours), or the
  // payment is `failed`, which by MR-306 means no authorization was ever
  // emitted. In all three the same key can only ever 409, so telling the model
  // to reuse it sends it round a loop and contradicts what the SDK computed.
  const serverSaysNothingWasCreated =
    error instanceof GenesisPayPaymentRejectedError ||
    error instanceof GenesisPayPaymentFailedError ||
    (error instanceof GenesisPayApiError &&
      error.status >= 400 &&
      error.status < 500);

  if (idempotencyKey && !serverSaysNothingWasCreated) {
    details.retryGuidance =
      "If you retry this purchase, pass this same idempotencyKey. Retrying with a different key (or none) pays a second time.";
  }

  // BEFORE the generic retryGuidance can mislead, and before the other
  // branches: whenever a charge cannot be ruled out, the model must be told to
  // stop rather than to retry. This branch was missing entirely, so the pay
  // path handed the model the generic "pass this same idempotencyKey" line —
  // which reads as an invitation to retry — while the strong "do NOT buy this
  // again" instruction only ever fired on genesispay_payment_status.
  if (error instanceof GenesisPayPaymentOutcomeUnknownError) {
    details.paymentId = error.paymentId;
    details.paymentStatus = error.payment?.status ?? null;
    details.outcome = "unknown";
    // A row the server reports as `approved`/`executing` is still in flight on
    // the server, not a lost authorization: the model's move is to poll, and
    // "may already have been charged" would be premature. Anything else —
    // `unresolved`, or no readable row at all — keeps the MR-306 warning.
    const status = error.payment?.status;
    Object.assign(details, lateDeliveryNote(error,
      status === "approved" || status === "executing"
        ? APPROVED_GUIDANCE
        : UNRESOLVED_GUIDANCE));

    if (error.idempotencyKey ?? idempotencyKey) {
      details.idempotencyKey = error.idempotencyKey ?? idempotencyKey;
    }

    // Replaces, never accompanies, the generic guidance above.
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayIdempotencyConflictError) {
    details.paymentId = error.paymentId;
    details.paymentStatus = error.payment?.status ?? null;
    if (error.payment) {
      details.payment = { createdAt: error.payment.createdAt, description: error.payment.description };
    }
    // MR-307: an issued key can only conflict with this conversation's own
    // earlier call; a free-form key may have collided with any older purchase.
    details.instructions = idempotencyKey && isIssuedPurchaseKey(idempotencyKey)
      ? ISSUED_KEY_CONFLICT_GUIDANCE
      : legacyKeyConflictGuidance(error.payment);
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayPaymentRejectedError && isPurchaseKeyErrorCode(error.code)) {
    details.outcome = "not_charged";
    details.instructions = PURCHASE_KEY_REFUSED_GUIDANCE;
  }
  if (error instanceof GenesisPayPaymentRejectedError && error.code === PURCHASE_KEY_UNAVAILABLE_CODE) {
    details.outcome = "not_charged";
    details.instructions = PURCHASE_KEY_UNAVAILABLE_GUIDANCE;
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayDuplicatePaymentError) {
    // Not a failure: the payment exists and this call did not create a second.
    details.paymentId = error.paymentId;
    details.paymentStatus = error.payment?.status ?? null;

    // The original's status decides the advice, and getting this wrong wedges
    // the agent. A `failed` original never signed anything (MR-306), so the way
    // forward is a NEW key — the SDK computes exactly that and said so, and
    // overwriting it unconditionally with "read its status instead of retrying"
    // left the model with a key that 409s forever and no route to the purchase.
    details.retryGuidance =
      error.payment?.status === "failed"
        ? "The earlier attempt with this idempotencyKey was never charged and can no longer be. To buy this now, retry with a NEW key from genesispay_purchase_key. " +
          "A fresh attempt needs the user's go-ahead and that NEW key recorded before the call."
        : "This purchase was already requested and was NOT paid for twice. Read its status instead of retrying.";
  }

  if (error instanceof GenesisPayPolicyBlockedError) {
    // MR-502: a hard block, not an approval request. Nothing was created
    // (the 4xx branch above already withheld retry guidance); this says what
    // to do instead, so the model stops rather than probing for a way round.
    details.instructions = POLICY_BLOCKED_GUIDANCE;
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayApiError) {
    details.code = error.code;
    details.httpStatus = error.status;
  }

  // Pre-signing refusals of a curated external service (MR-607, ADR-0097).
  // The registry outage is a 503, but the SDK typed it as a rejection, so the
  // MR-306 "may already have been charged" warning must never appear here.
  if (error instanceof GenesisPayPaymentRejectedError && error.code === "external_registry_unavailable") {
    details.outcome = "not_charged";
    details.instructions = REGISTRY_UNAVAILABLE_GUIDANCE;
    if (idempotencyKey) {
      details.retryGuidance =
        "Nothing was created for this idempotencyKey, so a later retry with this same key and identical terms is safe.";
    }
  }
  if (error instanceof GenesisPayPaymentRejectedError && error.code === "external_service_quarantined") {
    details.outcome = "not_charged";
    details.instructions = SERVICE_QUARANTINED_GUIDANCE;
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayApprovalTimeoutError) {
    details.paymentId = error.payment.id;
    details.approvalUrl = error.approvalUrl;
    details.instructions = APPROVAL_GUIDANCE;
    // APPROVAL_GUIDANCE forbids a new key for this purchase and says a same-key
    // call only returns this payment, while the generic guidance says "retry
    // with this same key". One payload
    // must not carry both; the specific instruction wins.
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayPaymentFailedError) {
    details.paymentId = error.payment?.id ?? null;
    details.paymentStatus = error.payment?.status ?? null;
    // A fresh payment is minutes old at most, so an old failed payment is a
    // replay of an earlier purchase under a reused key (MR-307).
    const createdAt = error.payment?.createdAt;
    if (idempotencyKey && isStaleReplay(createdAt) && !hasApprovalHistory(error.payment)) {
      details.outcome = "earlier_purchase";
      details.instructions = staleReplayGuidance(createdAt, "failed");
    }
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayApprovalRejectedError) {
    details.paymentId = error.payment.id;
    details.paymentStatus = error.payment.status;
    // Denied or expired: a human said no, or the window closed. No key makes
    // that a purchase, and suggesting a retry invites routing around a denial.
    delete details.retryGuidance;
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    isError: true,
  };
}
