import { describe, expect, it, vi } from "vitest";

import { PeerPayAgent } from "./client.js";
import {
  PeerPayApiError,
  PeerPayApprovalRejectedError,
  PeerPayApprovalTimeoutError,
  PeerPayAuthError,
  PeerPayPaymentFailedError,
  PeerPayPaymentRejectedError,
  PeerPayPolicyBlockedError,
} from "./errors.js";
import type { AgentPaymentRecord } from "./types.js";

const BASE_URL = "https://peerpay.example";

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

function settledPayBody(bodyJson: unknown = { data: "premium" }) {
  return {
    paymentId: "pay_1",
    status: "settled",
    txHash: `0x${"ab".repeat(32)}`,
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify(bodyJson)).toString("base64"),
      mimeType: "application/json",
    },
    payment: paymentRecord(),
  };
}

type MockCall = { url: string; init: RequestInit | undefined };

function mockFetchQueue(responses: Response[]) {
  const calls: MockCall[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) {
      throw new Error("mock fetch queue exhausted");
    }
    return next;
  });

  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeAgent(responses: Response[]) {
  const { fetchFn, calls } = mockFetchQueue(responses);
  const agent = new PeerPayAgent({
    apiKey: "pp_ag_test",
    baseUrl: `${BASE_URL}/`,
    fetchFn,
  });

  return { agent, calls };
}

describe("PeerPayAgent constructor", () => {
  it("requires an API key and a base URL", () => {
    expect(() => new PeerPayAgent({ baseUrl: BASE_URL })).toThrow(
      "PEERPAY_AGENT_KEY",
    );
    expect(() => new PeerPayAgent({ apiKey: "pp_ag_x" })).toThrow(
      "PEERPAY_BASE_URL",
    );
    expect(
      () => new PeerPayAgent({ apiKey: "pp_ag_x", baseUrl: "not-a-url" }),
    ).toThrow("base URL");
  });

  it("falls back to environment variables", () => {
    vi.stubEnv("PEERPAY_AGENT_KEY", "pp_ag_env");
    vi.stubEnv("PEERPAY_BASE_URL", BASE_URL);
    try {
      expect(() => new PeerPayAgent()).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("pay", () => {
  it("returns a settled result with body()/json() accessors", async () => {
    const { agent, calls } = makeAgent([Response.json(settledPayBody())]);

    const result = await agent.pay("https://api.example.com/premium", {
      maxAmountUsdc: "0.01",
      description: "test purchase",
    });

    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/agent/pay`);
    expect(calls[0].init?.method).toBe("POST");
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer pp_ag_test");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      url: "https://api.example.com/premium",
      maxAmountUsdc: "0.01",
      description: "test purchase",
    });

    expect(result.settled).toBe(true);
    expect(result.paymentId).toBe("pay_1");
    expect(result.txHash).toBe(`0x${"ab".repeat(32)}`);
    expect(result.payment.amountUsdcMinor).toBe("5000");
    expect(result.body()).toBe(JSON.stringify({ data: "premium" }));
    expect(result.json()).toEqual({ data: "premium" });
  });

  it("serializes the maxAmount and asset options into the request body", async () => {
    const { agent, calls } = makeAgent([Response.json(settledPayBody())]);

    await agent.pay("https://api.example.com/premium", {
      maxAmount: 0.5,
      asset: "EURC",
    });

    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      url: "https://api.example.com/premium",
      maxAmount: "0.5",
      asset: "EURC",
    });
  });

  it("returns a pending_approval result with the approval URL when not waiting", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "pending_approval",
          approvalUrl: `${BASE_URL}/dashboard/approvals`,
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        },
        { status: 202 },
      ),
    ]);

    const result = await agent.pay("https://api.example.com/premium");

    expect(result.pendingApproval).toBe(true);
    expect(result.approvalUrl).toBe(`${BASE_URL}/dashboard/approvals`);
    expect(() => result.body()).toThrow("not settled");
  });

  it("polls and executes once approved when waitForApproval is set", async () => {
    const { agent, calls } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "pending_approval",
          approvalUrl: `${BASE_URL}/dashboard/approvals`,
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        },
        { status: 202 },
      ),
      Response.json({ payment: paymentRecord({ status: "pending_approval", txHash: null }) }),
      Response.json({ payment: paymentRecord({ status: "approved", txHash: null }) }),
      Response.json(settledPayBody()),
    ]);

    const result = await agent.pay("https://api.example.com/premium", {
      waitForApproval: { timeoutMs: 1_000, pollIntervalMs: 1 },
    });

    expect(result.settled).toBe(true);
    expect(result.json()).toEqual({ data: "premium" });
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/api/v1/agent/pay`,
      `${BASE_URL}/api/v1/agent/payments/pay_1`,
      `${BASE_URL}/api/v1/agent/payments/pay_1`,
      `${BASE_URL}/api/v1/agent/payments/pay_1/execute`,
    ]);
  });

  it("returns a settled result without a capture when the dashboard executed it", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "pending_approval",
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        },
        { status: 202 },
      ),
      Response.json({ payment: paymentRecord({ status: "settled" }) }),
    ]);

    const result = await agent.pay("https://api.example.com/premium", {
      waitForApproval: { timeoutMs: 1_000, pollIntervalMs: 1 },
    });

    expect(result.settled).toBe(true);
    expect(result.response).toBeNull();
    expect(() => result.body()).toThrow("was not captured");
  });

  it("throws PeerPayApprovalRejectedError when the payment is denied", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "pending_approval",
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        },
        { status: 202 },
      ),
      Response.json({ payment: paymentRecord({ status: "denied", txHash: null }) }),
    ]);

    await expect(
      agent.pay("https://api.example.com/premium", {
        waitForApproval: { timeoutMs: 1_000, pollIntervalMs: 1 },
      }),
    ).rejects.toBeInstanceOf(PeerPayApprovalRejectedError);
  });

  it("throws PeerPayApprovalTimeoutError when no decision arrives in time", async () => {
    const pending = () =>
      Response.json({
        payment: paymentRecord({ status: "pending_approval", txHash: null }),
      });
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "pending_approval",
          approvalUrl: `${BASE_URL}/dashboard/approvals`,
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        },
        { status: 202 },
      ),
      pending(),
      pending(),
      pending(),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium", {
        waitForApproval: { timeoutMs: 5, pollIntervalMs: 2 },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayApprovalTimeoutError);
    expect((error as PeerPayApprovalTimeoutError).approvalUrl).toBe(
      `${BASE_URL}/dashboard/approvals`,
    );
  });

  it("throws PeerPayPolicyBlockedError on 403 policy blocks", async () => {
    const { agent } = makeAgent([
      Response.json(
        { error: "Target is not on the allowlist.", code: "policy_blocked" },
        { status: 403 },
      ),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayPolicyBlockedError);
    expect((error as PeerPayPolicyBlockedError).message).toContain("allowlist");
  });

  it("throws PeerPayPaymentRejectedError with guidance on 422 amount_exceeds_max", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          error: "Payment of 1.00 USDC exceeds maxAmountUsdc 0.10.",
          code: "amount_exceeds_max",
        },
        { status: 422 },
      ),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium", { maxAmountUsdc: "0.10" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayPaymentRejectedError);
    expect((error as PeerPayPaymentRejectedError).code).toBe("amount_exceeds_max");
    expect((error as PeerPayPaymentRejectedError).message).toContain(
      "maxAmountUsdc",
    );
  });

  it("throws PeerPayAuthError on 401 with a key hint", async () => {
    const { agent } = makeAgent([
      Response.json({ error: "Invalid agent API key." }, { status: 401 }),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayAuthError);
    expect((error as PeerPayAuthError).message).toContain("pp_ag_");
  });

  it("throws PeerPayPaymentFailedError with the payment record on 502", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "failed",
          error: "Target rejected the payment retry.",
          payment: paymentRecord({ status: "failed", txHash: null }),
        },
        { status: 502 },
      ),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayPaymentFailedError);
    expect((error as PeerPayPaymentFailedError).payment?.status).toBe("failed");
  });

  it("wraps network failures in a descriptive PeerPayApiError", async () => {
    const fetchFn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const agent = new PeerPayAgent({
      apiKey: "pp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayApiError);
    expect((error as PeerPayApiError).code).toBe("network_error");
    expect((error as PeerPayApiError).message).toContain(BASE_URL);
  });
});

describe("paymentStatus", () => {
  it("returns the payment record", async () => {
    const { agent, calls } = makeAgent([
      Response.json({ payment: paymentRecord({ status: "executing", txHash: null }) }),
    ]);

    const payment = await agent.paymentStatus("pay_1");

    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/agent/payments/pay_1`);
    expect(payment.status).toBe("executing");
  });

  it("throws a descriptive error on 404", async () => {
    const { agent } = makeAgent([
      Response.json({ error: "Agent payment not found." }, { status: 404 }),
    ]);

    await expect(agent.paymentStatus("missing")).rejects.toThrow(
      "Agent payment not found.",
    );
  });
});

describe("executePayment", () => {
  it("executes an approved payment and returns the settled result", async () => {
    const { agent, calls } = makeAgent([Response.json(settledPayBody())]);

    const result = await agent.executePayment("pay_1");

    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/agent/payments/pay_1/execute`);
    expect(result.settled).toBe(true);
  });

  it("throws a descriptive error when the payment is not approved yet", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          error: "Payment is awaiting approval on the PeerPay dashboard.",
          code: "not_approved",
        },
        { status: 409 },
      ),
    ]);

    const error = await agent
      .executePayment("pay_1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayApiError);
    expect((error as PeerPayApiError).status).toBe(409);
    expect((error as PeerPayApiError).code).toBe("not_approved");
  });
});

describe("account", () => {
  it("returns the account snapshot", async () => {
    const { agent, calls } = makeAgent([
      Response.json({
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
      }),
    ]);

    const account = await agent.account();

    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/agent/account`);
    expect(account.name).toBe("research-bot");
    expect(account.usdcBalance).toBe("12500000");
    expect(account.policy.perPaymentCapUsdcMinor).toBe("1000000");
  });

  it("rejects unexpected response shapes", async () => {
    const { agent } = makeAgent([Response.json({ nonsense: true })]);

    const error = await agent.account().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayApiError);
    expect((error as PeerPayApiError).code).toBe("invalid_response");
  });
});

describe("discover", () => {
  const flightListing = {
    title: "Vector Air — flight bookings",
    description: "Bookings settled in USDC",
    priceUsdc: "189",
    kind: "api",
    resourceUrl: "https://peerpay.example/api/demo/flights",
    category: "flights",
  };

  it("queries the public discovery endpoint with q, category, and limit", async () => {
    const { agent, calls } = makeAgent([
      Response.json({ listings: [flightListing] }),
    ]);

    const listings = await agent.discover("flight", {
      category: "flights",
      limit: 5,
    });

    expect(calls[0].url).toBe(
      `${BASE_URL}/api/v1/discovery?q=flight&category=flights&limit=5`,
    );
    expect(calls[0].init?.method).toBe("GET");
    expect(listings).toHaveLength(1);
    expect(listings[0].resourceUrl).toBe(
      "https://peerpay.example/api/demo/flights",
    );
    expect(listings[0].priceUsdc).toBe("189");
  });

  it("omits empty parameters", async () => {
    const { agent, calls } = makeAgent([Response.json({ listings: [] })]);

    const listings = await agent.discover("  ");

    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/discovery`);
    expect(listings).toEqual([]);
  });

  it("rejects unexpected response shapes", async () => {
    const { agent } = makeAgent([Response.json({ nonsense: true })]);

    const error = await agent
      .discover("flight")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayApiError);
    expect((error as PeerPayApiError).code).toBe("invalid_response");
  });

  it("surfaces API errors", async () => {
    const { agent } = makeAgent([
      Response.json({ error: "Discovery query is invalid." }, { status: 400 }),
    ]);

    const error = await agent
      .discover("x".repeat(500))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeerPayApiError);
    expect((error as PeerPayApiError).status).toBe(400);
  });
});
