import { decodeJsonBase64, encodeJsonBase64 } from "./base64-json.js";
import {
  isRecord,
  optionalAddress,
  optionalString,
  requireRecord,
  requireString,
} from "./field-validation.js";
import type { SettlementResponsePayload } from "./types.js";

export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type BuildSettlementResponseInput = {
  success: boolean;
  network: string;
  transaction?: string;
  amount?: string;
  payer?: SettlementResponsePayload["payer"];
  paymentAttemptId?: string;
  errorReason?: string;
  extensions?: Record<string, unknown>;
};

export function buildSettlementResponse(
  input: BuildSettlementResponseInput,
): SettlementResponsePayload {
  return {
    success: input.success,
    transaction: input.transaction ?? "",
    network: input.network,
    amount: input.amount,
    payer: input.payer,
    paymentAttemptId: input.paymentAttemptId,
    errorReason: input.errorReason,
    extensions: input.extensions,
  };
}

export function encodeSettlementResponseHeader(
  payload: SettlementResponsePayload,
): string {
  return encodeJsonBase64(payload);
}

export function decodeSettlementResponseHeader(
  header: string,
): SettlementResponsePayload {
  let decoded: unknown;
  try {
    decoded = decodeJsonBase64(header);
  } catch (error) {
    throw new Error(
      `Invalid ${PAYMENT_RESPONSE_HEADER} header: ${describeError(error)}`,
    );
  }

  return parseSettlementResponsePayload(decoded);
}

export function parseSettlementResponsePayload(
  value: unknown,
): SettlementResponsePayload {
  const record = requireRecord(value, "payload");

  if (typeof record.success !== "boolean") {
    throw new Error("success must be a boolean");
  }

  if (typeof record.transaction !== "string") {
    throw new Error("transaction must be a string");
  }

  return {
    success: record.success,
    transaction: record.transaction,
    network: requireString(record.network, "network"),
    amount: optionalString(record.amount),
    payer: optionalAddress(record.payer, "payer"),
    paymentAttemptId: optionalString(record.paymentAttemptId),
    errorReason: optionalString(record.errorReason),
    extensions: isRecord(record.extensions) ? record.extensions : undefined,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "malformed payload";
}
