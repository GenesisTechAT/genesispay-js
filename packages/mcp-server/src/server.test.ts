import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentPaymentResult } from "@genesis-tech/peerpay-agent";
import type { AgentAccountInfo, AgentPaymentRecord } from "@genesis-tech/peerpay-agent";
import { describe, expect, it } from "vitest";

import { createPeerPayMcpServer } from "./server.js";
import type { PeerPayAgentLike } from "./server.js";

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
  resourceUrl: "https://peerpay.example/api/demo/flights",
  category: "flights",
};

function stubAgent(overrides: Partial<PeerPayAgentLike> = {}): PeerPayAgentLike {
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

async function connectedClient(agent: PeerPayAgentLike) {
  const server = createPeerPayMcpServer({ agent });
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

describe("createPeerPayMcpServer", () => {
  it("loads and lists the four PeerPay tools with approval guidance", async () => {
    const client = await connectedClient(stubAgent());

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "peerpay_account",
      "peerpay_discover",
      "peerpay_pay",
      "peerpay_payment_status",
    ]);

    const payTool = tools.find((tool) => tool.name === "peerpay_pay");
    expect(payTool?.description).toContain("human approval");
    expect(payTool?.description).toContain("approvalUrl");
    expect(payTool?.inputSchema.properties).toHaveProperty("url");
    expect(payTool?.inputSchema.properties).toHaveProperty("maxAmountUsdc");
    expect(payTool?.inputSchema.properties).toHaveProperty("asset");

    const discoverTool = tools.find((tool) => tool.name === "peerpay_discover");
    expect(discoverTool?.description).toContain("peerpay_pay");
    expect(discoverTool?.inputSchema.properties).toHaveProperty("query");
  });

  it("returns discovered services with guidance to pay via peerpay_pay", async () => {
    const client = await connectedClient(stubAgent());

    const result = await client.callTool({
      name: "peerpay_discover",
      arguments: { query: "flight" },
    });

    const payload = JSON.parse(textContent(result)) as {
      count: number;
      listings: Array<{ resourceUrl: string; priceUsdc: string }>;
      instructions: string;
    };

    expect(payload.count).toBe(1);
    expect(payload.listings[0].resourceUrl).toBe(
      "https://peerpay.example/api/demo/flights",
    );
    expect(payload.listings[0].priceUsdc).toBe("189");
    expect(payload.instructions).toContain("peerpay_pay");
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
      name: "peerpay_pay",
      arguments: { url: "https://api.example.com/premium", asset: "EURC" },
    });

    expect(payCalls).toHaveLength(1);
    expect(payCalls[0].options).toMatchObject({ asset: "EURC" });
  });

  it("suggests retrying with different keywords when nothing matches", async () => {
    const client = await connectedClient(stubAgent({ discover: async () => [] }));

    const result = await client.callTool({
      name: "peerpay_discover",
      arguments: { query: "yoga classes" },
    });

    const payload = JSON.parse(textContent(result)) as {
      count: number;
      instructions: string;
    };

    expect(payload.count).toBe(0);
    expect(payload.instructions).toContain("No services matched");
  });

  it("returns the settled payment and resource body from peerpay_pay", async () => {
    const client = await connectedClient(stubAgent());

    const result = await client.callTool({
      name: "peerpay_pay",
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
            approvalUrl: "https://peerpay.example/dashboard/approvals",
          }),
      }),
    );

    const result = await client.callTool({
      name: "peerpay_pay",
      arguments: { url: "https://api.example.com/premium" },
    });

    const payload = JSON.parse(textContent(result)) as {
      status: string;
      approvalUrl: string;
      instructions: string;
    };

    expect(payload.status).toBe("pending_approval");
    expect(payload.approvalUrl).toBe(
      "https://peerpay.example/dashboard/approvals",
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
      name: "peerpay_pay",
      arguments: { url: "https://api.example.com/free" },
    });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("status 200 instead of 402");
  });

  it("exposes payment status and account snapshots", async () => {
    const client = await connectedClient(stubAgent());

    const status = await client.callTool({
      name: "peerpay_payment_status",
      arguments: { paymentId: "pay_1" },
    });
    expect(JSON.parse(textContent(status))).toMatchObject({
      payment: { id: "pay_1", status: "settled" },
    });

    const account = await client.callTool({
      name: "peerpay_account",
      arguments: {},
    });
    expect(JSON.parse(textContent(account))).toMatchObject({
      name: "research-bot",
      usdcBalance: "12500000",
    });
  });
});
