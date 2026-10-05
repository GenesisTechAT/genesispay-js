import {
  GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
  decodePaymentRequiredHeader,
  decodeSettlementResponseHeader,
  encodePaymentSignatureHeader,
  encodeSettlementPrepareParamsHeader,
} from "@genesis-tech/genesispay-protocol";
import type {
  PaymentSignaturePayload,
  SettlementResponsePayload,
} from "@genesis-tech/genesispay-protocol";
import { describe, expect, it, vi } from "vitest";

import { createPaymentGate } from "./payment-gate.js";
import type {
  PlanAwareVerifySettlement,
  SettlementContext,
  SettlementVerification,
} from "./payment-gate.js";

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

  it("advertises and proxies exact settlement preparation before signing", async () => {
    const authority = {
      sellerNonce: `0x${"11".repeat(32)}` as const,
      feeNonce: null,
      validBefore: "9999999999",
    };
    const prepare = vi.fn().mockResolvedValue({
      settlementPlan: {
        planId: "11111111-1111-4111-8111-111111111111",
        sellerAuthorization: {
          from: PAYER,
          to: PAY_TO,
          value: "5000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"11".repeat(32)}`,
        },
        feeAuthorization: null,
      },
    });
    const verify = Object.assign(
      vi.fn(async () => ({ ok: true as const, settlement })),
      { prepare },
    ) satisfies PlanAwareVerifySettlement;
    const handler = makeGate().wrap(async () => Response.json({}), {
      verifySettlement: verify,
    });

    const challenge = await handler(new Request(RESOURCE));
    expect(challenge.headers.get("GENESISPAY-Settlement-Prepare")).toBe(
      RESOURCE,
    );
    expect(challenge.headers.get("GENESISPAY-Settlement-Version")).toBe("1");

    const response = await handler(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "GENESISPAY-Settlement-Prepare": "1",
        },
        body: JSON.stringify({ payer: PAYER, idempotencyKey: "purchase-42", authority }),
      }),
    );
    expect(response.status).toBe(201);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        payer: PAYER,
        idempotencyKey: "purchase-42",
        authority,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      settlementPlan: {
        planId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("rejects malformed prepared authority before calling the verifier", async () => {
    const prepare = vi.fn();
    const verify = Object.assign(
      vi.fn(async () => ({ ok: true as const, settlement })),
      { prepare },
    ) satisfies PlanAwareVerifySettlement;
    const handler = makeGate().wrap(async () => Response.json({}), {
      verifySettlement: verify,
    });
    const response = await handler(new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "GENESISPAY-Settlement-Prepare": "1",
      },
      body: JSON.stringify({
        payer: PAYER,
        authority: { sellerNonce: "0x12", feeNonce: null, validBefore: "1" },
      }),
    }));
    expect(response.status).toBe(422);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("MR-1011: reads prepare params from the header and leaves the purchase body opaque", async () => {
    const authority = {
      sellerNonce: `0x${"11".repeat(32)}` as const,
      feeNonce: null,
      validBefore: "9999999999",
    };
    const prepare = vi.fn().mockResolvedValue({
      settlementPlan: {
        planId: "11111111-1111-4111-8111-111111111111",
        sellerAuthorization: {
          from: PAYER,
          to: PAY_TO,
          value: "5000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"11".repeat(32)}`,
        },
        feeAuthorization: null,
      },
    });
    const verify = Object.assign(
      vi.fn(async () => ({ ok: true as const, settlement })),
      { prepare },
    ) satisfies PlanAwareVerifySettlement;
    const inner = vi.fn(async () => Response.json({}));
    const handler = makeGate().wrap(inner, { verifySettlement: verify });

    const response = await handler(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "GENESISPAY-Settlement-Prepare": "1",
          [GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER]: encodeSettlementPrepareParamsHeader({
            payer: PAYER,
            idempotencyKey: "purchase-42",
            feeMode: "record_only",
            authority,
          }),
        },
        // The purchase body, which also happens to look like legacy params
        // naming another payer: header mode must never read it.
        body: JSON.stringify({ payer: PAY_TO, idempotencyKey: "body-key", horizon: "7d" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith({
      payer: PAYER,
      idempotencyKey: "purchase-42",
      requirement: expect.objectContaining({ resource: RESOURCE }),
      authority,
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it("refuses a present but malformed prepare params header before calling the verifier", async () => {
    const prepare = vi.fn();
    const verify = Object.assign(
      vi.fn(async () => ({ ok: true as const, settlement })),
      { prepare },
    ) satisfies PlanAwareVerifySettlement;
    const handler = makeGate().wrap(async () => Response.json({}), {
      verifySettlement: verify,
    });

    for (const value of [
      "",
      "not base64!",
      btoa(JSON.stringify({ payer: PAYER })),
      // Oversize: refused on length before any decoding.
      "A".repeat(4100),
    ]) {
      const response = await handler(
        new Request(RESOURCE, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "GENESISPAY-Settlement-Prepare": "1",
            [GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER]: value,
          },
          body: JSON.stringify({ payer: PAYER, idempotencyKey: "purchase-42" }),
        }),
      );
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("requires and forwards the plan id when the verifier supports preparation", async () => {
    const verify = Object.assign(
      vi.fn(async (context: SettlementContext) => {
        expect(context.planId).toBe(
          "11111111-1111-4111-8111-111111111111",
        );
        return { ok: true as const, settlement };
      }),
      { prepare: vi.fn() },
    ) satisfies PlanAwareVerifySettlement;
    const handler = makeGate().wrap(async () => Response.json({ paid: true }), {
      verifySettlement: verify,
    });

    expect((await handler(paidRequest())).status).toBe(426);
    const payload = makePaymentSignaturePayload();
    const response = await handler(
      new Request(RESOURCE, {
        headers: {
          "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload),
          "GENESISPAY-Settlement-Plan":
            "11111111-1111-4111-8111-111111111111",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("MR-202: forwards a planless pre-cutover txHash only for reconciliation", async () => {
    const verify = Object.assign(
      vi.fn(async (context: SettlementContext) => {
        expect(context.planId).toBeUndefined();
        return { ok: true as const, settlement };
      }),
      { prepare: vi.fn() },
    ) satisfies PlanAwareVerifySettlement;
    const handler = makeGate().wrap(async () => Response.json({ paid: true }), {
      verifySettlement: verify,
    });
    const payload = makePaymentSignaturePayload({
      extensions: { txHash: `0x${"77".repeat(32)}` },
    });

    const response = await handler(paidRequest(payload));

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
  });

  it("MR-202/MR-203/MR-1106: requirement drift after payer broadcast reconciles through its prepared snapshot", async () => {
    const verifySettlement = Object.assign(
      vi.fn(async (context: SettlementContext) => {
        expect(context.requirement.maxAmountRequired).toBe("4999");
        return {
          ok: false as const,
          outcomeUnknown: true as const,
          errorReason: "Receipt reconciliation is pending.",
          settlement: {
            ...settlement,
            success: false,
            transaction: `0x${"78".repeat(32)}`,
            extensions: {
              authorizationVerified: true,
              settlementVerified: false,
            },
          },
        };
      }),
      { prepare: vi.fn() },
    ) satisfies PlanAwareVerifySettlement;
    const handler = makeGate().wrap(async () => Response.json({ paid: true }), {
      verifySettlement,
    });
    const transactionHash = `0x${"78".repeat(32)}` as const;
    const payment = makePaymentSignaturePayload({
      extensions: { txHash: transactionHash },
      accepted: {
        scheme: "exact",
        network: "base-sepolia",
        chainId: 84532,
        assetAddress: makeGate().requirementFor(RESOURCE).assetAddress,
        amount: "4999",
        payTo: PAY_TO,
      },
    });

    const request = paidRequest(payment);
    request.headers.set(
      "GENESISPAY-Settlement-Plan",
      "11111111-1111-4111-8111-111111111111",
    );
    const response = await handler(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toMatchObject({
      success: false,
      transaction: transactionHash,
      extensions: { settlementVerified: false },
    });
    expect(verifySettlement).toHaveBeenCalledOnce();
  });

  it("MR-202/MR-203/MR-304: a custom verifier cannot receive payer-selected drift fields", async () => {
    const verifySettlement = vi.fn();
    const handler = makeGate().wrap(async () => Response.json({ paid: true }), {
      verifySettlement,
    });
    const transactionHash = `0x${"7a".repeat(32)}` as const;
    const payment = makePaymentSignaturePayload({
      extensions: { txHash: transactionHash },
      accepted: {
        scheme: "exact",
        network: "base-sepolia",
        chainId: 84532,
        assetAddress: makeGate().requirementFor(RESOURCE).assetAddress,
        amount: "1",
        payTo: "0x3333333333333333333333333333333333333333",
      },
      payload: {
        ...makePaymentSignaturePayload().payload,
        authorization: {
          ...makePaymentSignaturePayload().payload.authorization,
          to: "0x3333333333333333333333333333333333333333",
          value: "1",
        },
      },
    });
    const request = paidRequest(payment);
    request.headers.set(
      "GENESISPAY-Settlement-Plan",
      "11111111-1111-4111-8111-111111111111",
    );

    const response = await handler(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toMatchObject({ transaction: transactionHash, success: false });
    expect(verifySettlement).not.toHaveBeenCalled();
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

  it("MR-203/MR-1304: never re-challenges an unknown signed settlement", async () => {
    const handlerBody = vi.fn(async () => Response.json({ paid: true }));
    const handler = makeGate().wrap(handlerBody, {
      verifySettlement: async () => ({
        ok: false,
        outcomeUnknown: true,
        errorReason: "The accepted settlement is still being reconciled.",
        settlement: {
          ...settlement,
          success: false,
          errorReason: "Settlement pending.",
        },
      }),
    });

    const response = await handler(paidRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(response.headers.get("PAYMENT-RESPONSE")).not.toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "settlement_outcome_unknown",
    });
    expect(handlerBody).not.toHaveBeenCalled();
  });

  it("MR-203/MR-304/MR-1304: a custom verifier cannot re-challenge a known payer broadcast", async () => {
    const transactionHash = `0x${"79".repeat(32)}` as const;
    const handlerBody = vi.fn(async () => Response.json({ paid: true }));
    const handler = makeGate().wrap(handlerBody, {
      verifySettlement: async () => ({
        ok: false,
        errorReason: "The receipt provider is temporarily unavailable.",
      }),
    });

    const response = await handler(paidRequest(makePaymentSignaturePayload({
      extensions: { txHash: transactionHash },
    })));

    expect(response.status).toBe(503);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toMatchObject({
      success: false,
      transaction: transactionHash,
      extensions: { settlementVerified: false },
    });
    await expect(response.json()).resolves.toMatchObject({
      code: "settlement_outcome_unknown",
    });
    expect(handlerBody).not.toHaveBeenCalled();
  });

  it("MR-202/MR-1106: a thrown custom verifier preserves a known payer broadcast", async () => {
    const transactionHash = `0x${"7b".repeat(32)}` as const;
    const handlerBody = vi.fn(async () => Response.json({ paid: true }));
    const handler = makeGate().wrap(handlerBody, {
      verifySettlement: async () => {
        throw new Error("receipt provider unavailable");
      },
    });

    const response = await handler(paidRequest(makePaymentSignaturePayload({
      extensions: { txHash: transactionHash },
    })));

    expect(response.status).toBe(503);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toMatchObject({
      success: false,
      transaction: transactionHash,
      extensions: { settlementVerified: false },
    });
    await expect(response.json()).resolves.toMatchObject({
      code: "settlement_outcome_unknown",
    });
    expect(handlerBody).not.toHaveBeenCalled();
  });
});
