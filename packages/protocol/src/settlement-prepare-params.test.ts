import { describe, expect, it } from "vitest";

import { encodeJsonBase64 } from "./base64-json.js";
import {
  GENESISPAY_SETTLEMENT_PREPARE_HEADER,
  GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
  SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH,
  decodeSettlementPrepareParamsHeader,
  encodeSettlementPrepareParamsHeader,
  parseSettlementPrepareParams,
  type SettlementPrepareParams,
} from "./settlement-prepare-params.js";

const PAYER = "0x2222222222222222222222222222222222222222" as const;

const params: SettlementPrepareParams = {
  payer: PAYER,
  idempotencyKey: "forecast-42",
  feeMode: "collect",
  authority: {
    sellerNonce: `0x${"11".repeat(32)}`,
    feeNonce: `0x${"22".repeat(32)}`,
    validBefore: "1790000000",
  },
};

describe("settlement prepare params header", () => {
  it("names the wire headers exactly", () => {
    expect(GENESISPAY_SETTLEMENT_PREPARE_HEADER).toBe("GENESISPAY-Settlement-Prepare");
    expect(GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER).toBe(
      "GENESISPAY-Settlement-Prepare-Params",
    );
  });

  it("round-trips full params, params without authority, and a null key", () => {
    expect(
      decodeSettlementPrepareParamsHeader(encodeSettlementPrepareParamsHeader(params)),
    ).toEqual(params);

    const minimal: SettlementPrepareParams = {
      payer: PAYER,
      idempotencyKey: null,
      feeMode: "record_only",
    };
    const decoded = decodeSettlementPrepareParamsHeader(
      encodeSettlementPrepareParamsHeader(minimal),
    );
    expect(decoded).toEqual(minimal);
    expect(decoded && "authority" in decoded).toBe(false);

    const noFeeNonce: SettlementPrepareParams = {
      ...params,
      authority: { ...params.authority!, feeNonce: null },
    };
    expect(
      decodeSettlementPrepareParamsHeader(encodeSettlementPrepareParamsHeader(noFeeNonce)),
    ).toEqual(noFeeNonce);
  });

  it("encodes as base64 JSON, the x402 header encoding", () => {
    const encoded = encodeSettlementPrepareParamsHeader(params);
    expect(JSON.parse(atob(encoded))).toEqual(params);
  });

  it("checksums the payer and drops unknown keys", () => {
    const decoded = decodeSettlementPrepareParamsHeader(
      encodeJsonBase64({
        payer: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        idempotencyKey: null,
        feeMode: "collect",
        futureField: { anything: true },
      }),
    );
    expect(decoded).toEqual({
      payer: "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
      idempotencyKey: null,
      feeMode: "collect",
    });
  });

  it("returns null for malformed base64 or JSON", () => {
    expect(decodeSettlementPrepareParamsHeader("")).toBeNull();
    expect(decodeSettlementPrepareParamsHeader("not base64!")).toBeNull();
    expect(decodeSettlementPrepareParamsHeader(" " + encodeSettlementPrepareParamsHeader(params))).toBeNull();
    expect(decodeSettlementPrepareParamsHeader(btoa("{not json"))).toBeNull();
    expect(decodeSettlementPrepareParamsHeader(btoa("[]"))).toBeNull();
    expect(decodeSettlementPrepareParamsHeader(btoa("null"))).toBeNull();
  });

  it.each([
    ["missing payer", { idempotencyKey: null, feeMode: "collect" }],
    ["non-address payer", { payer: "0x12", idempotencyKey: null, feeMode: "collect" }],
    ["missing idempotencyKey", { payer: PAYER, feeMode: "collect" }],
    ["empty idempotencyKey", { payer: PAYER, idempotencyKey: "", feeMode: "collect" }],
    [
      "overlong idempotencyKey",
      { payer: PAYER, idempotencyKey: "k".repeat(256), feeMode: "collect" },
    ],
    ["numeric idempotencyKey", { payer: PAYER, idempotencyKey: 42, feeMode: "collect" }],
    ["missing feeMode", { payer: PAYER, idempotencyKey: null }],
    ["unknown feeMode", { payer: PAYER, idempotencyKey: null, feeMode: "skip" }],
    [
      "null authority",
      { payer: PAYER, idempotencyKey: null, feeMode: "collect", authority: null },
    ],
    [
      "short sellerNonce",
      {
        ...params,
        authority: { ...params.authority, sellerNonce: "0x12" },
      },
    ],
    [
      "missing feeNonce",
      {
        ...params,
        authority: { sellerNonce: params.authority!.sellerNonce, validBefore: "1" },
      },
    ],
    [
      "numeric validBefore",
      { ...params, authority: { ...params.authority, validBefore: 1790000000 } },
    ],
    [
      "zero validBefore",
      { ...params, authority: { ...params.authority, validBefore: "0" } },
    ],
  ])("rejects %s", (_label, value) => {
    expect(decodeSettlementPrepareParamsHeader(encodeJsonBase64(value))).toBeNull();
    expect(() => parseSettlementPrepareParams(value)).toThrow();
  });

  it(`bounds the header at ${SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH} characters`, () => {
    const padded = encodeJsonBase64({
      payer: PAYER,
      idempotencyKey: null,
      feeMode: "collect",
      padding: "x".repeat(SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH),
    });
    expect(padded.length).toBeGreaterThan(SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH);
    // Valid params, but over the bound: refused before any decoding.
    expect(decodeSettlementPrepareParamsHeader(padded)).toBeNull();
    // A maximal legitimate value fits comfortably.
    expect(
      encodeSettlementPrepareParamsHeader({ ...params, idempotencyKey: "k".repeat(255) })
        .length,
    ).toBeLessThan(SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH);
  });

  it("refuses to encode invalid params", () => {
    expect(() =>
      encodeSettlementPrepareParamsHeader({
        ...params,
        feeMode: "skip" as SettlementPrepareParams["feeMode"],
      }),
    ).toThrow("feeMode");
  });
});
