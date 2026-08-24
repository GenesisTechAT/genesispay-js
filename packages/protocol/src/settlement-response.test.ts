import { describe, expect, it } from "vitest";

import {
  buildSettlementResponse,
  decodeSettlementResponseHeader,
  encodeSettlementResponseHeader,
  parseSettlementResponsePayload,
} from "./settlement-response.js";

describe("buildSettlementResponse", () => {
  it("fills the transaction with an empty string by default", () => {
    expect(
      buildSettlementResponse({
        success: false,
        network: "base-sepolia",
        errorReason: "PAYMENT-SIGNATURE header is required.",
      }),
    ).toEqual({
      success: false,
      transaction: "",
      network: "base-sepolia",
      errorReason: "PAYMENT-SIGNATURE header is required.",
    });
  });

  it("carries settlement details through", () => {
    expect(
      buildSettlementResponse({
        success: true,
        network: "base-sepolia",
        transaction: `0x${"ab".repeat(32)}`,
        amount: "5000",
        payer: "0x2222222222222222222222222222222222222222",
        paymentAttemptId: "attempt-1",
        extensions: { settled: true },
      }),
    ).toEqual({
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
      network: "base-sepolia",
      amount: "5000",
      payer: "0x2222222222222222222222222222222222222222",
      paymentAttemptId: "attempt-1",
      extensions: { settled: true },
    });
  });
});

describe("encode/decodeSettlementResponseHeader", () => {
  it("round-trips a payload through the base64 header", () => {
    const payload = buildSettlementResponse({
      success: true,
      network: "base-sepolia",
      transaction: `0x${"cd".repeat(32)}`,
      payer: "0x2222222222222222222222222222222222222222",
    });
    const header = encodeSettlementResponseHeader(payload);

    expect(decodeSettlementResponseHeader(header)).toEqual(payload);
  });

  it("rejects headers that are not base64 JSON", () => {
    expect(() => decodeSettlementResponseHeader("@@@")).toThrow(
      "Invalid PAYMENT-RESPONSE header",
    );
  });
});

describe("parseSettlementResponsePayload", () => {
  it("rejects a missing success flag", () => {
    expect(() =>
      parseSettlementResponsePayload({ transaction: "", network: "base-sepolia" }),
    ).toThrow("success must be a boolean");
  });

  it("rejects a missing transaction field", () => {
    expect(() =>
      parseSettlementResponsePayload({ success: true, network: "base-sepolia" }),
    ).toThrow("transaction must be a string");
  });

  it("rejects a missing network", () => {
    expect(() =>
      parseSettlementResponsePayload({ success: true, transaction: "" }),
    ).toThrow("network must be a non-empty string");
  });

  it("rejects invalid payer addresses", () => {
    expect(() =>
      parseSettlementResponsePayload({
        success: true,
        transaction: "",
        network: "base-sepolia",
        payer: "0x1234",
      }),
    ).toThrow("payer must be an EVM address");
  });
});
