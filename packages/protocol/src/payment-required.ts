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
  EvmAddress,
  PaymentAccept,
  PaymentAcceptExtra,
  PaymentFee,
  PaymentProduct,
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
        ...(input.fee !== undefined && { fee: input.fee }),
        ...(input.product !== undefined && { product: input.product }),
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
  const fee = optionalPaymentFee(record.fee);
  const product = optionalPaymentProduct(record.product);

  return {
    ...(extra !== undefined && { extra }),
    ...(fee !== undefined && { fee }),
    ...(product !== undefined && { product }),
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

function optionalPaymentProduct(value: unknown): PaymentProduct | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  // Tolerate a malformed product block from a foreign 402 payload: the block
  // is advisory (the money fields are the authority), so a client that cannot
  // read it simply pays without the catalogue hint. A well-formed block
  // round-trips exactly.
  if (typeof record.productId !== "string" || record.productId.length === 0) {
    return undefined;
  }

  if (record.quantity !== 1) {
    // Quantity is FIXED at 1 by decision — a block claiming otherwise is not
    // ours and must not round-trip as if it were.
    return undefined;
  }

  const sku =
    typeof record.sku === "string" && record.sku.length > 0 ? record.sku : null;

  return { productId: record.productId, sku, quantity: 1 };
}

function optionalPaymentFee(value: unknown): PaymentFee | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  // Tolerate a malformed fee block from a foreign 402 payload: without every
  // field the fee leg is unusable, so the client silently pays single-auth (the
  // fee stays recorded-only). A well-formed block round-trips exactly.
  if (
    typeof record.feeMinor !== "string" ||
    !/^\d+$/.test(record.feeMinor) ||
    typeof record.chainId !== "number" ||
    !Number.isInteger(record.chainId) ||
    record.chainId <= 0
  ) {
    return undefined;
  }

  let treasury: EvmAddress;
  let assetAddress: EvmAddress;
  try {
    treasury = requireAddress(record.treasury, "fee.treasury");
    assetAddress = requireAddress(record.assetAddress, "fee.assetAddress");
  } catch {
    return undefined;
  }

  return { feeMinor: record.feeMinor, treasury, assetAddress, chainId: record.chainId };
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
