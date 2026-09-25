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
  planId: "11111111-1111-4111-8111-111111111111",
};

const successSettlement: SettlementResponsePayload = {
  success: true,
  transaction: `0x${"cd".repeat(32)}`,
  network: "base-sepolia",
  amount: "5000",
  extensions: {
    authorizationVerified: true,
    settlementVerified: true,
  },
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
      planId: "11111111-1111-4111-8111-111111111111",
      paymentSignature: "payment-signature-header",
      requirement: {
        resource: "https://api.example.com/premium",
        network: "base-sepolia",
        chainId: 84532,
        assetAddress: USDC,
        amountUsdcMinor: "5000",
        payTo: PAY_TO,
        description: "Premium data",
        maxTimeoutSeconds: 300,
      },
    });
  });

  it.each([
    ["a missing transaction hash", { transaction: "" }],
    ["an invalid transaction hash", { transaction: "0x1234" }],
    ["the wrong network", { network: "base" }],
    ["a missing amount", { amount: undefined }],
    ["the wrong amount", { amount: "4999" }],
    ["a missing authorization verification", {
      extensions: { settlementVerified: true },
    }],
    ["a false authorization verification", {
      extensions: { authorizationVerified: false, settlementVerified: true },
    }],
    ["a missing settlement verification", {
      extensions: { authorizationVerified: true },
    }],
    ["a false settlement verification", {
      extensions: { authorizationVerified: true, settlementVerified: false },
    }],
  ] as const)(
    "MR-202/MR-1302: fails closed when synchronous success contains %s",
    async (_label, override) => {
      const response = { ...successSettlement, ...override };
      const verify = genesisPaySettlement({
        facilitatorBaseUrl: "https://genesispay.example",
        apiKey: "gp_sk_test",
        fetchFn: vi.fn(async () => Response.json(response)) as unknown as typeof fetch,
      });

      await expect(verify(context)).resolves.toMatchObject({
        ok: false,
        outcomeUnknown: true,
        errorReason:
          "GenesisPay facilitator returned success without exact verified settlement evidence.",
      });
    },
  );

  it.each([
    ["missing", undefined],
    ["mismatched", "0x3333333333333333333333333333333333333333"],
  ] as const)(
    "MR-202/MR-1302: fails closed for a %s payer in synchronous success",
    async (_label, responsePayer) => {
      const payer = "0x2222222222222222222222222222222222222222" as const;
      const payment = {
        payload: { authorization: { from: payer } },
      } as unknown as PaymentSignaturePayload;
      const response = {
        ...successSettlement,
        ...(responsePayer ? { payer: responsePayer } : {}),
      };
      const verify = genesisPaySettlement({
        facilitatorBaseUrl: "https://genesispay.example",
        apiKey: "gp_sk_test",
        fetchFn: vi.fn(async () => Response.json(response)) as unknown as typeof fetch,
      });

      await expect(verify({ ...context, payment })).resolves.toMatchObject({
        ok: false,
        outcomeUnknown: true,
      });
    },
  );

  it("MR-202/MR-1302: accepts exact verified synchronous payer evidence", async () => {
    const payer = "0x2222222222222222222222222222222222222222" as const;
    const payment = {
      payload: { authorization: { from: payer } },
    } as unknown as PaymentSignaturePayload;
    const settlement = { ...successSettlement, payer };
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: vi.fn(async () => Response.json(settlement)) as unknown as typeof fetch,
    });

    await expect(verify({ ...context, payment })).resolves.toEqual({
      ok: true,
      settlement,
    });
  });

  it("MR-1302: never treats a 202 success-shaped body as synchronous settlement", async () => {
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: vi.fn(async () =>
        Response.json(successSettlement, { status: 202 })) as unknown as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      errorReason: "GenesisPay facilitator returned an invalid async settlement acceptance.",
    });
  });

  it.each([
    ["matching", `0x${"cd".repeat(32)}`, true],
    ["conflicting", `0x${"ab".repeat(32)}`, false],
  ] as const)(
    "MR-202/MR-203: requires a %s payer-broadcast hash in synchronous success",
    async (_label, payerHash, expectedOk) => {
      const verify = genesisPaySettlement({
        facilitatorBaseUrl: "https://genesispay.example",
        apiKey: "gp_sk_test",
        fetchFn: vi.fn(async () =>
          Response.json(successSettlement)) as unknown as typeof fetch,
      });
      const payment = {
        extensions: { txHash: payerHash },
      } as unknown as PaymentSignaturePayload;

      await expect(verify({ ...context, payment })).resolves.toMatchObject({
        ok: expectedOk,
        ...(expectedOk
          ? {}
          : {
              outcomeUnknown: true,
              settlement: { success: false, transaction: payerHash },
            }),
      });
    },
  );

  it.each(["request", "body"] as const)(
    "MR-202/MR-1106/MR-1302: bounds the initial signed settlement %s and preserves payer evidence",
    async (hang) => {
      const transaction = `0x${"a7".repeat(32)}` as const;
      const fetchFn = hang === "request"
        ? vi.fn(() => new Promise<Response>(() => undefined))
        : vi.fn(async () =>
            new Response(new ReadableStream({ start: () => undefined }), {
              headers: { "content-type": "application/json" },
            }));
      const verify = genesisPaySettlement({
        facilitatorBaseUrl: "https://genesispay.example",
        apiKey: "gp_sk_test",
        fetchFn: fetchFn as unknown as typeof fetch,
        settlementPollTimeoutMs: 25,
      });

      await expect(
        verify({
          ...context,
          payment: {
            extensions: { txHash: transaction },
          } as unknown as PaymentSignaturePayload,
        }),
      ).resolves.toMatchObject({
        ok: false,
        outcomeUnknown: true,
        settlement: {
          success: false,
          transaction,
          extensions: {
            authorizationVerified: false,
            settlementVerified: false,
          },
        },
      });
    },
  );

  it("MR-1302: polls a same-origin 202 acceptance and succeeds only after verified settlement", async () => {
    const txHash = `0x${"ef".repeat(32)}` as const;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            acceptedAt: "2026-08-30T20:00:00.000Z",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId: context.planId,
          state: "settled",
          txHash,
          settledAt: "2026-08-30T20:00:02.000Z",
          sellerTransferVerified: true,
          feeState: "not_applicable",
        }),
      );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await verify(context);

    expect(result).toMatchObject({
      ok: true,
      settlement: {
        success: true,
        transaction: txHash,
        extensions: { asyncSettlement: true, settlementVerified: true },
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
    );
  });

  it("MR-1302/MR-1304: keeps reconciling a submitted transaction after authority expiry", async () => {
    const txHash = `0x${"ef".repeat(32)}` as const;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            acceptedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 20).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ version: 1, planId: context.planId, state: "submitted", txHash }),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId: context.planId,
          state: "settled",
          txHash,
          sellerTransferVerified: true,
          feeState: "not_applicable",
        }),
      );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: true,
      settlement: { success: true, transaction: txHash },
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("MR-1302/MR-1304: stops queued polling at the acceptance expiry", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            acceptedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() - 1).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValue(
        Response.json({
          version: 1,
          planId: context.planId,
          state: "queued",
        }),
      );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
      settlementPollTimeoutMs: 150,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      errorReason: "GenesisPay async settlement is still pending.",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("MR-1302/MR-1304: preserves a submitted hash at poll timeout and warns against repayment", async () => {
    const txHash = `0x${"34".repeat(32)}` as const;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 20).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockImplementation(async () =>
        Response.json({
          version: 1,
          planId: context.planId,
          state: "submitted",
          txHash,
        }),
      );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
      settlementPollTimeoutMs: 150,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      errorReason: expect.stringMatching(
        new RegExp(`${txHash}.*Do not initiate another payment`),
      ),
      settlement: {
        success: false,
        transaction: txHash,
        extensions: {
          asyncSettlement: true,
          settlementVerified: false,
        },
      },
    });
  });

  it("MR-1302/MR-1304: preserves a submitted hash when later status polling fails", async () => {
    const txHash = `0x${"56".repeat(32)}` as const;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId: context.planId,
          state: "submitted",
          txHash,
        }),
      )
      .mockRejectedValueOnce(new Error("status endpoint unavailable"));
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      settlement: {
        success: false,
        transaction: txHash,
        extensions: {
          asyncSettlement: true,
          settlementVerified: false,
        },
      },
    });
  });

  it("MR-1302/MR-1304: bounds a never-resolving status request and preserves the submitted hash", async () => {
    const txHash = `0x${"58".repeat(32)}` as const;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId: context.planId,
          state: "submitted",
          txHash,
        }),
      )
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
      settlementPollTimeoutMs: 150,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      settlement: { transaction: txHash },
    });
  });

  it("MR-1302/MR-1304: bounds a status response whose body never completes", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 50).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start: () => undefined }), {
          headers: { "content-type": "application/json" },
        }),
      );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
      settlementPollTimeoutMs: 150,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
    });
  });

  it.each(["processing", "failed", "expired", "conflicting-submitted"])(
    "MR-202/MR-1302/MR-1304: preserves a submitted hash when a later status regresses to %s",
    async (state) => {
      const txHash = `0x${"57".repeat(32)}` as const;
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              version: 1,
              planId: context.planId,
              state: "queued",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollAfterMs: 100,
              statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
            },
            { status: 202 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            version: 1,
            planId: context.planId,
            state: "submitted",
            txHash,
          }),
        )
        .mockResolvedValueOnce(
          Response.json(
            state === "conflicting-submitted"
              ? {
                  version: 1,
                  planId: context.planId,
                  state: "submitted",
                  txHash: `0x${"58".repeat(32)}`,
                }
              : { version: 1, planId: context.planId, state },
          ),
        );
      const verify = genesisPaySettlement({
        facilitatorBaseUrl: "https://genesispay.example",
        apiKey: "gp_sk_test",
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      await expect(verify(context)).resolves.toMatchObject({
        ok: false,
        outcomeUnknown: true,
        settlement: {
          success: false,
          transaction: txHash,
          extensions: {
            asyncSettlement: true,
            settlementVerified: false,
          },
        },
      });
    },
  );

  it("MR-1302: refuses an off-origin status URL instead of leaking the seller key", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json(
        {
          version: 1,
          planId: context.planId,
          state: "queued",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          pollAfterMs: 100,
          statusUrl: "https://attacker.example/status",
        },
        { status: 202 },
      ),
    );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      errorReason: expect.stringContaining("invalid async settlement acceptance"),
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("MR-202/MR-1106: preserves payer-broadcast H when a 202 acceptance is invalid", async () => {
    const transaction = `0x${"9a".repeat(32)}` as const;
    const fetchFn = vi.fn(async () =>
      Response.json(
        {
          version: 1,
          state: "queued",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          pollAfterMs: 100,
          statusUrl: "https://attacker.example/status",
        },
        { status: 202 },
      ),
    );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(
      verify({
        ...context,
        payment: {
          extensions: { txHash: transaction },
        } as unknown as PaymentSignaturePayload,
      }),
    ).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      errorReason: expect.stringContaining("invalid async settlement acceptance"),
      settlement: {
        success: false,
        transaction,
        extensions: {
          authorizationVerified: false,
          settlementVerified: false,
        },
      },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each(["poll_transport_loss", "terminal_before_server_hash"] as const)(
    "MR-202/MR-1106: preserves payer-broadcast H through valid 202 %s",
    async (failure) => {
      const transaction = `0x${"9b".repeat(32)}` as const;
      const acceptance = Response.json(
        {
          version: 1,
          planId: context.planId,
          state: "queued",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          pollAfterMs: 100,
          statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
        },
        { status: 202 },
      );
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(acceptance);
      if (failure === "poll_transport_loss") {
        fetchFn.mockRejectedValueOnce(new Error("status response lost"));
      } else {
        fetchFn.mockResolvedValueOnce(
          Response.json({
            version: 1,
            planId: context.planId,
            state: "failed",
          }),
        );
      }
      const verify = genesisPaySettlement({
        facilitatorBaseUrl: "https://genesispay.example",
        apiKey: "gp_sk_test",
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      await expect(
        verify({
          ...context,
          payment: {
            extensions: { txHash: transaction },
          } as unknown as PaymentSignaturePayload,
        }),
      ).resolves.toMatchObject({
        ok: false,
        outcomeUnknown: true,
        settlement: {
          success: false,
          transaction,
          extensions: {
            authorizationVerified: false,
            settlementVerified: false,
            asyncSettlement: true,
          },
        },
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it("MR-103/MR-202/MR-1302: rejects a 202 acceptance bound to another plan", async () => {
    const otherPlanId = "22222222-2222-4222-8222-222222222222";
    const fetchFn = vi.fn(async () =>
      Response.json(
        {
          version: 1,
          planId: otherPlanId,
          state: "queued",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          pollAfterMs: 100,
          statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${otherPlanId}`,
        },
        { status: 202 },
      ),
    );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      errorReason: expect.stringContaining("invalid async settlement acceptance"),
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("MR-103/MR-202/MR-1302: never credits a settled status for another plan", async () => {
    const otherPlanId = "22222222-2222-4222-8222-222222222222";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId: context.planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 100,
            statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId: otherPlanId,
          state: "settled",
          txHash: `0x${"ac".repeat(32)}`,
          sellerTransferVerified: true,
        }),
      );
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      errorReason: expect.stringContaining("invalid plan contract"),
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
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

  it("MR-202/MR-1106: defensively treats any failed settlement with a transaction locator as outcome-unknown", async () => {
    const transaction = `0x${"89".repeat(32)}` as const;
    const failed: SettlementResponsePayload = {
      success: false,
      transaction,
      network: "base-sepolia",
      amount: "5000",
      errorReason: "Settlement evidence is being reconciled.",
    };
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: (async () => Response.json(failed, { status: 409 })) as typeof fetch,
    });

    await expect(verify(context)).resolves.toEqual({
      ok: false,
      outcomeUnknown: true,
      errorReason: failed.errorReason,
      settlement: failed,
    });
  });

  it("MR-202/MR-1106: a bare pre-auth facilitator refusal cannot re-challenge a payer-broadcast request", async () => {
    const transaction = `0x${"8a".repeat(32)}` as const;
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: (async () => Response.json(
        { error: "Seller API key is no longer valid." },
        { status: 401 },
      )) as typeof fetch,
    });

    await expect(verify({
      ...context,
      payment: {
        extensions: { txHash: transaction },
      } as unknown as PaymentSignaturePayload,
    })).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      settlement: {
        success: false,
        transaction,
        extensions: { settlementVerified: false },
      },
    });
  });

  it("MR-203/MR-1302: treats a lost settle response as outcome-unknown", async () => {
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: (async () => {
        throw new Error("response lost after request write");
      }) as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      errorReason: expect.stringContaining("response lost"),
    });
  });

  it("MR-203/MR-1302: replays an accepted expired plan through status", async () => {
    const txHash = `0x${"88".repeat(32)}` as const;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        version: 1,
        planId: context.planId,
        state: "queued",
        acceptedAt: "2026-08-30T20:00:00.000Z",
        expiresAt: "2026-08-30T20:05:00.000Z",
        pollAfterMs: 100,
        statusUrl: `https://genesispay.example/api/v1/facilitator/settlements/${context.planId}`,
      }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({
        version: 1,
        planId: context.planId,
        state: "settled",
        txHash,
        sellerTransferVerified: true,
        feeState: "not_applicable",
      }));
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(verify(context)).resolves.toMatchObject({
      ok: true,
      settlement: { transaction: txHash },
    });
  });

  it("forwards exact caller authority unchanged to facilitator preparation", async () => {
    const prepared = {
      planId: "11111111-1111-4111-8111-111111111111",
      authorization: {
        from: PAY_TO,
        to: PAY_TO,
        value: "5000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"11".repeat(32)}`,
      },
    };
    const fetchFn = vi.fn(async () => Response.json(prepared, { status: 201 }));
    const verify = genesisPaySettlement({
      facilitatorBaseUrl: "https://genesispay.example",
      apiKey: "gp_sk_test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const authority = {
      sellerNonce: `0x${"11".repeat(32)}` as const,
      feeNonce: null,
      validBefore: "9999999999",
    };

    await verify.prepare?.({
      payer: PAY_TO,
      idempotencyKey: "purchase-42",
      requirement,
      authority,
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://genesispay.example/api/v1/facilitator/settlement-plans");
    expect(JSON.parse(init.body as string)).toMatchObject({
      idempotencyKey: "purchase-42",
      payer: PAY_TO,
      authority,
      requirement: { maxTimeoutSeconds: 300 },
    });
  });

  it.each(["request", "body"] as const)(
    "MR-1302/MR-1304: bounds a never-resolving preparation %s",
    async (hang) => {
      const fetchFn = hang === "request"
        ? vi.fn(() => new Promise<Response>(() => undefined))
        : vi.fn(async () =>
            new Response(new ReadableStream({ start: () => undefined }), {
              headers: { "content-type": "application/json" },
            }));
      const verify = genesisPaySettlement({
        facilitatorBaseUrl: "https://genesispay.example",
        apiKey: "gp_sk_test",
        fetchFn: fetchFn as unknown as typeof fetch,
        settlementPollTimeoutMs: 25,
      });

      await expect(verify.prepare?.({
        payer: PAY_TO,
        idempotencyKey: "purchase-stalled-preparation",
        requirement,
      })).rejects.toThrow("settlement polling deadline exceeded");

      const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    },
  );

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
