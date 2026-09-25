import { decodeJsonBase64, encodeJsonBase64 } from "./base64-json.js";
import {
  addressesEqual,
  isRecord,
  optionalAddress,
  optionalString,
  requireAddress,
  requireBytes32,
  requireDecimalString,
  requireHexString,
  requirePaymentAmountString,
  requireRecord,
  requireString,
} from "./field-validation.js";
import type {
  PaymentAccept,
  PaymentSignaturePayload,
  TransferAuthorization,
} from "./types.js";

export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

export function encodePaymentSignatureHeader(
  payload: PaymentSignaturePayload,
): string {
  return encodeJsonBase64(payload);
}

export function decodePaymentSignatureHeader(
  header: string,
): PaymentSignaturePayload {
  let decoded: unknown;
  try {
    decoded = decodeJsonBase64(header);
  } catch (error) {
    throw new Error(
      `Invalid ${PAYMENT_SIGNATURE_HEADER} header: ${describeError(error)}`,
    );
  }

  return parsePaymentSignaturePayload(decoded);
}

export function parsePaymentSignaturePayload(
  value: unknown,
): PaymentSignaturePayload {
  const record = requireRecord(value, "payload");

  if (record.x402Version !== 2) {
    throw new Error("x402Version must be 2");
  }

  if (!isRecord(record.accepted) || record.accepted.scheme !== "exact") {
    throw new Error("accepted exact payment requirement is required");
  }

  const payloadValue = requireRecord(record.payload, "payload");
  const signature = requireHexString(payloadValue.signature, "payload.signature");
  const authorization = parseTransferAuthorization(
    payloadValue.authorization,
    "payload.authorization",
  );

  // The optional fee leg (fee-collection Phase 2/3): both fields must appear
  // together to be usable. A lone one (or neither) means single-auth — the
  // server accepts that indefinitely and records the fee only (MR-1007).
  const hasFeeLeg =
    payloadValue.feeAuthorization !== undefined &&
    payloadValue.feeSignature !== undefined;
  const feeAuthorization = hasFeeLeg
    ? parseTransferAuthorization(
        payloadValue.feeAuthorization,
        "payload.feeAuthorization",
      )
    : undefined;
  const feeSignature = hasFeeLeg
    ? requireHexString(payloadValue.feeSignature, "payload.feeSignature")
    : undefined;

  return {
    x402Version: 2,
    resource: isRecord(record.resource)
      ? {
          url: optionalString(record.resource.url),
          description: optionalString(record.resource.description),
          mimeType: optionalString(record.resource.mimeType),
        }
      : undefined,
    accepted: {
      ...record.accepted,
      scheme: "exact",
      network: requireString(record.accepted.network, "accepted.network"),
      amount: requirePaymentAmountString(record.accepted.amount, "accepted.amount"),
      asset: optionalString(record.accepted.asset),
      assetAddress: optionalAddress(
        record.accepted.assetAddress,
        "accepted.assetAddress",
      ),
      payTo: optionalAddress(record.accepted.payTo, "accepted.payTo"),
      destination: optionalAddress(
        record.accepted.destination,
        "accepted.destination",
      ),
    },
    payload: {
      signature,
      authorization,
      ...(feeAuthorization !== undefined && { feeAuthorization }),
      ...(feeSignature !== undefined && { feeSignature }),
    },
    extensions: isRecord(record.extensions) ? record.extensions : undefined,
  };
}

export function parseTransferAuthorization(
  value: unknown,
  fieldName: string,
): TransferAuthorization {
  const record = requireRecord(value, fieldName);

  return {
    from: requireAddress(record.from, `${fieldName}.from`),
    to: requireAddress(record.to, `${fieldName}.to`),
    value: requireDecimalString(record.value, `${fieldName}.value`),
    validAfter: requireDecimalString(record.validAfter, `${fieldName}.validAfter`),
    validBefore: requireDecimalString(
      record.validBefore,
      `${fieldName}.validBefore`,
    ),
    nonce: requireBytes32(record.nonce, `${fieldName}.nonce`),
  };
}

/**
 * Validates a parsed PAYMENT-SIGNATURE payload against a payment requirement.
 * Returns a human-readable reason when the payload does not satisfy the
 * requirement, or null when it matches. Cryptographic signature verification
 * is separate — see verifyTransferAuthorizationSignature.
 */
export function validatePaymentSignatureAgainstRequirement(
  paymentPayload: PaymentSignaturePayload,
  requirement: PaymentAccept,
  now: Date = new Date(),
): string | null {
  if (paymentPayload.resource?.url !== requirement.resource) {
    return "PAYMENT-SIGNATURE resource does not match the payment requirement.";
  }

  if (paymentPayload.accepted.network !== requirement.network) {
    return "PAYMENT-SIGNATURE network does not match the payment requirement.";
  }

  if (
    paymentPayload.accepted.chainId &&
    paymentPayload.accepted.chainId !== requirement.chainId
  ) {
    return "PAYMENT-SIGNATURE chain id does not match the payment requirement.";
  }

  const acceptedAsset =
    paymentPayload.accepted.assetAddress ?? paymentPayload.accepted.asset;
  if (
    acceptedAsset &&
    acceptedAsset !== requirement.asset &&
    !addressesEqual(acceptedAsset, requirement.assetAddress)
  ) {
    return "PAYMENT-SIGNATURE asset does not match the payment requirement.";
  }

  const acceptedPayTo =
    paymentPayload.accepted.payTo ?? paymentPayload.accepted.destination;
  if (!acceptedPayTo || !addressesEqual(acceptedPayTo, requirement.destination)) {
    return "PAYMENT-SIGNATURE destination does not match the payment requirement.";
  }

  if (
    paymentPayload.accepted.amount !== requirement.maxAmountRequired &&
    paymentPayload.accepted.amount !== requirement.amount
  ) {
    return "PAYMENT-SIGNATURE amount does not match the payment requirement.";
  }

  const authorization = paymentPayload.payload.authorization;
  if (!addressesEqual(authorization.to, requirement.destination)) {
    return "PAYMENT-SIGNATURE authorization recipient does not match the payment requirement.";
  }

  if (authorization.value !== requirement.maxAmountRequired) {
    return "PAYMENT-SIGNATURE authorization amount does not match the payment requirement.";
  }

  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  if (BigInt(authorization.validAfter) > nowSeconds) {
    return "PAYMENT-SIGNATURE authorization is not valid yet.";
  }

  if (BigInt(authorization.validBefore) <= nowSeconds) {
    return "PAYMENT-SIGNATURE authorization has expired.";
  }

  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "malformed payload";
}
