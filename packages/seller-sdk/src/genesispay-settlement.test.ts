import type {
  PaymentAccept,
  PaymentSignaturePayload,
  SettlementResponsePayload,
} from "@genesis-tech/genesispay-protocol";
import { describe, expect, it, vi } from "vitest";

import type { SettlementContext } from "./payment-gate.js";
import {
  DEFAULT_FACILITATOR_BASE_URL,
  genesisPaySettlement,
} from "./genesispay-settlement.js";

const PAY_TO = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const requirement: PaymentAccept = {
  scheme: "exact",
  network: "base-sepolia",
  chainId: 84532,
  asset: "USDC",
  assetAddress: USDC,
  amount: "0.005",
  maxAmountRequired: "5000",
  destination: PAY_TO,
  payTo: PAY_TO,
  resource: "https://api.example.com/premium",
  description: "Premium data",
  mimeType: "application/json",
  maxTimeoutSeconds: 300,
};

const context: SettlementContext = {
  request: new Request("https://api.example.com/premium"),
  paymentSignatureHeader: "payment-signature-header",
  payment: {} as PaymentSignaturePayload,
  requirement,
};

const successSettlement: SettlementResponsePayload = {
  success: true,
  transaction: `0x${"cd".repeat(32)}`,
  network: "base-sepolia",
  amount: "5000",
};

describe("genesisPaySettlement", () => {
  it("rejects missing API keys and invalid base URLs at creation time", () => {
    expect(() =>
      genesisPaySettlement({ facilitatorBaseUrl: "https://genesispay.example", apiKey: " " }),
    ).toThrow("seller API key");
    expect(() =>
      genesisPaySettlement({ facilitatorBaseUrl: "not a url", apiKey: "gp_sk_x" }),
    ).toThrow("Invalid facilitatorBaseUrl");
  });

  it("defaults to the development facilitator when facilitatorBaseUrl is omitted", async () => {
    const fetchFn = vi.fn(async () => Response.json(successSettlement));
    const verify = genesisPaySettlement({
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await verify(context);

    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_FACILITATOR_BASE_URL}/api/v1/facilitator/settle`);
  });

  it("POSTs the settle contract and returns the parsed settlement on success", async () => {
    const fetchFn = vi.fn(async () => Response.json(successSettlement));
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example/",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await verify(context);

    expect(result).toEqual({ ok: true, settlement: successSettlement });
    expect(fetchFn).toHaveBeenCalledOnce();

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://genesispay.example/api/v1/facilitator/settle");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer gp_sk_test",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      paymentSignature: "payment-signature-header",
      requirement: {
        resource: "https://api.example.com/premium",
        network: "base-sepolia",
        chainId: 84532,
        assetAddress: USDC,
        amountUsdcMinor: "5000",
        payTo: PAY_TO,
        description: "Premium data",
      },
    });
  });

  it("returns the facilitator errorReason when settlement fails", async () => {
    const failed: SettlementResponsePayload = {
      success: false,
      transaction: "",
      network: "base-sepolia",
      errorReason: "Authorization has expired.",
    };
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: (async () => Response.json(failed, { status: 402 })) as typeof fetch,
    });

    const result = await verify(context);

    expect(result).toEqual({
      ok: false,
      errorReason: "Authorization has expired.",
      settlement: failed,
    });
  });

  it("surfaces plain error bodies (auth failures, facilitator not configured)", async () => {
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: (async () =>
        Response.json(
          { error: "Facilitator settlement is not configured." },
          { status: 503 },
        )) as typeof fetch,
    });

    const result = await verify(context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorReason).toBe("Facilitator settlement is not configured.");
    }
  });

  it("handles unreachable facilitators and non-JSON responses", async () => {
    const unreachable = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });

    const unreachableResult = await unreachable(context);
    expect(unreachableResult.ok).toBe(false);
    if (!unreachableResult.ok) {
      expect(unreachableResult.errorReason).toContain("Failed to reach");
    }

    const nonJson = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: (async () =>
        new Response("bad gateway", { status: 502 })) as typeof fetch,
    });

    const nonJsonResult = await nonJson(context);
    expect(nonJsonResult.ok).toBe(false);
    if (!nonJsonResult.ok) {
      expect(nonJsonResult.errorReason).toContain("status 502");
    }
  });
});
