import { getAddress, isAddress } from "viem";

import type { EvmAddress, HexString } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }

  return value;
}

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requireDecimalString(value: unknown, fieldName: string): string {
  const text = requireString(value, fieldName);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${fieldName} must be a decimal integer string`);
  }

  return text;
}

export function requirePaymentAmountString(
  value: unknown,
  fieldName: string,
): string {
  const text = requireString(value, fieldName);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new Error(`${fieldName} must be a decimal amount string`);
  }

  return text;
}

export function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return value;
}

export function optionalPositiveInteger(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requirePositiveInteger(value, fieldName);
}

export function requireHexString(value: unknown, fieldName: string): HexString {
  const text = requireString(value, fieldName);
  if (!/^0x[0-9a-fA-F]+$/.test(text)) {
    throw new Error(`${fieldName} must be a hex string`);
  }

  return text as HexString;
}

export function requireBytes32(value: unknown, fieldName: string): HexString {
  const text = requireHexString(value, fieldName);
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }

  return text;
}

export function requireAddress(value: unknown, fieldName: string): EvmAddress {
  const text = requireString(value, fieldName);
  if (!isAddress(text)) {
    throw new Error(`${fieldName} must be an EVM address`);
  }

  return getAddress(text);
}

export function optionalAddress(
  value: unknown,
  fieldName: string,
): EvmAddress | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  return requireAddress(value, fieldName);
}

export function addressesEqual(left: string, right: string): boolean {
  return isAddress(left) && isAddress(right) && getAddress(left) === getAddress(right);
}
