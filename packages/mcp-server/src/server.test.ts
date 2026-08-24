import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentPaymentResult,
  GenesisPayDuplicatePaymentError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
  GenesisPayPolicyBlockedError,
} from "@genesis-tech/genesispay-agent";
import type { AgentAccountInfo, AgentPaymentRecord } from "@genesis-tech/genesispay-agent";
import { describe, expect, it } from "vitest";

import { createGenesisPayMcpServer } from "./server.js";
import type { GenesisPayAgentLike } from "./server.js";

function paymentRecord(
  overrides: Partial<AgentPaymentRecord> = {},
): AgentPaymentRecord {
  return {
    id: "pay_1",
    agentAccountId: "acct_1",
    resourceUrl: "https://api.example.com/premium",
    description: null,
    destinationWallet: "0x1111111111111111111111111111111111111111",
    amountUsdcMinor: "5000",
    feeUsdcMinor: "0",
    chainId: 84532,
    status: "settled",
    txHash: `0x${"ab".repeat(32)}`,
    failureReason: null,
    approvalExpiresAt: null,
    resolvedAt: null,
    settledAt: "2026-07-08T12:00:00.000Z",
    createdAt: "2026-07-08T11:59:00.000Z",
    ...overrides,
  };
}

const accountInfo: AgentAccountInfo = {
  name: "research-bot",
  walletAddress: "0x2222222222222222222222222222222222222222",
  chainId: 84532,
  status: "active",
  usdcBalance: "12500000",
  policy: {
    perPaymentCapUsdcMinor: "1000000",
    dailyCapUsdcMinor: null,
    monthlyCapUsdcMinor: null,
    allowlistEnabled: false,
  },
  spentTodayUsdcMinor: "5000",
  spentThisMonthUsdcMinor: "20000",
};

const discoveredFlight = {
  title: "Vector Air — flight bookings",
  description: "Bookings settled in USDC",
  priceUsdc: "189",
  kind: "api" as const,
  resourceUrl: "https://genesispay.example/api/demo/flights",
  category: "flights",
};

function stubAgent(overrides: Partial<GenesisPayAgentLike> = {}): GenesisPayAgentLike {
  return {
    discover: async () => [discoveredFlight],
    pay: async () =>
      new AgentPaymentResult({
        paymentId: "pay_1",
        status: "settled",
        payment: paymentRecord(),
        txHash: `0x${"ab".repeat(32)}`,
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          bodyBase64: Buffer.from(JSON.stringify({ data: "premium" })).toString(
            "base64",
          ),
          mimeType: "application/json",
        },
      }),
    paymentStatus: async () => paymentRecord(),
    account: async () => accountInfo,
    ...overrides,
  };
}

async function connectedClient(agent: GenesisPayAgentLike) {
  const server = createGenesisPayMcpServer({ agent });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return client;
}

function textContent(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> })
    .content;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe("text");
  return content[0].text;
}

describe("createGenesisPayMcpServer", () => {
  it("loads and lists the four GenesisPay tools with approval guidance", async () => {
    const client = await connectedClient(stubAgent());

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "genesispay_account",
      "genesispay_discover",
      "genesispay_pay",
      "genesispay_payment_status",
    ]);

    const payTool = tools.find((tool) => tool.name === "genesispay_pay");
    expect(payTool?.description).toContain("human approval");
    expect(payTool?.description).toContain("approvalUrl");
    expect(payTool?.inputSchema.properties).toHaveProperty("url");
    expect(payTool?.inputSchema.properties).toHaveProperty("maxAmountUsdc");
    expect(payTool?.inputSchema.properties).toHaveProperty("asset");

    const discoverTool = tools.find((tool) => tool.name === "genesispay_discover");
    expect(discoverTool?.description).toContain("genesispay_pay");
    expect(discoverTool?.inputSchema.properties).toHaveProperty("query");
  });

  it("returns discovered services with guidance to pay via genesispay_pay", async () => {
    const client = await connectedClient(stubAgent());

    const result = await client.callTool({
      name: "genesispay_discover",
      arguments: { query: "flight" },
    });

    const payload = JSON.parse(textContent(result)) as {
      count: number;
      listings: Array<{ resourceUrl: string; priceUsdc: string }>;
      instructions: string;
    };

    expect(payload.count).toBe(1);
    expect(payload.listings[0].resourceUrl).toBe(
      "https://genesispay.example/api/demo/flights",
    );
    expect(payload.listings[0].priceUsdc).toBe("189");
    expect(payload.instructions).toContain("genesispay_pay");
  });

  it("passes the optional asset through to the agent's pay call", async () => {
    const payCalls: Array<{ url: string; options: unknown }> = [];
    const stub = stubAgent();
    const client = await connectedClient({
      ...stub,
      pay: async (url, options) => {
        payCalls.push({ url, options });
        return stub.pay(url, options);
      },
    });

    await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium", asset: "USDC" },
    });

    expect(payCalls).toHaveLength(1);
    expect(payCalls[0].options).toMatchObject({ asset: "USDC" });
  });

  it("refuses an asset agent payments do not support", async () => {
    const payCalls: Array<{ url: string; options: unknown }> = [];
    const stub = stubAgent();
    const client = await connectedClient({
      ...stub,
      pay: async (url, options) => {
        payCalls.push({ url, options });
        return stub.pay(url, options);
      },
    });

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium", asset: "EURC" },
    });

    // v1 is USDC on Base. `genesispay_account` reports the USDC balance
    // specifically, so accepting EURC here would let a model check a budget it
    // is not about to spend and then be refused at signing with no way to see
    // why. Refusing in the schema says so before any money is at stake.
    expect(result.isError).toBe(true);
    expect(payCalls).toHaveLength(0);
  });

  it("MR-307: forwards a caller-supplied idempotencyKey unchanged", async () => {
    const payCalls: Array<{ url: string; options: unknown }> = [];
    const stub = stubAgent();
    const client = await connectedClient({
      ...stub,
      pay: async (url, options) => {
        payCalls.push({ url, options });
        return stub.pay(url, options);
      },
    });

    await client.callTool({
      name: "genesispay_pay",
      arguments: {
        url: "https://api.example.com/premium",
        idempotencyKey: "order-42",
      },
    });

    expect(payCalls[0].options).toMatchObject({ idempotencyKey: "order-42" });
  });

  it("MR-307: returns the effective idempotency key so a retry can reuse it", async () => {
    const payCalls: Array<{ options: unknown }> = [];
    const stub = stubAgent();
    const client = await connectedClient({
      ...stub,
      pay: async (url, options) => {
        payCalls.push({ options });
        return stub.pay(url, options);
      },
    });

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as {
      idempotencyKey?: string;
    };

    // A generated default the model never sees is exactly as useful as no
    // default: its retry would mint a second key and pay a second time.
    expect(payload.idempotencyKey).toBeTruthy();
    expect(payCalls[0].options).toMatchObject({
      idempotencyKey: payload.idempotencyKey,
    });
  });

  it("MR-307: returns the idempotency key on the failure path too", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new Error("resource timed out");
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as {
      idempotencyKey?: string;
      retryGuidance?: string;
    };

    // The failure path is precisely where the model decides whether to retry,
    // so it is the path that most needs the key.
    expect(payload.idempotencyKey).toBeTruthy();
    expect(payload.retryGuidance).toContain("same idempotencyKey");
  });

  it("MR-306: the PAY path tells the model not to buy again when the outcome is unknown", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayPaymentOutcomeUnknownError(
            "Lost the connection while the payment was in flight.",
            { paymentId: "pay_1", idempotencyKey: "order-1" },
          );
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: {
        url: "https://api.example.com/premium",
        idempotencyKey: "order-1",
      },
    });

    const payload = JSON.parse(textContent(result)) as {
      instructions?: string;
      retryGuidance?: string;
      paymentId?: string;
      idempotencyKey?: string;
    };

    // The strong instruction, on the path where the model is actually deciding
    // whether to buy again. Previously it only ever fired on the status tool,
    // and the pay path handed over the generic "pass this same idempotencyKey"
    // line — which a model reads as permission to retry.
    expect(payload.instructions).toContain("Do NOT buy this item again");
    expect(payload.retryGuidance).toBeUndefined();
    // Structured, so the model can poll instead of scraping prose.
    expect(payload.paymentId).toBe("pay_1");
    expect(payload.idempotencyKey).toBe("order-1");
  });

  it("tells the model to use a NEW key when the original attempt never signed", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayDuplicatePaymentError(
            "A payment for this idempotency key already exists.",
            {
              paymentId: "pay_1",
              payment: paymentRecord({ status: "failed", txHash: null }),
            },
          );
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: {
        url: "https://api.example.com/premium",
        idempotencyKey: "order-1",
      },
    });

    const payload = JSON.parse(textContent(result)) as {
      retryGuidance?: string;
      paymentStatus?: string;
    };

    // `failed` means nothing was signed, so the purchase can still be made —
    // but only under a new key, because the old one 409s forever. Telling the
    // model "read its status instead of retrying" here left it with no route
    // to the purchase at all and nothing explaining why.
    expect(payload.paymentStatus).toBe("failed");
    expect(payload.retryGuidance).toContain("NEW idempotencyKey");
  });

  it("tells the model NOT to retry when the original may still settle", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayDuplicatePaymentError(
            "A payment for this idempotency key already exists.",
            {
              paymentId: "pay_1",
              payment: paymentRecord({ status: "executing", txHash: null }),
            },
          );
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: {
        url: "https://api.example.com/premium",
        idempotencyKey: "order-1",
      },
    });

    const payload = JSON.parse(textContent(result)) as { retryGuidance?: string };

    expect(payload.retryGuidance).toContain("Read its status");
  });

  it("does not offer a same-key retry when the payment failed before signing", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          // The pay route answers a `failed` outcome with 502, so a status-only
          // check let this through and told the model to retry with the same
          // key — which can only ever 409, while the SDK's own docs say a
          // failed payment never moved money and is safe to retry afresh.
          throw new GenesisPayPaymentFailedError("Payment pay_1 failed: balance", {
            status: 502,
            payment: paymentRecord({ status: "failed", txHash: null }),
          });
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: {
        url: "https://api.example.com/premium",
        idempotencyKey: "order-1",
      },
    });

    const payload = JSON.parse(textContent(result)) as { retryGuidance?: string };

    expect(payload.retryGuidance).toBeUndefined();
  });

  it("does not offer a retry when the seller's endpoint was unreachable", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayPaymentRejectedError("Could not reach the target.", {
            status: 502,
            code: "target_unreachable",
          });
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: {
        url: "https://api.example.com/premium",
        idempotencyKey: "order-1",
      },
    });

    const payload = JSON.parse(textContent(result)) as { retryGuidance?: string };

    // A 502 that is still a pre-signing rejection: nothing exists to be
    // charged, so the same key would only 409.
    expect(payload.retryGuidance).toBeUndefined();
  });

  it("does not offer a retry on a hard policy block", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayPolicyBlockedError(
            "The agent account is paused.",
          );
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as { retryGuidance?: string };

    // Nothing was created, and no key makes a paused account pay. Suggesting a
    // retry sends the model round a loop that can never succeed, when the
    // remedy is to tell the user.
    expect(payload.retryGuidance).toBeUndefined();
  });

  it("MR-306: tells the model an unresolved payment may already have been charged", async () => {
    const client = await connectedClient(
      stubAgent({
        paymentStatus: async () =>
          paymentRecord({
            status: "unresolved",
            txHash: null,
            failureReason: "Target rejected the signed payment with status 500.",
          }),
      }),
    );

    const result = await client.callTool({
      name: "genesispay_payment_status",
      arguments: { paymentId: "pay_1" },
    });

    const payload = JSON.parse(textContent(result)) as {
      instructions?: string;
    };

    // This guidance is the only thing between a model that just read
    // "unresolved" and a second purchase of the same item.
    expect(payload.instructions).toContain("ALREADY HAVE BEEN CHARGED");
    expect(payload.instructions).toContain("original idempotencyKey");
  });

  it("MR-306: defines `unresolved` in the status tool's own description", async () => {
    const client = await connectedClient(stubAgent());
    const { tools } = await client.listTools();
    const statusTool = tools.find(
      (tool) => tool.name === "genesispay_payment_status",
    );

    // The description is the model's only in-band definition of the vocabulary;
    // an undefined status word is one it will guess at.
    expect(statusTool?.description).toContain("unresolved");
  });

  it("MR-307: reports a duplicate as not-paid-twice, naming the original", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayDuplicatePaymentError(
            "A payment for this idempotency key already exists.",
            { paymentId: "pay_original" },
          );
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: {
        url: "https://api.example.com/premium",
        idempotencyKey: "order-42",
      },
    });

    const payload = JSON.parse(textContent(result)) as {
      paymentId?: string;
      retryGuidance?: string;
    };

    expect(payload.paymentId).toBe("pay_original");
    expect(payload.retryGuidance).toContain("NOT paid for twice");
  });

  it("suggests retrying with different keywords when nothing matches", async () => {
    const client = await connectedClient(stubAgent({ discover: async () => [] }));

    const result = await client.callTool({
      name: "genesispay_discover",
      arguments: { query: "yoga classes" },
    });

    const payload = JSON.parse(textContent(result)) as {
      count: number;
      instructions: string;
    };

    expect(payload.count).toBe(0);
    expect(payload.instructions).toContain("No services matched");
  });

  it("returns the settled payment and resource body from genesispay_pay", async () => {
    const client = await connectedClient(stubAgent());

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as {
      status: string;
      txHash: string;
      amountUsdc: string;
      resource: { body: string };
    };

    expect(payload.status).toBe("settled");
    expect(payload.amountUsdc).toBe("0.005");
    expect(payload.resource.body).toBe(JSON.stringify({ data: "premium" }));
  });

  it("surfaces the approval URL and guidance for pending approvals", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () =>
          new AgentPaymentResult({
            paymentId: "pay_1",
            status: "pending_approval",
            payment: paymentRecord({ status: "pending_approval", txHash: null }),
            approvalUrl: "https://genesispay.example/dashboard/approvals",
          }),
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as {
      status: string;
      approvalUrl: string;
      instructions: string;
    };

    expect(payload.status).toBe("pending_approval");
    expect(payload.approvalUrl).toBe(
      "https://genesispay.example/dashboard/approvals",
    );
    expect(payload.instructions).toContain("Do NOT retry");
  });

  it("reports tool errors with isError instead of throwing", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new Error("Target responded with status 200 instead of 402.");
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/free" },
    });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("status 200 instead of 402");
  });

  it("exposes payment status and account snapshots", async () => {
    const client = await connectedClient(stubAgent());

    const status = await client.callTool({
      name: "genesispay_payment_status",
      arguments: { paymentId: "pay_1" },
    });
    expect(JSON.parse(textContent(status))).toMatchObject({
      payment: { id: "pay_1", status: "settled" },
    });

    const account = await client.callTool({
      name: "genesispay_account",
      arguments: {},
    });
    expect(JSON.parse(textContent(account))).toMatchObject({
      name: "research-bot",
      usdcBalance: "12500000",
    });
  });
});
