/**
 * GenesisPay settlement-preparation parameters as a request header.
 *
 * Before signing, a GenesisPay-aware x402 client asks the resource to freeze
 * the whole-payment authority (MR-1011). The request carries
 * `GENESISPAY-Settlement-Prepare: 1` plus the plan parameters. Historically
 * those parameters travelled as the JSON request BODY, which made the prepare
 * request a different request from the purchase: a resource priced or
 * validated by its body could neither accept it nor recompute the purchase
 * fingerprint from it.
 *
 * Carrying the parameters in `GENESISPAY-Settlement-Prepare-Params` instead
 * lets the prepare request repeat the purchase request exactly (method, URL,
 * content type and body). The value is base64(JSON) — the same encoding as the
 * x402 headers — bounded to `SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH`
 * characters. Unknown keys are ignored and never returned, so a later additive
 * field cannot break an older resource; every known field is checked strictly.
 */

import { decodeJsonBase64, encodeJsonBase64 } from "./base64-json.js";
import { isRecord, requireAddress } from "./field-validation.js";
import type { EvmAddress, HexString } from "./types.js";

/** Marks a request as a settlement preparation; the value is always `"1"`. */
export const GENESISPAY_SETTLEMENT_PREPARE_HEADER = "GENESISPAY-Settlement-Prepare";

/** Carries the base64(JSON) `SettlementPrepareParams` of a preparation request. */
export const GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER =
  "GENESISPAY-Settlement-Prepare-Params";

/** Upper bound on the encoded header value, in characters. */
export const SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH = 4096;

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
// A uint256 has at most 78 decimal digits; `validBefore` is a positive integer.
const VALID_BEFORE_PATTERN = /^[1-9]\d{0,77}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Payer-chosen nonces and validity window the plan must reproduce exactly. */
export type SettlementPrepareAuthority = {
  sellerNonce: HexString;
  feeNonce: HexString | null;
  /** Unix seconds as a positive decimal integer string. */
  validBefore: string;
};

/** The plan parameters of one settlement-preparation request. */
export type SettlementPrepareParams = {
  payer: EvmAddress;
  /** The caller's payment-intent key, or null when the caller has none. */
  idempotencyKey: string | null;
  /** `collect` authorizes the fee leg; `record_only` signs one gross seller leg. */
  feeMode: "collect" | "record_only";
  authority?: SettlementPrepareAuthority;
};

/**
 * Validates a plain JSON value as `SettlementPrepareParams`. Throws a
 * descriptive `Error` on any structural problem; unknown keys are dropped.
 * `payer` is returned EIP-55 checksummed.
 */
export function parseSettlementPrepareParams(value: unknown): SettlementPrepareParams {
  if (!isRecord(value)) {
    throw new Error("settlement prepare params must be a JSON object");
  }

  const payer = requireAddress(value.payer, "payer");

  const idempotencyKey = value.idempotencyKey;
  if (
    idempotencyKey !== null &&
    (typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH)
  ) {
    throw new Error(
      `idempotencyKey must be null or a string of 1-${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }

  const feeMode = value.feeMode;
  if (feeMode !== "collect" && feeMode !== "record_only") {
    throw new Error('feeMode must be "collect" or "record_only"');
  }

  const authority =
    value.authority === undefined ? undefined : parseAuthority(value.authority);

  return {
    payer,
    idempotencyKey,
    feeMode,
    ...(authority !== undefined && { authority }),
  };
}

/**
 * Encodes validated params as the header value. Throws when the params are
 * invalid or the encoded value would exceed the size bound.
 */
export function encodeSettlementPrepareParamsHeader(
  params: SettlementPrepareParams,
): string {
  const encoded = encodeJsonBase64(parseSettlementPrepareParams(params));
  if (encoded.length > SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH) {
    throw new Error(
      `${GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER} exceeds ${SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH} characters`,
    );
  }

  return encoded;
}

/**
 * Decodes a received header value. Returns null for anything that is not a
 * bounded base64(JSON) encoding of valid params — a resource must refuse the
 * preparation then, never fall back to reading the body.
 */
export function decodeSettlementPrepareParamsHeader(
  value: string,
): SettlementPrepareParams | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH ||
    !BASE64_PATTERN.test(value)
  ) {
    return null;
  }

  try {
    return parseSettlementPrepareParams(decodeJsonBase64(value));
  } catch {
    return null;
  }
}

function parseAuthority(value: unknown): SettlementPrepareAuthority {
  if (!isRecord(value)) {
    throw new Error("authority must be a JSON object");
  }

  const { sellerNonce, feeNonce, validBefore } = value;
  if (typeof sellerNonce !== "string" || !BYTES32_PATTERN.test(sellerNonce)) {
    throw new Error("authority.sellerNonce must be a 32-byte hex string");
  }
  if (
    feeNonce !== null &&
    (typeof feeNonce !== "string" || !BYTES32_PATTERN.test(feeNonce))
  ) {
    throw new Error("authority.feeNonce must be null or a 32-byte hex string");
  }
  if (typeof validBefore !== "string" || !VALID_BEFORE_PATTERN.test(validBefore)) {
    throw new Error("authority.validBefore must be a positive decimal integer string");
  }

  return {
    sellerNonce: sellerNonce as HexString,
    feeNonce: feeNonce as HexString | null,
    validBefore,
  };
}
