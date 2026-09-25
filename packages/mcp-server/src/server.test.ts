import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentPaymentResult,
  GenesisPayApiError,
  GenesisPayDuplicatePaymentError,
  GenesisPayIdempotencyConflictError,
  GenesisPayOutcomeWaitTimeoutError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
  GenesisPayPolicyBlockedError,
} from "@genesis-tech/genesispay-agent";
import type { AgentAccountInfo, AgentPaymentRecord } from "@genesis-tech/genesispay-agent";
import { readFileSync } from "node:fs";

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
  it("loads and lists the six GenesisPay tools with approval guidance", async () => {
    const client = await connectedClient(stubAgent());

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "genesispay_account",
      "genesispay_discover",
      "genesispay_pay",
      "genesispay_payment_status",
      "genesispay_shops",
      "genesispay_trending",
    ]);

    const payTool = tools.find((tool) => tool.name === "genesispay_pay");
    expect(payTool?.description).toContain("'pending_approval'");
    expect(payTool?.description).toContain("approvalUrl");
    // MR-307: the key convention is the model's only defence against a
    // second charge on retry, so the description must keep teaching it.
    expect(payTool?.description).toContain("<purpose>-<yyyymmdd>-<6 random chars>");
    expect(payTool?.description).toContain("maxAmountUsdc, asset and description");
    expect(payTool?.description).toContain("reuse exactly that key");
    expect(payTool?.description).toContain("a new key is a new purchase");
    expect(payTool?.description).toContain("'policy_blocked'");
    expect(payTool?.inputSchema.properties).toHaveProperty("url");
    expect(payTool?.inputSchema.properties).toHaveProperty("maxAmountUsdc");
    expect(payTool?.inputSchema.properties).toHaveProperty("asset");
    expect(payTool?.inputSchema.properties).toHaveProperty("description");

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

  it("reports the package.json version in the MCP handshake", async () => {
    const client = await connectedClient(stubAgent());
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(client.getServerVersion()).toMatchObject({
      name: "genesispay",
      version: manifest.version,
    });
  });

  it("MR-307: forwards the optional description as part of the purchase terms", async () => {
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
        idempotencyKey: "report-20260923-a1b2c3",
        url: "https://api.example.com/premium",
        description: "  Weekly market report  ",
      },
    });

    expect(payCalls).toHaveLength(1);
    expect(payCalls[0].options).toMatchObject({
      idempotencyKey: "report-20260923-a1b2c3",
      description: "Weekly market report",
    });
  });

  it.each(["", "   ", "x".repeat(201)])(
    "refuses an empty or over-long description before invoking the SDK (%#)",
    async (description) => {
      let calls = 0;
      const client = await connectedClient(
        stubAgent({
          pay: async () => {
            calls += 1;
            throw new Error("must not call");
          },
        }),
      );

      const result = await client.callTool({
        name: "genesispay_pay",
        arguments: {
          idempotencyKey: "report-20260923-a1b2c3",
          url: "https://api.example.com/premium",
          description,
        },
      });

      expect(result.isError).toBe(true);
      expect(calls).toBe(0);
    },
  );

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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium", asset: "USDC" },
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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium", asset: "EURC" },
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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium" },
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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium" },
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
    expect(payload.retryGuidance).toContain("was never charged and can no longer be");
    expect(payload.retryGuidance).toContain(
      "A fresh attempt needs the user's go-ahead and a NEW idempotencyKey recorded before the call.",
    );
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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as {
      retryGuidance?: string;
      instructions?: string;
      code?: string;
      httpStatus?: number;
    };

    // Nothing was created, and no key makes a paused account pay. Suggesting a
    // retry sends the model round a loop that can never succeed, when the
    // remedy is to tell the user.
    expect(payload.retryGuidance).toBeUndefined();
    expect(payload).toMatchObject({ code: "policy_blocked", httpStatus: 403 });
  });

  it("MR-502: tells the model a policy block is a stop, not an approval request", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayPolicyBlockedError(
            "Destination is not on the allowlist.",
          );
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as {
      retryGuidance?: string;
      instructions?: string;
    };

    expect(result.isError).toBe(true);
    expect(payload.instructions).toBe(
      "The account owner's spending policy blocks this payment. This is not an approval request; no retry, key change or other endpoint for the same purchase can succeed. Stop and tell the user; only the owner can change the policy on the GenesisPay dashboard.",
    );
    expect(payload.retryGuidance).toBeUndefined();
  });

  it.each(["approved", "executing"] as const)(
    "MR-306: an unknown outcome on a server-side %s row says poll, not 'may be charged'",
    async (status) => {
      const client = await connectedClient(
        stubAgent({
          pay: async () => {
            throw new GenesisPayPaymentOutcomeUnknownError("Still executing.", {
              payment: paymentRecord({ status, txHash: null }),
              idempotencyKey: "order-1",
            });
          },
        }),
      );

      const result = await client.callTool({
        name: "genesispay_pay",
        arguments: { url: "https://api.example.com/premium", idempotencyKey: "order-1" },
      });

      const payload = JSON.parse(textContent(result)) as {
        instructions?: string;
        retryGuidance?: string;
        paymentId?: string;
        paymentStatus?: string;
      };

      expect(payload.instructions).toContain("approved and is being executed by GenesisPay now");
      expect(payload.instructions).toContain("a final status (settled, unresolved or failed)");
      expect(payload.instructions).not.toContain("ALREADY HAVE BEEN CHARGED");
      expect(payload).toMatchObject({ paymentId: "pay_1", paymentStatus: status });
      expect(payload.retryGuidance).toBeUndefined();
    },
  );

  it("MR-306: an unknown outcome on an unresolved row keeps the may-be-charged warning", async () => {
    const client = await connectedClient(
      stubAgent({
        pay: async () => {
          throw new GenesisPayPaymentOutcomeUnknownError("Seller never confirmed.", {
            payment: paymentRecord({ status: "unresolved", txHash: null }),
            idempotencyKey: "order-1",
          });
        },
      }),
    );

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { url: "https://api.example.com/premium", idempotencyKey: "order-1" },
    });

    const payload = JSON.parse(textContent(result)) as {
      instructions?: string;
      retryGuidance?: string;
      paymentStatus?: string;
    };

    expect(payload.paymentStatus).toBe("unresolved");
    expect(payload.instructions).toContain("ALREADY HAVE BEEN CHARGED");
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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium" },
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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/premium" },
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
    expect(payload.instructions).toContain("HUMAN APPROVAL");
    // MR-503: approval executes server-side; the agent polls, it never pays.
    expect(payload.instructions).toContain("you never pay it yourself");
    expect(payload.instructions).toContain(
      "a NEW key requests a second payment",
    );
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
      arguments: { idempotencyKey: "test-purchase", url: "https://api.example.com/free" },
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

describe("MR-307: MCP preserves first-send purchase identity", () => {
  it.each([undefined, "", "   "])("rejects an absent saved key before invoking the SDK (%s)", async (idempotencyKey) => {
    let calls = 0;
    const client = await connectedClient(stubAgent({ pay: async () => { calls += 1; throw new Error("must not call"); } }));
    const result = await client.callTool({ name: "genesispay_pay", arguments: { url: "https://example.com/report", idempotencyKey } });
    expect(result.isError).toBe(true); expect(calls).toBe(0);
  });
  it("returns the original conflict locator without recommending a replacement key", async () => {
    const client = await connectedClient(stubAgent({ pay: async () => {
      throw new GenesisPayIdempotencyConflictError("Different request terms.", { payment: paymentRecord() });
    } }));
    const result = await client.callTool({ name: "genesispay_pay", arguments: { url: "https://example.com/report", idempotencyKey: "saved-order" } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload).toMatchObject({ code: "idempotency_conflict", idempotencyKey: "saved-order", paymentId: "pay_1", paymentStatus: "settled" });
    expect(payload.instructions).toContain("Do not change the key"); expect(payload.retryGuidance).toBeUndefined();
  });
  it("returns explicit null fulfillment on a settled replay", async () => {
    const client = await connectedClient(stubAgent({ pay: async () => new AgentPaymentResult({
      paymentId: "pay_1", status: "settled", payment: paymentRecord(), replayed: true, response: null,
    }) }));
    const result = await client.callTool({ name: "genesispay_pay", arguments: { url: "https://example.com/report", idempotencyKey: "saved-order" } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload).toMatchObject({ status: "settled", paymentId: "pay_1", idempotencyKey: "saved-order", replayed: true, resource: null });
    expect(payload.instructions).toBe(
      "Already paid earlier; nothing was charged again and the content is not re-delivered. Recover it from the seller using paymentId.",
    );
  });
  it("adds no replay instructions to a first-time settlement", async () => {
    const client = await connectedClient(stubAgent());
    const result = await client.callTool({ name: "genesispay_pay", arguments: { url: "https://example.com/report", idempotencyKey: "saved-order" } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.replayed).toBe(false);
    expect(payload.instructions).toBeUndefined();
  });
});

describe("MR-307: terminal failure recovery", () => {
  it("preserves the original failed payment locator", async () => {
    const client = await connectedClient(stubAgent({ pay: async () => {
      throw new GenesisPayPaymentFailedError("Original payment failed.", { status: 200, payment: paymentRecord({ status: "failed", txHash: null }) });
    } }));
    const result = await client.callTool({ name: "genesispay_pay", arguments: { url: "https://example.com/report", idempotencyKey: "saved-order" } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload).toMatchObject({ paymentId: "pay_1", paymentStatus: "failed", idempotencyKey: "saved-order" });
    expect(payload.retryGuidance).toBeUndefined();
  });
});

describe("MR-307: failure without a retained record", () => {
  it("keeps the saved key when an older failure omits its payment", async () => {
    const client = await connectedClient(stubAgent({ pay: async () => {
      throw new GenesisPayPaymentFailedError("No retained payment.", { status: 502 });
    } }));
    const result = await client.callTool({ name: "genesispay_pay", arguments: { url: "https://example.com/report", idempotencyKey: "saved-order" } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload).toMatchObject({ paymentId: null, paymentStatus: null, idempotencyKey: "saved-order", code: "payment_failed" });
  });
});

describe("POST purchases and the bounded outcome wait", () => {
  const RAW_BODY = '{ "horizon" : "7d" }';

  function recordingAgent(pay: GenesisPayAgentLike["pay"]) {
    const payCalls: Array<{ url: string; options: Parameters<GenesisPayAgentLike["pay"]>[1] }> = [];
    const client = connectedClient(stubAgent({
      pay: async (url, options) => {
        payCalls.push({ url, options });
        return pay(url, options);
      },
    }));
    return { client, payCalls };
  }

  it("teaches the POST rule, the body conflict and the not-confirmed outcome in the tool description", async () => {
    const client = await connectedClient(stubAgent());
    const { tools } = await client.listTools();
    const payTool = tools.find((tool) => tool.name === "genesispay_pay");

    expect(payTool?.description).toContain("When a listing says method: POST");
    expect(payTool?.description).toContain("byte-identical");
    expect(payTool?.description).toContain("'idempotency_conflict'");
    expect(payTool?.description).toContain("'not_confirmed_yet'");
    expect(payTool?.inputSchema.properties).toHaveProperty("method");
    expect(payTool?.inputSchema.properties).toHaveProperty("body");
    expect(payTool?.inputSchema.properties).toHaveProperty("contentType");
    const bodySchema = (payTool?.inputSchema.properties as Record<string, { description?: string }>).body;
    expect(bodySchema.description).toContain("byte-identical");
    expect(bodySchema.description).toContain("Never put secrets or personal data");
  });

  it("MR-307: forwards method, the untouched body and contentType, and a read-only wait of at most 30 s", async () => {
    const { client: pending, payCalls } = recordingAgent(stubAgent().pay);
    const client = await pending;

    await client.callTool({
      name: "genesispay_pay",
      arguments: {
        idempotencyKey: "forecast-20260924-a1b2c3", url: "https://api.example.com/v1/forecast",
        maxAmountUsdc: "0.05", method: "POST", body: RAW_BODY, contentType: "application/json",
      },
    });

    expect(payCalls).toHaveLength(1);
    expect(payCalls[0].options).toMatchObject({
      idempotencyKey: "forecast-20260924-a1b2c3", method: "POST", contentType: "application/json",
    });
    expect(payCalls[0].options.body).toBe(RAW_BODY);
    const wait = payCalls[0].options.waitForOutcome;
    expect(typeof wait === "object" && wait !== null ? wait.timeoutMs : undefined).toBeLessThanOrEqual(30_000);
    // waitForApproval is what executes; the MCP path must never ask for it.
    expect(payCalls[0].options.waitForApproval).toBeUndefined();
  });

  it("refuses a content type other than application/json before invoking the SDK", async () => {
    const { client: pending, payCalls } = recordingAgent(stubAgent().pay);
    const client = await pending;

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { idempotencyKey: "k-1", url: "https://api.example.com/x", method: "POST", body: "{}", contentType: "text/plain" },
    });

    expect(result.isError).toBe(true);
    expect(payCalls).toHaveLength(0);
  });

  it("MR-306: an outcome still unconfirmed after the wait says so, and never says failed", async () => {
    const client = await connectedClient(stubAgent({
      pay: async () => {
        throw new GenesisPayOutcomeWaitTimeoutError("Payment pay_1 is not confirmed yet.", {
          payment: paymentRecord({ status: "unresolved", txHash: null, settledAt: null }),
          idempotencyKey: "report-20260924-q7w8e9", waitedMs: 25_000,
        });
      },
    }));

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { idempotencyKey: "report-20260924-q7w8e9", url: "https://api.example.com/premium" },
    });

    const text = textContent(result);
    expect(result.isError).toBeFalsy();
    // "failed" appears only in the list of final statuses to poll for, never as this payment's outcome.
    expect(text.replace("(failed, denied or expired)", "")).not.toMatch(/fail/i);
    expect(JSON.parse(text)).toEqual({
      status: "unresolved",
      outcome: "not_confirmed_yet",
      paymentId: "pay_1",
      amountUsdc: "0.005",
      resourceUrl: "https://api.example.com/premium",
      idempotencyKey: "report-20260924-q7w8e9",
      instructions:
        "This payment is not confirmed yet. GenesisPay accepted it and is still waiting for its on-chain " +
        "confirmation, so the buyer MAY ALREADY HAVE BEEN CHARGED. Tell the user it is still being confirmed " +
        "and poll genesispay_payment_status with this paymentId until it reports settled or another final status " +
        "(failed, denied or expired). Never buy this item again with a new idempotencyKey — that pays a second " +
        "time; only the same key and terms may be retried.",
    });
  });

  it("reports the confirmed POST echo on a settled purchase", async () => {
    const client = await connectedClient(stubAgent({
      pay: async () => new AgentPaymentResult({
        paymentId: "pay_1", status: "settled", payment: paymentRecord(), requestMethod: "POST", bodySha256: "ab".repeat(32),
      }),
    }));

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { idempotencyKey: "k-1", url: "https://api.example.com/x", method: "POST", body: "{}" },
    });

    expect(JSON.parse(textContent(result))).toMatchObject({
      status: "settled", requestMethod: "POST", bodySha256: "ab".repeat(32),
    });
  });

  it("marks a captured 202 settlement acceptance as settled, not as pending content", async () => {
    const client = await connectedClient(stubAgent({
      pay: async () => new AgentPaymentResult({
        paymentId: "pay_1", status: "settled", payment: paymentRecord(),
        response: {
          status: 202, headers: {}, mimeType: "application/json",
          bodyBase64: Buffer.from(JSON.stringify({ state: "queued" })).toString("base64"),
        },
      }),
    }));

    const result = await client.callTool({
      name: "genesispay_pay",
      arguments: { idempotencyKey: "k-1", url: "https://genesispay.example/pay/abc" },
    });

    const payload = JSON.parse(textContent(result)) as { resource: { status: number; note: string } };
    expect(payload.resource.status).toBe(202);
    expect(payload.resource.note).toContain("The payment is settled");
  });
});

describe("discovery method, asset and shop", () => {
  it("passes method, asset, shop and id through when present and omits them when absent", async () => {
    const client = await connectedClient(stubAgent({
      discover: async () => [
        { ...discoveredFlight, id: "lst_1", method: "POST", asset: "USDC",
          shop: { id: "shop_1", name: "Vector Air", storefrontUrl: "https://genesispay.example/s/vector" } },
        discoveredFlight,
      ],
    }));

    const result = await client.callTool({ name: "genesispay_discover", arguments: { query: "flight" } });
    const payload = JSON.parse(textContent(result)) as {
      listings: Array<Record<string, unknown>>;
      instructions: string;
    };

    expect(payload.listings[0]).toMatchObject({
      id: "lst_1", method: "POST", asset: "USDC",
      shop: { id: "shop_1", name: "Vector Air", storefrontUrl: "https://genesispay.example/s/vector" },
    });
    expect(Object.keys(payload.listings[1]).sort()).toEqual(
      ["category", "description", "kind", "priceUsdc", "resourceUrl", "title"],
    );
    expect(payload.instructions).toContain("passing its priceUsdc as maxAmountUsdc");
    expect(payload.instructions).toContain('method "POST"');
  });

  it("MR-102/MR-501: scopes the price guard to USDC listings and marks other assets notPayable", async () => {
    const client = await connectedClient(stubAgent({
      discover: async () => [
        { ...discoveredFlight, asset: "EURC", resourceUrl: "https://api.example.com/eur" },
        { ...discoveredFlight, asset: "USDC" },
        discoveredFlight,
      ],
    }));

    const { tools } = await client.listTools();
    const discoverTool = tools.find((tool) => tool.name === "genesispay_discover");
    expect(discoverTool?.description).toContain("Buy only listings whose asset is USDC or absent");
    expect(discoverTool?.description).toContain("that ceiling guards USDC listings only");

    const result = await client.callTool({ name: "genesispay_discover", arguments: { query: "flight" } });
    const payload = JSON.parse(textContent(result)) as {
      count: number;
      listings: Array<Record<string, unknown>>;
      instructions: string;
    };

    // Kept and annotated, not filtered: the count still includes the EURC listing.
    expect(payload.count).toBe(3);
    expect(payload.listings[0]).toMatchObject({ asset: "EURC", notPayable: true });
    expect(payload.listings[0].note).toContain("Do not call genesispay_pay");
    expect(payload.listings[1]).not.toHaveProperty("notPayable");
    expect(payload.listings[2]).not.toHaveProperty("notPayable");
    expect(payload.instructions).toContain("listings whose asset is USDC or absent");
    expect(payload.instructions).toContain("that ceiling guards USDC listings only");
    expect(payload.instructions).toContain("Do not call genesispay_pay for a listing marked notPayable");
  });
});

describe("genesispay_shops", () => {
  const shop = {
    id: "shop_1", name: "Vector Air", description: "Flights", storefrontUrl: "https://genesispay.example/s/vector",
    category: "travel", productCount: 3,
  };

  it("is read-only, says the storefront is not payable, and forwards query and limit", async () => {
    const shopsCalls: Array<{ query: string; limit: number | undefined }> = [];
    const client = await connectedClient(stubAgent({
      shops: async (query = "", options = {}) => {
        shopsCalls.push({ query, limit: options.limit });
        return [shop];
      },
    }));

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "genesispay_shops");
    expect(tool?.description).toContain("Read-only; it moves no money");
    expect(tool?.description).toContain("not a payable URL");

    const result = await client.callTool({ name: "genesispay_shops", arguments: { query: "air", limit: 5 } });
    const payload = JSON.parse(textContent(result)) as { count: number; shops: unknown[]; instructions: string };

    expect(shopsCalls).toEqual([{ query: "air", limit: 5 }]);
    expect(payload.count).toBe(1);
    expect(payload.shops).toEqual([shop]);
    expect(payload.instructions).toContain("genesispay_discover");
  });

  it("works without a query and suggests a product search when nothing matches", async () => {
    const shopsCalls: string[] = [];
    const client = await connectedClient(stubAgent({
      shops: async (query = "") => {
        shopsCalls.push(query);
        return [];
      },
    }));

    const result = await client.callTool({ name: "genesispay_shops", arguments: {} });
    const payload = JSON.parse(textContent(result)) as { query: string | null; count: number; instructions: string };

    expect(shopsCalls).toEqual([""]);
    expect(payload).toMatchObject({ query: null, count: 0 });
    expect(payload.instructions).toContain("No shops matched");
  });

  it("answers with an error when the agent client predates shop search", async () => {
    const client = await connectedClient(stubAgent());

    const result = await client.callTool({ name: "genesispay_shops", arguments: { query: "air" } });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("upgrade @genesis-tech/genesispay-agent");
  });

  it("reports an API error as a tool error without retry guidance", async () => {
    const client = await connectedClient(stubAgent({
      shops: async () => {
        throw new GenesisPayApiError("Not found.", { status: 404 });
      },
    }));

    const result = await client.callTool({ name: "genesispay_shops", arguments: { query: "air" } });
    const payload = JSON.parse(textContent(result)) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ httpStatus: 404 });
    expect(payload.retryGuidance).toBeUndefined();
  });
});

describe("genesispay_trending", () => {
  const product = {
    rank: 1, id: "prod_1", title: "Espresso beans", description: "1 kg", asset: "USDC",
    priceMinor: "12500000", priceUsdc: "12.5", method: "GET",
    resourceUrl: "https://genesispay.example/pay/inv_1", category: "coffee",
    shop: { id: "shop_1", name: "Atelier Nord", storefrontUrl: null }, signal: "sales",
  };

  it("is read-only, teaches when to use it and how to buy, and forwards the limit", async () => {
    const trendingCalls: Array<number | undefined> = [];
    const client = await connectedClient(stubAgent({
      trending: async (options = {}) => {
        trendingCalls.push(options.limit);
        return [product, { ...product, rank: 2, id: "prod_2", signal: "new", shop: null }];
      },
    }));

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "genesispay_trending");
    expect(tool?.title).toBe("See what is trending on GenesisPay");
    expect(tool?.description).toContain("Read-only; it moves no money");
    expect(tool?.description).toContain("popular, trending, hot, best-selling or new");
    expect(tool?.description).toContain("confirm with the user first");
    expect(tool?.description).toContain("that ceiling guards USDC products only");
    expect(tool?.description).toContain("marked notPayable");

    const result = await client.callTool({ name: "genesispay_trending", arguments: { limit: 5 } });
    const payload = JSON.parse(textContent(result)) as {
      count: number;
      products: Array<Record<string, unknown>>;
      instructions: string;
    };

    expect(trendingCalls).toEqual([5]);
    expect(payload.count).toBe(2);
    expect(payload.products[0]).toEqual(product);
    expect(payload.products[1]).toMatchObject({ rank: 2, signal: "new" });
    expect(payload.products[1]).not.toHaveProperty("shop");
    expect(payload.instructions).toContain("passing its priceUsdc as maxAmountUsdc");
    expect(payload.instructions).toContain("confirm with the user first");
  });

  it("refuses a limit outside 1..20 before calling the agent", async () => {
    let called = false;
    const client = await connectedClient(stubAgent({
      trending: async () => {
        called = true;
        return [];
      },
    }));

    const result = await client.callTool({ name: "genesispay_trending", arguments: { limit: 21 } });

    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("MR-102/MR-501: marks a non-USDC product notPayable, like a discovery listing", async () => {
    const client = await connectedClient(stubAgent({
      trending: async () => [{ ...product, asset: "EURC" }, product],
    }));

    const result = await client.callTool({ name: "genesispay_trending", arguments: {} });
    const payload = JSON.parse(textContent(result)) as { products: Array<Record<string, unknown>> };

    expect(payload.products[0]).toMatchObject({ asset: "EURC", notPayable: true });
    expect(payload.products[0].note).toContain("Do not call genesispay_pay for this product");
    expect(payload.products[1]).not.toHaveProperty("notPayable");
  });

  it("suggests a keyword search when nothing is listed", async () => {
    const client = await connectedClient(stubAgent({ trending: async () => [] }));

    const result = await client.callTool({ name: "genesispay_trending", arguments: {} });
    const payload = JSON.parse(textContent(result)) as { count: number; instructions: string };

    expect(payload.count).toBe(0);
    expect(payload.instructions).toContain("genesispay_discover");
  });

  it("answers with an error when the agent client predates trending", async () => {
    const client = await connectedClient(stubAgent());

    const result = await client.callTool({ name: "genesispay_trending", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("upgrade @genesis-tech/genesispay-agent to 1.2.0");
  });

  it("reports an API error as a tool error", async () => {
    const client = await connectedClient(stubAgent({
      trending: async () => {
        throw new GenesisPayApiError("Too many requests.", { status: 429 });
      },
    }));

    const result = await client.callTool({ name: "genesispay_trending", arguments: {} });
    const payload = JSON.parse(textContent(result)) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ httpStatus: 429 });
  });
});
