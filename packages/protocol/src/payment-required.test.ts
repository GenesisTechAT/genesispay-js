import { describe, expect, it } from "vitest";

import {
  buildPaymentRequiredPayload,
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
  parsePaymentRequiredPayload,
} from "./payment-required.js";
import type { BuildPaymentRequiredInput } from "./types.js";

const baseInput: BuildPaymentRequiredInput = {
  linkId: "demo-link",
  amount: "0.005",
  amountUsdcMinor: 5_000n,
  asset: "USDC",
  assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  chainId: 84532,
  network: "base-sepolia",
  destination: "0x1111111111111111111111111111111111111111",
  description: "GenesisPay demo payment requirement",
  resource: "https://genesispay.example/pay/demo-link",
};

describe("buildPaymentRequiredPayload", () => {
  it("builds an x402 V2 payload with defaults applied", () => {
    expect(buildPaymentRequiredPayload(baseInput)).toEqual({
      x402Version: 2,
      linkId: "demo-link",
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          chainId: 84532,
          asset: "USDC",
          assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "0.005",
          maxAmountRequired: "5000",
          destination: "0x1111111111111111111111111111111111111111",
          payTo: "0x1111111111111111111111111111111111111111",
          resource: "https://genesispay.example/pay/demo-link",
          description: "GenesisPay demo payment requirement",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
      description: "GenesisPay demo payment requirement",
      error: "Payment Required",
    });
  });

  it("accepts minor units as a decimal string and omits linkId when absent", () => {
    const payload = buildPaymentRequiredPayload({
      ...baseInput,
      linkId: undefined,
      amountUsdcMinor: "12500000",
      amount: "12.5",
    });

    expect(payload.accepts[0].maxAmountRequired).toBe("12500000");
    expect("linkId" in payload).toBe(false);
  });

  it("rejects non-positive amounts", () => {
    expect(() =>
      buildPaymentRequiredPayload({ ...baseInput, amountUsdcMinor: 0n }),
    ).toThrow("greater than zero");
  });

  it("carries the configured EIP-712 extra domain and round-trips it", () => {
    const payload = buildPaymentRequiredPayload({
      ...baseInput,
      extra: { name: "EURC", version: "2" },
    });

    expect(payload.accepts[0].extra).toEqual({ name: "EURC", version: "2" });

    const decoded = decodePaymentRequiredHeader(
      encodePaymentRequiredHeader(payload),
    );
    expect(decoded.accepts[0].extra).toEqual({ name: "EURC", version: "2" });
  });

  it("omits extra when it is not configured", () => {
    expect("extra" in buildPaymentRequiredPayload(baseInput).accepts[0]).toBe(
      false,
    );
  });
});

describe("encode/decodePaymentRequiredHeader", () => {
  it("round-trips a payload through the base64 header", () => {
    const payload = buildPaymentRequiredPayload(baseInput);
    const header = encodePaymentRequiredHeader(payload);

    expect(decodePaymentRequiredHeader(header)).toEqual(payload);
  });

  it("rejects headers that are not base64 JSON", () => {
    expect(() => decodePaymentRequiredHeader("not-base64!!!")).toThrow(
      "Invalid PAYMENT-REQUIRED header",
    );
  });
});

describe("parsePaymentRequiredPayload", () => {
  it("rejects unsupported protocol versions", () => {
    expect(() => parsePaymentRequiredPayload({ x402Version: 1 })).toThrow(
      "x402Version must be 2",
    );
  });

  it("rejects payloads without accepts entries", () => {
    expect(() =>
      parsePaymentRequiredPayload({ x402Version: 2, accepts: [] }),
    ).toThrow("accepts must be a non-empty array");
  });

  it("rejects accepts entries with a non-exact scheme", () => {
    const payload = buildPaymentRequiredPayload(baseInput);

    expect(() =>
      parsePaymentRequiredPayload({
        ...payload,
        accepts: [{ ...payload.accepts[0], scheme: "upto" }],
      }),
    ).toThrow('accepts[0].scheme must be "exact"');
  });

  it("rejects accepts entries without a destination", () => {
    const payload = buildPaymentRequiredPayload(baseInput);
    const { destination, payTo, ...rest } = payload.accepts[0];
    void destination;
    void payTo;

    expect(() =>
      parsePaymentRequiredPayload({ ...payload, accepts: [rest] }),
    ).toThrow("payTo (or destination) is required");
  });

  it("normalizes payTo/destination and fills defaults for lax payloads", () => {
    const parsed = parsePaymentRequiredPayload({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          chainId: 84532,
          asset: "USDC",
          assetAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
          amount: "0.005",
          maxAmountRequired: "5000",
          payTo: "0x1111111111111111111111111111111111111111",
          resource: "https://api.example.com/data",
        },
      ],
    });

    expect(parsed.accepts[0]).toMatchObject({
      assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      destination: "0x1111111111111111111111111111111111111111",
      payTo: "0x1111111111111111111111111111111111111111",
      mimeType: "application/json",
      maxTimeoutSeconds: 300,
      description: "",
    });
    expect(parsed.error).toBe("Payment Required");
  });

  it("rejects malformed minor-unit amounts", () => {
    const payload = buildPaymentRequiredPayload(baseInput);

    expect(() =>
      parsePaymentRequiredPayload({
        ...payload,
        accepts: [{ ...payload.accepts[0], maxAmountRequired: "0.005" }],
      }),
    ).toThrow("decimal integer string");
  });
});

describe("optional fee block (fee-collection Phase 2/3, additive)", () => {
  const fee = {
    feeMinor: "50",
    treasury: "0x000000000000000000000000000000000000fee1" as const,
    assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
    chainId: 84532,
  };

  it("round-trips a well-formed fee block through encode/decode", () => {
    const payload = buildPaymentRequiredPayload({ ...baseInput, fee });
    const decoded = decodePaymentRequiredHeader(encodePaymentRequiredHeader(payload));

    // requireAddress checksums the address on parse, so compare case-insensitively.
    expect(decoded.accepts[0].fee?.feeMinor).toBe(fee.feeMinor);
    expect(decoded.accepts[0].fee?.chainId).toBe(fee.chainId);
    expect(decoded.accepts[0].fee?.treasury?.toLowerCase()).toBe(fee.treasury);
    expect(decoded.accepts[0].fee?.assetAddress?.toLowerCase()).toBe(
      fee.assetAddress.toLowerCase(),
    );
  });

  it("omits the fee block entirely when not provided (byte-identical to before)", () => {
    const payload = buildPaymentRequiredPayload(baseInput);
    expect(payload.accepts[0]).not.toHaveProperty("fee");
  });

  it("tolerates a malformed fee block from a foreign payload — parses without it", () => {
    const parsed = parsePaymentRequiredPayload({
      x402Version: 2,
      accepts: [
        {
          ...buildPaymentRequiredPayload(baseInput).accepts[0],
          fee: { feeMinor: "not-a-number", treasury: "0xbad" },
        },
      ],
      description: "",
      error: "Payment Required",
    });

    expect(parsed.accepts[0]).not.toHaveProperty("fee");
  });
});

describe("optional product block (catalogue slice, additive)", () => {
  const product = { productId: "prod_abc123", sku: "EBOOK-01", quantity: 1 as const };

  it("round-trips a well-formed product block through encode/decode", () => {
    const payload = buildPaymentRequiredPayload({ ...baseInput, product });
    const decoded = decodePaymentRequiredHeader(encodePaymentRequiredHeader(payload));

    expect(decoded.accepts[0].product).toEqual(product);
  });

  it("omits the product block entirely when not provided (byte-identical to before)", () => {
    const payload = buildPaymentRequiredPayload(baseInput);

    expect(payload.accepts[0]).not.toHaveProperty("product");
  });

  it("round-trips a null sku", () => {
    const payload = buildPaymentRequiredPayload({
      ...baseInput,
      product: { productId: "prod_abc123", sku: null, quantity: 1 },
    });
    const decoded = decodePaymentRequiredHeader(encodePaymentRequiredHeader(payload));

    expect(decoded.accepts[0].product).toEqual({
      productId: "prod_abc123",
      sku: null,
      quantity: 1,
    });
  });

  it("tolerates a malformed product block from a foreign payload — parses without it", () => {
    // Advisory means advisory: a client that cannot read the block pays
    // normally, minus the catalogue hint. It must never throw.
    for (const bad of [
      { productId: "" },
      { productId: 42, quantity: 1 },
      { sku: "EBOOK-01", quantity: 1 },
      "prod_abc123",
      ["prod_abc123"],
    ]) {
      const parsed = parsePaymentRequiredPayload({
        x402Version: 2,
        accepts: [
          {
            ...buildPaymentRequiredPayload(baseInput).accepts[0],
            product: bad,
          },
        ],
        description: "",
        error: "Payment Required",
      });

      expect(parsed.accepts[0]).not.toHaveProperty("product");
    }
  });

  it("refuses to round-trip a quantity other than 1", () => {
    // Quantity is fixed by decision. A foreign block claiming 3 is not ours,
    // and must not survive the parse as though it were.
    const parsed = parsePaymentRequiredPayload({
      x402Version: 2,
      accepts: [
        {
          ...buildPaymentRequiredPayload(baseInput).accepts[0],
          product: { productId: "prod_abc123", sku: null, quantity: 3 },
        },
      ],
      description: "",
      error: "Payment Required",
    });

    expect(parsed.accepts[0]).not.toHaveProperty("product");
  });
});
