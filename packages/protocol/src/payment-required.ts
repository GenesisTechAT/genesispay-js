import { decodeJsonBase64, encodeJsonBase64 } from "./base64-json.js";
import {
  optionalPositiveInteger,
  optionalString,
  requireAddress,
  requireDecimalString,
  requirePaymentAmountString,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from "./field-validation.js";
import type {
  BuildPaymentRequiredInput,
  PaymentAccept,
  PaymentAcceptExtra,
  PaymentRequiredPayload,
} from "./types.js";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";

const defaultPaymentMimeType = "application/json";
const defaultPaymentTimeoutSeconds = 300;

export function buildPaymentRequiredPayload(
  input: BuildPaymentRequiredInput,
): PaymentRequiredPayload {
  const amountUsdcMinor = normalizeUsdcMinorAmount(input.amountUsdcMinor);

  return {
    x402Version: 2,
    ...(input.linkId !== undefined && { linkId: input.linkId }),
    accepts: [
      {
        scheme: "exact",
        network: input.network,
        chainId: input.chainId,
        asset: input.asset,
        assetAddress: input.assetAddress,
        amount: input.amount,
        maxAmountRequired: amountUsdcMinor,
        destination: input.destination,
        payTo: input.destination,
        resource: input.resource,
        description: input.description,
        mimeType: input.mimeType ?? defaultPaymentMimeType,
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? defaultPaymentTimeoutSeconds,
        ...(input.extra !== undefined && { extra: input.extra }),
      },
    ],
    description: input.description,
    error: "Payment Required",
  };
}

export function encodePaymentRequiredHeader(
  payload: PaymentRequiredPayload,
): string {
  return encodeJsonBase64(payload);
}

export function decodePaymentRequiredHeader(
  header: string,
): PaymentRequiredPayload {
  let decoded: unknown;
  try {
    decoded = decodeJsonBase64(header);
  } catch (error) {
    throw new Error(
      `Invalid ${PAYMENT_REQUIRED_HEADER} header: ${describeError(error)}`,
    );
  }

  return parsePaymentRequiredPayload(decoded);
}

export function parsePaymentRequiredPayload(value: unknown): PaymentRequiredPayload {
  const record = requireRecord(value, "payload");

  if (record.x402Version !== 2) {
    throw new Error("x402Version must be 2");
  }

  if (!Array.isArray(record.accepts) || record.accepts.length === 0) {
    throw new Error("accepts must be a non-empty array");
  }

  const accepts = record.accepts.map((accept, index) =>
    parsePaymentAccept(accept, `accepts[${index}]`),
  ) as [PaymentAccept, ...PaymentAccept[]];

  const linkId = optionalString(record.linkId);

  return {
    x402Version: 2,
    ...(linkId !== undefined && { linkId }),
    accepts,
    description: typeof record.description === "string" ? record.description : "",
    error: typeof record.error === "string" ? record.error : "Payment Required",
  };
}

function parsePaymentAccept(value: unknown, fieldName: string): PaymentAccept {
  const record = requireRecord(value, fieldName);

  if (record.scheme !== "exact") {
    throw new Error(`${fieldName}.scheme must be "exact"`);
  }

  const destination = optionalAcceptAddress(record.destination, record.payTo);
  if (!destination) {
    throw new Error(`${fieldName}.payTo (or destination) is required`);
  }

  const extra = optionalAcceptExtra(record.extra);

  return {
    ...(extra !== undefined && { extra }),
    scheme: "exact",
    network: requireString(record.network, `${fieldName}.network`),
    chainId: requirePositiveInteger(record.chainId, `${fieldName}.chainId`),
    asset: requireString(record.asset, `${fieldName}.asset`),
    assetAddress: requireAddress(record.assetAddress, `${fieldName}.assetAddress`),
    amount: requirePaymentAmountString(record.amount, `${fieldName}.amount`),
    maxAmountRequired: requireDecimalString(
      record.maxAmountRequired,
      `${fieldName}.maxAmountRequired`,
    ),
    destination,
    payTo: destination,
    resource: requireString(record.resource, `${fieldName}.resource`),
    description: typeof record.description === "string" ? record.description : "",
    mimeType: optionalString(record.mimeType) ?? defaultPaymentMimeType,
    maxTimeoutSeconds:
      optionalPositiveInteger(
        record.maxTimeoutSeconds,
        `${fieldName}.maxTimeoutSeconds`,
      ) ?? defaultPaymentTimeoutSeconds,
  };
}

function optionalAcceptExtra(value: unknown): PaymentAcceptExtra | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const name = optionalString(record.name);
  const version = optionalString(record.version);

  // Tolerate malformed extras from foreign 402 payloads: without both fields
  // the domain hint is unusable, so callers fall back to the USDC default.
  return name !== undefined && version !== undefined
    ? { name, version }
    : undefined;
}

function optionalAcceptAddress(
  destination: unknown,
  payTo: unknown,
): PaymentAccept["destination"] | undefined {
  const candidate =
    typeof payTo === "string" && payTo.trim()
      ? payTo
      : typeof destination === "string" && destination.trim()
        ? destination
        : undefined;

  if (candidate === undefined) {
    return undefined;
  }

  return requireAddress(candidate, "accepts payTo/destination");
}

function normalizeUsdcMinorAmount(amountUsdcMinor: bigint | string): string {
  const normalizedAmount = BigInt(amountUsdcMinor);

  if (normalizedAmount <= 0n) {
    throw new Error("x402 payment amount must be greater than zero.");
  }

  return normalizedAmount.toString();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "malformed payload";
}
