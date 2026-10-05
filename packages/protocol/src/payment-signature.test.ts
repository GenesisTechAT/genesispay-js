import { describe, expect, it } from "vitest";

import { buildPaymentRequiredPayload } from "./payment-required.js";
import {
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
  parsePaymentSignaturePayload,
  validatePaymentSignatureAgainstRequirement,
} from "./payment-signature.js";
import type {
  PaymentAccept,
  PaymentSignaturePayload,
  TransferAuthorization,
} from "./types.js";

const destination = "0x1111111111111111111111111111111111111111" as const;
const payer = "0x2222222222222222222222222222222222222222" as const;
const usdcAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const nonce = `0x${"ab".repeat(32)}` as const;
const now = new Date("2026-07-08T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

const requirement: PaymentAccept = buildPaymentRequiredPayload({
  linkId: "demo-link",
  amount: "0.005",
  amountUsdcMinor: 5_000n,
  asset: "USDC",
  assetAddress: usdcAddress,
  chainId: 84532,
  network: "base-sepolia",
  destination,
  description: "GenesisPay demo payment requirement",
  resource: "https://genesispay.example/pay/demo-link",
}).accepts[0];

function createAuthorization(
  overrides: Partial<TransferAuthorization> = {},
): TransferAuthorization {
  return {
    from: payer,
    to: destination,
    value: "5000",
    validAfter: "0",
    validBefore: String(nowSeconds + 600),
    nonce,
    ...overrides,
  };
}

function createPayload(
  overrides: {
    resourceUrl?: string;
    accepted?: Partial<PaymentSignaturePayload["accepted"]>;
    authorization?: Partial<TransferAuthorization>;
  } = {},
): PaymentSignaturePayload {
  return {
    x402Version: 2,
    resource: { url: overrides.resourceUrl ?? requirement.resource },
    accepted: {
      scheme: "exact",
      network: "base-sepolia",
      amount: "5000",
      chainId: 84532,
      assetAddress: usdcAddress,
      payTo: destination,
      ...overrides.accepted,
    },
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: createAuthorization(overrides.authorization),
    },
  };
}

describe("encode/decodePaymentSignatureHeader", () => {
  it("round-trips a payload through the base64 header", () => {
    const payload = createPayload();
    const header = encodePaymentSignatureHeader(payload);

    expect(decodePaymentSignatureHeader(header)).toEqual(payload);
  });

  it("rejects headers that are not base64 JSON", () => {
    expect(() => decodePaymentSignatureHeader("@@@")).toThrow(
      "Invalid PAYMENT-SIGNATURE header",
    );
  });
});

describe("parsePaymentSignaturePayload", () => {
  it("rejects unsupported protocol versions", () => {
    expect(() =>
      parsePaymentSignaturePayload({ ...createPayload(), x402Version: 1 }),
    ).toThrow("x402Version must be 2");
  });

  it("rejects payloads without an exact accepted requirement", () => {
    expect(() =>
      parsePaymentSignaturePayload({
        ...createPayload(),
        accepted: { scheme: "upto" },
      }),
    ).toThrow("accepted exact payment requirement is required");
  });

  it("rejects non-decimal authorization values", () => {
    expect(() =>
      parsePaymentSignaturePayload(
        createPayload({ authorization: { value: "0.005" } }),
      ),
    ).toThrow("payload.authorization.value must be a decimal integer string");
  });

  it("rejects nonces that are not 32 bytes", () => {
    expect(() =>
      parsePaymentSignaturePayload(
        createPayload({ authorization: { nonce: "0x1234" as `0x${string}` } }),
      ),
    ).toThrow("payload.authorization.nonce must be a 32-byte hex string");
  });

  it("checksums addresses while parsing", () => {
    const parsed = parsePaymentSignaturePayload({
      ...createPayload(),
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: createAuthorization({
          from: payer.toLowerCase() as `0x${string}`,
        }),
      },
    });

    expect(parsed.payload.authorization.from).toBe(payer);
  });
});

describe("validatePaymentSignatureAgainstRequirement", () => {
  it("accepts a payload matching the requirement", () => {
    expect(
      validatePaymentSignatureAgainstRequirement(createPayload(), requirement, now),
    ).toBeNull();
  });

  it("accepts the human-readable amount form", () => {
    const payload = createPayload({ accepted: { amount: "0.005" } });

    expect(
      validatePaymentSignatureAgainstRequirement(payload, requirement, now),
    ).toBeNull();
  });

  it.each([
    [
      "resource mismatch",
      createPayload({ resourceUrl: "https://evil.example/other" }),
      "resource",
    ],
    [
      "network mismatch",
      createPayload({ accepted: { network: "base" } }),
      "network",
    ],
    ["chain id mismatch", createPayload({ accepted: { chainId: 8453 } }), "chain id"],
    [
      "asset mismatch",
      createPayload({
        accepted: { assetAddress: "0x3333333333333333333333333333333333333333" },
      }),
      "asset",
    ],
    [
      "destination mismatch",
      createPayload({
        accepted: { payTo: "0x4444444444444444444444444444444444444444" },
      }),
      "destination",
    ],
    ["amount mismatch", createPayload({ accepted: { amount: "6000" } }), "amount"],
    [
      "authorization recipient mismatch",
      createPayload({
        authorization: { to: "0x4444444444444444444444444444444444444444" },
      }),
      "recipient",
    ],
    [
      "authorization amount mismatch",
      createPayload({ authorization: { value: "4999" } }),
      "authorization amount",
    ],
    [
      "not valid yet",
      createPayload({ authorization: { validAfter: String(nowSeconds + 60) } }),
      "not valid yet",
    ],
    [
      "expired",
      createPayload({ authorization: { validBefore: String(nowSeconds) } }),
      "expired",
    ],
  ])("rejects %s", (_name, payload, expectedReason) => {
    expect(
      validatePaymentSignatureAgainstRequirement(payload, requirement, now),
    ).toContain(expectedReason);
  });
});

describe("optional fee authorization slot (fee-collection Phase 2/3, additive)", () => {
  const treasury = "0x000000000000000000000000000000000000fee1" as const;

  it("round-trips a paired fee authorization + signature", () => {
    const payload: PaymentSignaturePayload = {
      ...createPayload(),
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: createAuthorization(),
        feeAuthorization: createAuthorization({ to: treasury, value: "50" }),
        feeSignature: `0x${"22".repeat(65)}`,
      },
    };

    const decoded = decodePaymentSignatureHeader(
      encodePaymentSignatureHeader(payload),
    );

    // requireAddress checksums `to` on parse; compare case-insensitively.
    expect(decoded.payload.feeAuthorization?.to?.toLowerCase()).toBe(treasury);
    expect(decoded.payload.feeAuthorization?.value).toBe("50");
    expect(decoded.payload.feeAuthorization?.nonce).toBe(nonce);
    expect(decoded.payload.feeSignature).toBe(`0x${"22".repeat(65)}`);
  });

  it("old single-auth payload parses without a fee leg (server accepts it indefinitely)", () => {
    const decoded = parsePaymentSignaturePayload(createPayload());

    expect(decoded.payload).not.toHaveProperty("feeAuthorization");
    expect(decoded.payload).not.toHaveProperty("feeSignature");
  });

  it("ignores a lone fee field (both must be present to be usable)", () => {
    const decoded = parsePaymentSignaturePayload({
      ...createPayload(),
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: createAuthorization(),
        feeAuthorization: createAuthorization({ to: treasury, value: "50" }),
        // feeSignature deliberately omitted
      },
    });

    expect(decoded.payload).not.toHaveProperty("feeAuthorization");
  });
});
