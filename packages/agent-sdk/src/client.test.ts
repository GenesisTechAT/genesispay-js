import { describe, expect, it, vi } from "vitest";

import { GenesisPayAgent } from "./client.js";
import {
  GenesisPayApiError,
  GenesisPayApprovalRejectedError,
  GenesisPayApprovalTimeoutError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayAuthError,
  GenesisPayDuplicatePaymentError,
  GenesisPayPaymentFailedError,
  GenesisPayUnresolvedPaymentError,
  GenesisPayPaymentRejectedError,
  GenesisPayPolicyBlockedError,
} from "./errors.js";
import type { AgentPaymentRecord, PayOptions } from "./types.js";

const BASE_URL = "https://genesispay.example";

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
  const agent = new GenesisPayAgent({
    apiKey: "gp_ag_test",
    baseUrl: `${BASE_URL}/`,
    fetchFn,
  });

  return { agent, calls };
}

describe("GenesisPayAgent constructor", () => {
  it("requires an API key and a base URL", () => {
    expect(() => new GenesisPayAgent({ baseUrl: BASE_URL })).toThrow(
      "GENESISPAY_AGENT_KEY",
    );
    expect(() => new GenesisPayAgent({ apiKey: "gp_ag_x" })).toThrow(
      "GENESISPAY_BASE_URL",
    );
    expect(
      () => new GenesisPayAgent({ apiKey: "gp_ag_x", baseUrl: "not-a-url" }),
    ).toThrow("base URL");
  });

  it("falls back to environment variables", () => {
    vi.stubEnv("GENESISPAY_AGENT_KEY", "gp_ag_env");
    vi.stubEnv("GENESISPAY_BASE_URL", BASE_URL);
    try {
      expect(() => new GenesisPayAgent()).not.toThrow();
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
    ).toBe("Bearer gp_ag_test");
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
      maxAmount: "0.50",
      asset: "USDC",
    });

    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      url: "https://api.example.com/premium",
      maxAmount: "0.50",
      asset: "USDC",
    });

    // v1 is USDC on Base. The account snapshot this SDK returns is
    // USDC-specific, so offering another asset would let a caller check one
    // budget and spend from another.
    // @ts-expect-error EURC agent payments are not supported in v1
    const rejected: PayOptions = { asset: "EURC" };
    expect(rejected).toBeDefined();
  });

  it("takes money amounts as decimal strings only", () => {
    // A compile-time guarantee, asserted here so the intent survives a refactor:
    // `maxAmount: 0.1 + 0.2` stringifies to "0.30000000000000004", which the
    // server rejects for having more than 6 decimals. A payments SDK that
    // accepts binary floats invites exactly that (guardrail 4).
    const options: PayOptions = { maxAmount: "0.30" };

    expect(options.maxAmount).toBe("0.30");
    // @ts-expect-error money is a decimal string, never a number
    const rejected: PayOptions = { maxAmount: 0.3 };
    expect(rejected).toBeDefined();
  });

  it("MR-307: forwards idempotencyKey so a retry cannot pay twice", async () => {
    const { agent, calls } = makeAgent([Response.json(settledPayBody())]);

    await agent.pay("https://api.example.com/premium", {
      maxAmountUsdc: "1.00",
      idempotencyKey: "order-42",
    });

    // Without this the server signs a fresh EIP-3009 nonce on every retry and
    // the token contract cannot recognise the duplicate.
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      url: "https://api.example.com/premium",
      maxAmountUsdc: "1.00",
      idempotencyKey: "order-42",
    });
  });

  it("MR-306: surfaces a direct unresolved payment as its own error class", async () => {
    // The exact 502 envelope /api/v1/agent/pay emits for an emitted-but-unknown
    // authorization. `failedPayResponseSchema` must NOT win this race: `failed`
    // documents "no money moved, safe to retry", which is the opposite claim.
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "unresolved",
          error: "Target rejected the signed payment with status 500.",
          code: "payment_outcome_unknown",
          payment: paymentRecord({
            status: "unresolved",
            txHash: null,
            failureReason: "Target rejected the signed payment with status 500.",
            authorizationValidBefore: "2026-07-08T13:00:00.000Z",
          }),
        },
        { status: 502 },
      ),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium", { idempotencyKey: "order-42" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayUnresolvedPaymentError);
    expect(error).not.toBeInstanceOf(GenesisPayPaymentFailedError);
    expect((error as Error).message).toMatch(/may have been charged/);
    // The deadline is what tells the caller when re-attempting becomes safe.
    expect(
      (error as GenesisPayUnresolvedPaymentError).payment.authorizationValidBefore,
    ).toBe("2026-07-08T13:00:00.000Z");
  });

  it("MR-307: surfaces a duplicate as a typed error naming the original payment", async () => {
    const original = paymentRecord({ id: "pay_original", status: "settled" });
    const { agent } = makeAgent([
      Response.json(
        {
          error: "A payment for this idempotency key already exists.",
          code: "payment_already_requested",
          paymentId: "pay_original",
          // The route always sends this; omitting it from the fixture left the
          // "a fresh key is safe" branch unexercised in both directions.
          paymentStatus: "settled",
          payment: original,
        },
        { status: 409 },
      ),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium", { idempotencyKey: "order-42" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayDuplicatePaymentError);
    // The id is the whole point: without it the caller's only route to the
    // resource is a new key, i.e. a second debit.
    expect((error as GenesisPayDuplicatePaymentError).paymentId).toBe(
      "pay_original",
    );
    expect((error as GenesisPayDuplicatePaymentError).payment?.status).toBe(
      "settled",
    );
    // The original may have settled, so a new key would buy it twice.
    expect((error as Error).message).toMatch(/would pay again/);
  });

  it("MR-307: says a fresh key is safe only when nothing was signed", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          error: "A payment for this idempotency key already exists.",
          code: "payment_already_requested",
          paymentId: "pay_original",
          // `failed` is only ever written before an authorization exists, so
          // this is the one case where re-keying cannot double-pay.
          paymentStatus: "failed",
          payment: paymentRecord({ id: "pay_original", status: "failed" }),
        },
        { status: 409 },
      ),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium", { idempotencyKey: "order-42" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayDuplicatePaymentError);
    expect((error as Error).message).toMatch(/NEW idempotencyKey is safe/);
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

  it("MR-306: stops on an unresolved payment instead of polling to a timeout", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "pending_approval",
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        },
        { status: 202 },
      ),
      Response.json({
        payment: paymentRecord({
          status: "unresolved",
          txHash: null,
          failureReason: "Target rejected the signed payment with status 500.",
        }),
      }),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium", {
        waitForApproval: { timeoutMs: 1_000, pollIntervalMs: 1 },
      })
      .catch((caught: unknown) => caught);

    // `unresolved` is a resting state. Polling it would end in an approval
    // timeout telling the caller to go approve a payment already delivered.
    expect(error).toBeInstanceOf(GenesisPayUnresolvedPaymentError);
    expect(error).not.toBeInstanceOf(GenesisPayApprovalTimeoutError);
    // Distinct from a failed payment on purpose: that one never moved money and
    // is safe to retry, this one may have.
    expect(error).not.toBeInstanceOf(GenesisPayPaymentFailedError);
    expect((error as Error).message).toMatch(/may have been charged/);
  });

  it("stops on a status this SDK version does not know", async () => {
    const { agent } = makeAgent([
      Response.json(
        {
          paymentId: "pay_1",
          status: "pending_approval",
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        },
        { status: 202 },
      ),
      Response.json({
        payment: paymentRecord({
          status: "some_future_status" as never,
          txHash: null,
        }),
      }),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium", {
        waitForApproval: { timeoutMs: 1_000, pollIntervalMs: 1 },
      })
      .catch((caught: unknown) => caught);

    // Unresolved, not failed: an unknown state is by definition one where we
    // cannot say the money did not move, and GenesisPayPaymentFailedError says it
    // did not. Throwing that here would tell every pinned SDK version that the
    // first status the server adds after its release is safe to re-pay.
    expect(error).toBeInstanceOf(GenesisPayUnresolvedPaymentError);
    expect(error).not.toBeInstanceOf(GenesisPayPaymentFailedError);
    expect((error as Error).message).toMatch(/does not recognise/);
  });

  it("throws GenesisPayApprovalRejectedError when the payment is denied", async () => {
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
    ).rejects.toBeInstanceOf(GenesisPayApprovalRejectedError);
  });

  // Fake timers, because this is the one polling test whose *exit condition is
  // the clock*. On real timers it raced: the poll count depends on how long each
  // mocked fetch happens to take, so a loaded CI runner could out-poll the queue
  // of `pending()` responses and fail with "Failed to reach GenesisPay" instead of
  // the timeout. Raising the millisecond budget would only make that rarer.
  //
  // With the clock controlled the poll count is arithmetic: deadline is t+10,
  // and the loop gives up once `now + pollInterval` would pass it — so it polls
  // at t=0 and t=5, then throws at t=10. Three status responses, always.
  it("throws GenesisPayApprovalTimeoutError when no decision arrives in time", async () => {
    vi.useFakeTimers();

    try {
      const pending = () =>
        Response.json({
          payment: paymentRecord({ status: "pending_approval", txHash: null }),
        });
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
        pending(),
        pending(),
        pending(),
      ]);

      const settled = agent
        .pay("https://api.example.com/premium", {
          waitForApproval: { timeoutMs: 10, pollIntervalMs: 5 },
        })
        .catch((caught: unknown) => caught);

      // Async advance: each poll awaits a fetch, so the microtask queue has to
      // drain between timer steps or the loop never reaches the next sleep.
      await vi.advanceTimersByTimeAsync(50);

      const error = await settled;

      expect(error).toBeInstanceOf(GenesisPayApprovalTimeoutError);
      expect((error as GenesisPayApprovalTimeoutError).approvalUrl).toBe(
        `${BASE_URL}/dashboard/approvals`,
      );
      // Pins the determinism: one pay + exactly three status polls. If the loop
      // ever out-polls the queue again, this fails before the flake reaches CI.
      expect(calls.map((call) => call.url)).toEqual([
        `${BASE_URL}/api/v1/agent/pay`,
        `${BASE_URL}/api/v1/agent/payments/pay_1`,
        `${BASE_URL}/api/v1/agent/payments/pay_1`,
        `${BASE_URL}/api/v1/agent/payments/pay_1`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("MR-306: a timeout while the payment is EXECUTING is unknown-outcome, not still-pending", async () => {
    vi.useFakeTimers();

    try {
      const executing = () =>
        Response.json({
          payment: paymentRecord({ status: "executing", txHash: null }),
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
        executing(),
        executing(),
        executing(),
      ]);

      const settled = agent
        .pay("https://api.example.com/premium", {
          waitForApproval: { timeoutMs: 10, pollIntervalMs: 5 },
        })
        .catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(50);

      const error = await settled;

      // An `executing` payment has passed the caps and may already have signed.
      // "The payment is still pending — surface the approval URL" is the one
      // sentence that reads as *no money moved*, and we do not know that.
      expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
      expect(error).not.toBeInstanceOf(GenesisPayApprovalTimeoutError);
      expect((error as GenesisPayApiError).message).toMatch(/unknown/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("MR-306: a poll that fails after the payment left approval is unknown-outcome", async () => {
    vi.useFakeTimers();

    try {
      let call = 0;
      const fetchFn = (async (input: string) => {
        call += 1;
        if (call === 1) {
          return Response.json(
            {
              paymentId: "pay_1",
              status: "pending_approval",
              approvalUrl: `${BASE_URL}/dashboard/approvals`,
              payment: paymentRecord({
                status: "pending_approval",
                txHash: null,
              }),
            },
            { status: 202 },
          );
        }
        if (call === 2) {
          // Approved and executing: from here a signed authorization may exist.
          return Response.json({
            payment: paymentRecord({ status: "executing", txHash: null }),
          });
        }
        void input;
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch;

      const agent = new GenesisPayAgent({
        apiKey: "gp_ag_test",
        baseUrl: BASE_URL,
        fetchFn,
      });

      const settled = agent
        .pay("https://api.example.com/premium", {
          waitForApproval: { timeoutMs: 60_000, pollIntervalMs: 5 },
        })
        .catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(50);

      const error = await settled;

      // Losing sight of an executing payment is not "nothing was at stake".
      expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
      expect((error as GenesisPayPaymentOutcomeUnknownError).paymentId).toBe(
        "pay_1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a poll that fails while still pending approval stays a network error", async () => {
    vi.useFakeTimers();

    try {
      let call = 0;
      const fetchFn = (async () => {
        call += 1;
        if (call === 1) {
          return Response.json(
            {
              paymentId: "pay_1",
              status: "pending_approval",
              approvalUrl: `${BASE_URL}/dashboard/approvals`,
              payment: paymentRecord({
                status: "pending_approval",
                txHash: null,
              }),
            },
            { status: 202 },
          );
        }
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch;

      const agent = new GenesisPayAgent({
        apiKey: "gp_ag_test",
        baseUrl: BASE_URL,
        fetchFn,
      });

      const settled = agent
        .pay("https://api.example.com/premium", {
          waitForApproval: { timeoutMs: 60_000, pollIntervalMs: 5 },
        })
        .catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(50);

      const error = await settled;

      // Nothing has cleared the caps yet, so this really is just a failed read.
      expect(error).not.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
      expect((error as GenesisPayApiError).code).toBe("network_error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("MR-306: a drop during the execute step names the payment and the key", async () => {
    vi.useFakeTimers();

    try {
      let call = 0;
      const fetchFn = (async () => {
        call += 1;
        if (call === 1) {
          return Response.json(
            {
              paymentId: "pay_1",
              status: "pending_approval",
              approvalUrl: `${BASE_URL}/dashboard/approvals`,
              payment: paymentRecord({
                status: "pending_approval",
                txHash: null,
              }),
            },
            { status: 202 },
          );
        }
        if (call === 2) {
          return Response.json({
            payment: paymentRecord({ status: "approved", txHash: null }),
          });
        }
        // The execute call: the connection dies while the server is signing and
        // calling the resource. This is the likeliest unknown-outcome moment in
        // the whole flow.
        throw new Error("socket hang up");
      }) as unknown as typeof fetch;

      const agent = new GenesisPayAgent({
        apiKey: "gp_ag_test",
        baseUrl: BASE_URL,
        fetchFn,
      });

      const settled = agent
        .pay("https://api.example.com/premium", {
          idempotencyKey: "order-1",
          waitForApproval: { timeoutMs: 60_000, pollIntervalMs: 5 },
        })
        .catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(50);

      const error = await settled;

      expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
      // The error's own instruction is "check with paymentStatus() and reuse
      // the same idempotencyKey". With both fields null that is impossible to
      // follow — and the caller of pay() never had the payment id.
      expect((error as GenesisPayPaymentOutcomeUnknownError).paymentId).toBe(
        "pay_1",
      );
      expect((error as GenesisPayPaymentOutcomeUnknownError).idempotencyKey).toBe(
        "order-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("MR-306: a busy agent (503 agent_busy) provably was NOT charged", async () => {
    // The server takes a short lock around the spend-cap section; a contended
    // acquire rolls the transaction back, so no row and no signature exist.
    // Classified as a generic 5xx this reaches a caller as "may have been
    // charged" and an MCP model as "do NOT buy this item again" — a sticky
    // false alarm on what is really a busy moment, and reachable on an honest
    // burst because the per-key limiter admits 30 concurrent calls that all
    // serialize on one agent's lock.
    const fetchFn = (async () =>
      Response.json(
        {
          error:
            "Another payment for this agent is being processed. Nothing was charged — retry in a moment.",
          code: "agent_busy",
        },
        { status: 503 },
      )) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium", { idempotencyKey: "order-1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayPaymentRejectedError);
    expect(error).not.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect((error as GenesisPayApiError).code).toBe("agent_busy");
  });

  it("MR-306: a generic 503 IS still a possible charge", async () => {
    // The allowlist must stay an allowlist. `withApiErrorBoundary` can answer
    // 503 `service_unavailable` from anywhere in the handler, including after
    // signing, and that one is genuinely unknown.
    const fetchFn = (async () =>
      Response.json(
        { error: "Service unavailable.", code: "service_unavailable" },
        { status: 503 },
      )) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
  });

  it("MR-306: the executePayment 5xx path names the payment too", async () => {
    const fetchFn = (async () =>
      Response.json(
        { error: "Unexpected error.", code: "internal_error" },
        { status: 500 },
      )) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .executePayment("pay_1", { idempotencyKey: "order-1" })
      .catch((caught: unknown) => caught);

    // The transport path carries the id; so must the promotion path, or the
    // error's own "check with paymentStatus()" cannot be followed.
    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect((error as GenesisPayPaymentOutcomeUnknownError).paymentId).toBe("pay_1");
    expect((error as GenesisPayPaymentOutcomeUnknownError).idempotencyKey).toBe(
      "order-1",
    );
  });

  it("types a pre-signing rejection as rejected, not as a bare API error", async () => {
    const fetchFn = (async () =>
      Response.json(
        { error: "Could not reach the target URL.", code: "target_unreachable" },
        { status: 502 },
      )) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    // Same server union as `amount_exceeds_max` and friends, so it gets the
    // same class — a consumer branching on "rejected before money moved"
    // otherwise misses the most common failure in the flow.
    expect(error).toBeInstanceOf(GenesisPayPaymentRejectedError);
    expect(error).not.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
  });

  it("always sets a code on a rejection, even when the body carries none", async () => {
    const fetchFn = (async () =>
      new Response("<html>422</html>", {
        status: 422,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    // The base class documents that every subclass sets a code, and this was
    // the one that could return null.
    expect((error as GenesisPayApiError).code).toBe("payment_rejected");
  });

  it("every error this client raises is a GenesisPayApiError", async () => {
    // A consumer writing `if (e instanceof GenesisPayApiError) … else throw e`
    // used to silently rethrow both approval outcomes, which are the most
    // common results of pay({ waitForApproval }).
    const denied = new GenesisPayApprovalRejectedError(
      paymentRecord({ status: "denied", txHash: null }),
    );
    const timedOut = new GenesisPayApprovalTimeoutError(
      paymentRecord({ status: "pending_approval", txHash: null }),
      null,
    );

    expect(denied).toBeInstanceOf(GenesisPayApiError);
    expect(timedOut).toBeInstanceOf(GenesisPayApiError);
    expect(denied.code).toBe("approval_rejected");
    expect(timedOut.code).toBe("approval_timeout");
  });

  it("throws GenesisPayPolicyBlockedError on 403 policy blocks", async () => {
    const { agent } = makeAgent([
      Response.json(
        { error: "Target is not on the allowlist.", code: "policy_blocked" },
        { status: 403 },
      ),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayPolicyBlockedError);
    expect((error as GenesisPayPolicyBlockedError).message).toContain("allowlist");
  });

  it("throws GenesisPayPaymentRejectedError with guidance on 422 amount_exceeds_max", async () => {
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

    expect(error).toBeInstanceOf(GenesisPayPaymentRejectedError);
    expect((error as GenesisPayPaymentRejectedError).code).toBe("amount_exceeds_max");
    expect((error as GenesisPayPaymentRejectedError).message).toContain(
      "maxAmountUsdc",
    );
  });

  it("throws GenesisPayAuthError on 401 with a key hint", async () => {
    const { agent } = makeAgent([
      Response.json({ error: "Invalid agent API key." }, { status: 401 }),
    ]);

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayAuthError);
    expect((error as GenesisPayAuthError).message).toContain("gp_ag_");
  });

  it("throws GenesisPayPaymentFailedError with the payment record on 502", async () => {
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

    expect(error).toBeInstanceOf(GenesisPayPaymentFailedError);
    expect((error as GenesisPayPaymentFailedError).payment?.status).toBe("failed");
  });

  it("MR-306: a dropped connection while paying is unknown-outcome, not a network error", async () => {
    // The likeliest unknown-outcome in production: the request is held open
    // while the server signs and calls the resource, so a timeout or a dropped
    // socket here says nothing about whether the payment was made. Reported as
    // a plain `network_error` it reads as "the call did not go through", and
    // the integrator's retry buys the thing twice.
    const fetchFn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium", { idempotencyKey: "order-1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect((error as GenesisPayApiError).code).toBe("payment_outcome_unknown");
    expect((error as GenesisPayPaymentOutcomeUnknownError).idempotencyKey).toBe(
      "order-1",
    );
    expect((error as GenesisPayApiError).message).toContain(BASE_URL);
  });

  it("MR-306: an unparseable 5xx while paying is unknown-outcome too", async () => {
    // An HTML 502 from a proxy carries no envelope we recognise, but the server
    // may well have signed and delivered before it broke.
    const fetchFn = (async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
  });

  it("MR-306: an unreachable SELLER is not reported as a possible charge", async () => {
    // The most common transient failure in the whole flow: the seller's own
    // endpoint does not answer our 402 probe. That happens before any row
    // exists and before anything is signed — the server says so with
    // `target_unreachable`. Promoting it to "may have been charged" hands the
    // caller a null paymentId to investigate and tells an agent not to retry a
    // purchase that provably never started, and after enough false alarms the
    // real ones stop being believed.
    const fetchFn = (async () =>
      Response.json(
        {
          error: "Could not reach the target URL.",
          code: "target_unreachable",
        },
        { status: 502 },
      )) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium", { idempotencyKey: "order-1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect(error).not.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect((error as GenesisPayApiError).code).toBe("target_unreachable");
  });

  it("MR-306: an unrecognised 500 IS still a possible charge", async () => {
    // `withApiErrorBoundary` answers `500 internal_error` from anywhere in the
    // handler, including after signing. The allowlist above must stay an
    // allowlist — "any code we recognise" would swallow this one.
    const fetchFn = (async () =>
      Response.json(
        { error: "Unexpected error.", code: "internal_error" },
        { status: 500 },
      )) as unknown as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent
      .pay("https://api.example.com/premium")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
  });

  it("keeps a plain network error on read-only calls", async () => {
    // Nothing was at stake reading an account, so the honest report is that the
    // request failed — widening unknown-outcome to every call would make the
    // status meaningless.
    const fetchFn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const agent = new GenesisPayAgent({
      apiKey: "gp_ag_test",
      baseUrl: BASE_URL,
      fetchFn,
    });

    const error = await agent.account().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect(error).not.toBeInstanceOf(GenesisPayPaymentOutcomeUnknownError);
    expect((error as GenesisPayApiError).code).toBe("network_error");
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
          error: "Payment is awaiting approval on the GenesisPay dashboard.",
          code: "not_approved",
        },
        { status: 409 },
      ),
    ]);

    const error = await agent
      .executePayment("pay_1")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect((error as GenesisPayApiError).status).toBe(409);
    expect((error as GenesisPayApiError).code).toBe("not_approved");
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

    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect((error as GenesisPayApiError).code).toBe("invalid_response");
  });
});

describe("discover", () => {
  const flightListing = {
    title: "Vector Air — flight bookings",
    description: "Bookings settled in USDC",
    priceUsdc: "189",
    kind: "api",
    resourceUrl: "https://genesispay.example/api/demo/flights",
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
      "https://genesispay.example/api/demo/flights",
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

    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect((error as GenesisPayApiError).code).toBe("invalid_response");
  });

  it("surfaces API errors", async () => {
    const { agent } = makeAgent([
      Response.json({ error: "Discovery query is invalid." }, { status: 400 }),
    ]);

    const error = await agent
      .discover("x".repeat(500))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect((error as GenesisPayApiError).status).toBe(400);
  });
});
