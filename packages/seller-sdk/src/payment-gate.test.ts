import {
  decodePaymentRequiredHeader,
  decodeSettlementResponseHeader,
  encodePaymentSignatureHeader,
} from "@genesis-tech/peerpay-protocol";
import type {
  PaymentSignaturePayload,
  SettlementResponsePayload,
} from "@genesis-tech/peerpay-protocol";
import { describe, expect, it, vi } from "vitest";

import { createPaymentGate } from "./payment-gate.js";
import type { SettlementContext, SettlementVerification } from "./payment-gate.js";

const PAYER = "0x2222222222222222222222222222222222222222" as const;
const PAY_TO = "0x1111111111111111111111111111111111111111" as const;
const RESOURCE = "https://api.example.com/premium";

const settlement: SettlementResponsePayload = {
  success: true,
  transaction: `0x${"ab".repeat(32)}`,
  network: "base-sepolia",
  amount: "5000",
  payer: PAYER,
};

function makeGate() {
  return createPaymentGate({
    amountUsdc: "0.005",
    payTo: PAY_TO,
    description: "Premium data",
    network: "base-sepolia",
  });
}

function makePaymentSignaturePayload(
  overrides: Partial<PaymentSignaturePayload> = {},
): PaymentSignaturePayload {
  return {
    x402Version: 2,
    resource: { url: RESOURCE },
    accepted: {
      scheme: "exact",
      network: "base-sepolia",
      amount: "5000",
      payTo: PAY_TO,
    },
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: "5000",
        validAfter: "0",
        validBefore: `${Math.floor(Date.now() / 1000) + 600}`,
        nonce: `0x${"11".repeat(32)}`,
      },
    },
    ...overrides,
  };
}

function paidRequest(payload: PaymentSignaturePayload = makePaymentSignaturePayload()) {
  return new Request(RESOURCE, {
    headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
  });
}

describe("createPaymentGate", () => {
  it("rejects invalid payTo addresses at creation time", () => {
    expect(() =>
      createPaymentGate({ amountUsdc: "0.10", payTo: "not-an-address" }),
    ).toThrow("Invalid payTo address");
  });

  it("rejects invalid amounts at creation time", () => {
    expect(() =>
      createPaymentGate({ amountUsdc: "0.1234567", payTo: PAY_TO }),
    ).toThrow("Invalid USDC amount");
  });

  it("advertises the configured EIP-712 domain as x402 extra", () => {
    const gate = createPaymentGate({
      amountUsdc: "0.005",
      payTo: PAY_TO,
      network: "base-sepolia",
      eip712Domain: { name: "USD Coin", version: "2" },
    });

    expect(gate.requirementFor(RESOURCE).extra).toEqual({
      name: "USD Coin",
      version: "2",
    });
    expect(makeGate().requirementFor(RESOURCE).extra).toBeUndefined();
  });

  it("requires a verifySettlement hook when wrapping", () => {
    const gate = makeGate();

    expect(() =>
      gate.wrap(async () => Response.json({}), {
        verifySettlement: undefined as never,
      }),
    ).toThrow("verifySettlement");
  });
});

describe("gate.wrap", () => {
  it("responds 402 with a PAYMENT-REQUIRED header when no payment is attached", async () => {
    const gate = makeGate();
    const verifySettlement = vi.fn();
    const handler = gate.wrap(async () => Response.json({ data: true }), {
      verifySettlement,
    });

    const response = await handler(
      new Request("https://api.example.com/premium?foo=bar"),
    );

    expect(response.status).toBe(402);
    expect(verifySettlement).not.toHaveBeenCalled();

    const header = response.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();

    const payload = decodePaymentRequiredHeader(header as string);
    expect(payload.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base-sepolia",
      chainId: 84532,
      amount: "0.005",
      maxAmountRequired: "5000",
      payTo: PAY_TO,
      // query string is stripped from the default resource
      resource: RESOURCE,
      description: "Premium data",
    });

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Payment Required");
  });

  it("uses the configured resource override when provided", async () => {
    const gate = createPaymentGate({
      amountUsdc: "0.005",
      payTo: PAY_TO,
      resource: "https://cdn.example.com/canonical",
    });
    const handler = gate.wrap(async () => Response.json({}), {
      verifySettlement: vi.fn(),
    });

    const response = await handler(new Request("https://api.example.com/other"));
    const payload = decodePaymentRequiredHeader(
      response.headers.get("PAYMENT-REQUIRED") as string,
    );

    expect(payload.accepts[0].resource).toBe("https://cdn.example.com/canonical");
  });

  it("responds 402 when the PAYMENT-SIGNATURE header is malformed", async () => {
    const gate = makeGate();
    const verifySettlement = vi.fn();
    const handler = gate.wrap(async () => Response.json({}), { verifySettlement });

    const response = await handler(
      new Request(RESOURCE, {
        headers: { "PAYMENT-SIGNATURE": "not-base64!!!" },
      }),
    );

    expect(response.status).toBe(402);
    expect(verifySettlement).not.toHaveBeenCalled();

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid PAYMENT-SIGNATURE header");
  });

  it("responds 402 when the payment does not match the requirement", async () => {
    const gate = makeGate();
    const verifySettlement = vi.fn();
    const handler = gate.wrap(async () => Response.json({}), { verifySettlement });

    const payload = makePaymentSignaturePayload();
    payload.payload.authorization.value = "4999";

    const response = await handler(paidRequest(payload));

    expect(response.status).toBe(402);
    expect(verifySettlement).not.toHaveBeenCalled();

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("amount does not match");
  });

  it("returns the handler result with a PAYMENT-RESPONSE header on successful settlement", async () => {
    const gate = makeGate();
    const verifySettlement = vi.fn(
      async (context: SettlementContext): Promise<SettlementVerification> => {
        expect(context.requirement.maxAmountRequired).toBe("5000");
        expect(context.payment.payload.authorization.to).toBe(PAY_TO);
        expect(context.paymentSignatureHeader).toBeTruthy();
        return { ok: true, settlement };
      },
    );
    const handler = gate.wrap(
      async () => Response.json({ data: "paid content" }, { status: 201 }),
      { verifySettlement },
    );

    const response = await handler(paidRequest());

    expect(response.status).toBe(201);
    expect(verifySettlement).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ data: "paid content" });

    const settlementHeader = response.headers.get("PAYMENT-RESPONSE");
    expect(settlementHeader).toBeTruthy();
    expect(decodeSettlementResponseHeader(settlementHeader as string)).toEqual(
      settlement,
    );
  });

  it("passes extra handler arguments through (Next.js route context)", async () => {
    const gate = makeGate();
    const handler = gate.wrap(
      async (_request, context: { params: { id: string } }) =>
        Response.json({ id: context.params.id }),
      { verifySettlement: async () => ({ ok: true, settlement }) },
    );

    const response = await handler(paidRequest(), { params: { id: "abc" } });

    expect(await response.json()).toEqual({ id: "abc" });
  });

  it("responds 402 with the failure reason when settlement fails", async () => {
    const gate = makeGate();
    const failedSettlement: SettlementResponsePayload = {
      ...settlement,
      success: false,
      errorReason: "Authorization nonce already used.",
    };
    const handler = gate.wrap(async () => Response.json({}), {
      verifySettlement: async () => ({
        ok: false,
        errorReason: "Authorization nonce already used.",
        settlement: failedSettlement,
      }),
    });

    const response = await handler(paidRequest());

    expect(response.status).toBe(402);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Authorization nonce already used.");
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toEqual(failedSettlement);
  });
});
