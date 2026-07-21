import { describe, expect, it, vi } from "vitest";

import { PeerPay } from "./client.js";
import {
  PeerPayConfigError,
  PeerPayNotFoundError,
  PeerPayRateLimitError,
  PeerPayValidationError,
} from "./errors.js";

const TEST_KEY = `pp_sk_test_${"a".repeat(32)}`;
const payer = "0x1111111111111111111111111111111111111111";
const destination = "0x2222222222222222222222222222222222222222";
const spender = "0x3333333333333333333333333333333333333333";
const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Exactly the shape `serializeMandate` puts on the wire. */
const mandateView = (overrides: Record<string, unknown> = {}) => ({
  id: "mnd_1",
  kind: "per_use",
  status: "pending_permit",
  asset: "USDC",
  chainId: 84532,
  payerWallet: payer,
  destinationWallet: destination,
  subscriptionPlanId: null,
  allowanceMinor: "20000000",
  capPerChargeMinor: "100000",
  spentMinor: "0",
  remainingMinor: "20000000",
  amountPerPeriodMinor: null,
  periodDays: null,
  nextChargeAt: null,
  permitDeadline: "2026-07-21T11:00:00.000Z",
  permitTxHash: null,
  createdAt: "2026-07-21T10:00:00.000Z",
  activatedAt: null,
  revokedAt: null,
  ...overrides,
});

const permitTypedData = {
  domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: usdc },
  types: {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  message: {
    owner: payer,
    spender,
    value: "20000000",
    nonce: "0",
    deadline: "1784030400",
  },
};

const jsonFetch = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );

const clientFor = (fetchFn: ReturnType<typeof jsonFetch>) =>
  new PeerPay({
    apiKey: TEST_KEY,
    baseUrl: "http://localhost:3000",
    fetchFn: fetchFn as unknown as typeof fetch,
  });

describe("mandates facade", () => {
  it("offers no activate — that step carries the payer's signature, not this key", () => {
    const client = clientFor(jsonFetch({}));

    // Documented omission, not an oversight: activation submits the payer's
    // signature over the permit typed data and belongs in the payer's frontend.
    // A test pins it so nobody "fixes" the gap by adding a seller-key activate.
    expect(Object.keys(client.mandates).sort()).toEqual([
      "charge",
      "create",
      "list",
      "retrieve",
      "revoke",
    ]);
    expect(
      (client.mandates as unknown as Record<string, unknown>).activate,
    ).toBeUndefined();
  });
});

describe("mandates.create", () => {
  const createBody = (overrides: Record<string, unknown> = {}) => ({
    mandate: mandateView(),
    permitTypedData,
    spender,
    ...overrides,
  });

  it("POSTs the proposal and returns mandate, permit typed data and spender", async () => {
    const fetchFn = jsonFetch(createBody(), 201);
    const client = clientFor(fetchFn);

    const result = await client.mandates.create({
      payerWallet: payer,
      kind: "per_use",
      allowance: "20",
      capPerCharge: "0.10",
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/mandates");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      payerWallet: payer,
      kind: "per_use",
      allowance: "20",
      capPerCharge: "0.10",
    });

    expect(result.mandate).toEqual(mandateView());
    expect(result.spender).toBe(spender);
  });

  it("passes the permit typed data through verbatim — a signature covers these bytes", async () => {
    const client = clientFor(jsonFetch(createBody(), 201));

    const result = await client.mandates.create({
      payerWallet: payer,
      kind: "per_use",
      allowance: "20",
      capPerCharge: "0.10",
    });

    // Deep equality including the nested `types` array: normalizing any of it
    // would make the payer sign something other than what the token verifies.
    expect(result.permitTypedData).toEqual(permitTypedData);
    expect(result.permitTypedData.message.value).toBe("20000000");
  });

  it("forwards the subscription-only fields when the kind needs them", async () => {
    const fetchFn = jsonFetch(
      createBody({
        mandate: mandateView({
          kind: "subscription",
          amountPerPeriodMinor: "9000000",
          periodDays: 30,
          nextChargeAt: "2026-08-20T10:00:00.000Z",
        }),
      }),
      201,
    );
    const client = clientFor(fetchFn);

    const result = await client.mandates.create({
      payerWallet: payer,
      kind: "subscription",
      allowance: "108",
      capPerCharge: "9",
      amountPerPeriod: "9",
      periodDays: 30,
      asset: "EURC",
      destinationWallet: destination,
    });

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      payerWallet: payer,
      kind: "subscription",
      allowance: "108",
      capPerCharge: "9",
      amountPerPeriod: "9",
      periodDays: 30,
      asset: "EURC",
      destinationWallet: destination,
    });
    expect(result.mandate).toMatchObject({
      kind: "subscription",
      amountPerPeriodMinor: "9000000",
      periodDays: 30,
      nextChargeAt: "2026-08-20T10:00:00.000Z",
    });
  });

  it("throws when the response has no permit typed data — the mandate could never activate", async () => {
    const client = clientFor(jsonFetch({ mandate: mandateView(), spender }, 201));

    const error = await client.mandates
      .create({ payerWallet: payer, kind: "per_use", allowance: "20", capPerCharge: "0.10" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("permitTypedData");
  });

  it("throws when the response has no mandate", async () => {
    const client = clientFor(jsonFetch({ permitTypedData, spender }, 201));

    await expect(
      client.mandates.create({
        payerWallet: payer,
        kind: "per_use",
        allowance: "20",
        capPerCharge: "0.10",
      }),
    ).rejects.toBeInstanceOf(PeerPayConfigError);
  });

  it("raises PeerPayValidationError with the server issues on 422", async () => {
    const client = clientFor(
      jsonFetch(
        {
          error: "Mandate input is invalid.",
          issues: [{ path: "payerWallet", message: "must be an EVM address" }],
        },
        422,
      ),
    );

    const error = await client.mandates
      .create({ payerWallet: "nope", kind: "per_use", allowance: "20", capPerCharge: "0.10" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayValidationError);
    expect((error as PeerPayValidationError).issues).toEqual([
      { path: "payerWallet", message: "must be an EVM address" },
    ]);
  });

  it("surfaces a 503 (facilitator not configured) as a config error with the server text", async () => {
    const client = clientFor(
      jsonFetch(
        { error: "The PeerDirect facilitator is not configured, so mandates cannot be created." },
        503,
      ),
    );

    const error = await client.mandates
      .create({ payerWallet: payer, kind: "per_use", allowance: "20", capPerCharge: "0.10" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("facilitator is not configured");
  });
});

describe("mandates.list", () => {
  it("GETs the collection without a query string when no filter is given", async () => {
    const fetchFn = jsonFetch({ mandates: [mandateView()], hasMore: false });
    const client = clientFor(fetchFn);

    const page = await client.mandates.list();

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/mandates");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TEST_KEY}`,
    );
    expect(page.hasMore).toBe(false);
    expect(page.mandates).toEqual([mandateView()]);
  });

  it("forwards every filter as a query parameter", async () => {
    const fetchFn = jsonFetch({ mandates: [], hasMore: false });
    const client = clientFor(fetchFn);

    await client.mandates.list({
      planId: "plan_1",
      status: "active",
      limit: 100,
      startingAfter: "mnd_9",
    });

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    const query = new URL(url).searchParams;
    expect(url.startsWith("http://localhost:3000/api/v1/mandates?")).toBe(true);
    expect(Object.fromEntries(query)).toEqual({
      planId: "plan_1",
      status: "active",
      limit: "100",
      startingAfter: "mnd_9",
    });
  });

  it("percent-encodes filter values instead of splicing them into the URL", async () => {
    const fetchFn = jsonFetch({ mandates: [], hasMore: false });
    const client = clientFor(fetchFn);

    await client.mandates.list({ planId: "a b&limit=1" });

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    // The injected `limit` must arrive as part of planId, never as its own param.
    expect(new URL(url).searchParams.get("planId")).toBe("a b&limit=1");
    expect(new URL(url).searchParams.get("limit")).toBeNull();
  });

  it("pages with the last id of the previous page and stops when hasMore is false", async () => {
    const first = { mandates: [mandateView({ id: "mnd_2" })], hasMore: true };
    const second = { mandates: [mandateView({ id: "mnd_1" })], hasMore: false };
    const bodies = [first, second];
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify(bodies.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = clientFor(fetchFn);

    // The loop from the `list` docblock, verbatim — if the documented recipe
    // stops working, this fails.
    const all: string[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      const page = await client.mandates.list({ limit: 1, startingAfter });
      all.push(...page.mandates.map((mandate) => mandate.id));
      if (!page.hasMore) break;
      startingAfter = page.mandates[page.mandates.length - 1]!.id;
    }

    expect(all).toEqual(["mnd_2", "mnd_1"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchFn.mock.calls[0] as unknown as [string];
    const [secondUrl] = fetchFn.mock.calls[1] as unknown as [string];
    expect(new URL(firstUrl).searchParams.get("startingAfter")).toBeNull();
    expect(new URL(secondUrl).searchParams.get("startingAfter")).toBe("mnd_2");
  });

  it("treats anything but an explicit true as 'no more pages'", async () => {
    const client = clientFor(jsonFetch({ mandates: [], hasMore: "yes" }));

    // A garbled flag must end the loop, not spin it forever.
    await expect(client.mandates.list()).resolves.toMatchObject({ hasMore: false });
  });

  it("throws when the 200 body carries no mandates array", async () => {
    const client = clientFor(jsonFetch({ hasMore: false }));

    // Degrading to [] here would read as "this customer has no subscription",
    // which is the one wrong conclusion to draw from a broken response.
    const error = await client.mandates.list().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("no mandates array");
  });

  it("skips an unusable row but keeps the rest of the page", async () => {
    const client = clientFor(
      jsonFetch({
        mandates: [mandateView({ id: "mnd_1" }), null, { kind: "per_use" }, "nope"],
        hasMore: false,
      }),
    );

    const page = await client.mandates.list();

    expect(page.mandates.map((mandate) => mandate.id)).toEqual(["mnd_1"]);
  });

  it("degrades an unknown status to pending_permit in a list row too", async () => {
    const client = clientFor(
      jsonFetch({ mandates: [mandateView({ status: "quantum" })], hasMore: false }),
    );

    const page = await client.mandates.list();

    expect(page.mandates[0]?.status).toBe("pending_permit");
  });

  it("exposes the plan a listed mandate belongs to", async () => {
    const client = clientFor(
      jsonFetch({
        mandates: [
          mandateView({
            kind: "subscription",
            subscriptionPlanId: "1f0c4a6e-0000-4000-8000-000000000001",
          }),
        ],
        hasMore: false,
      }),
    );

    const page = await client.mandates.list({ planId: "plan_1" });

    expect(page.mandates[0]?.subscriptionPlanId).toBe(
      "1f0c4a6e-0000-4000-8000-000000000001",
    );
  });

  it("rejects an empty planId before touching the network", async () => {
    const fetchFn = jsonFetch({ mandates: [], hasMore: false });
    const client = clientFor(fetchFn);

    // Dropping it would widen the page from one plan's subscribers to every
    // mandate on the account.
    const error = await client.mandates.list({ planId: "  " }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("planId");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an empty startingAfter before touching the network", async () => {
    const fetchFn = jsonFetch({ mandates: [], hasMore: false });
    const client = clientFor(fetchFn);

    // Dropping it would restart at page 1 — an endless paging loop.
    await expect(client.mandates.list({ startingAfter: "" })).rejects.toBeInstanceOf(
      PeerPayConfigError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("raises PeerPayValidationError with the issues on a 400 query rejection", async () => {
    const client = clientFor(
      jsonFetch(
        {
          error: "Mandate list query is invalid.",
          issues: [{ path: "limit", message: "limit must be 100 or less" }],
        },
        400,
      ),
    );

    // The route answers 400 (not 422) for a bad query string; a caller that
    // wants to show the offending parameter must not have to branch on status.
    const error = await client.mandates.list({ limit: 500 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayValidationError);
    expect((error as PeerPayValidationError).issues).toEqual([
      { path: "limit", message: "limit must be 100 or less" },
    ]);
  });

  it("keeps a 400 without field issues on PeerPayConfigError", async () => {
    const client = clientFor(
      jsonFetch({ error: "startingAfter is not a mandate of this account." }, 400),
    );

    const error = await client.mandates
      .list({ startingAfter: "mnd_foreign" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect(error).not.toBeInstanceOf(PeerPayValidationError);
    expect((error as Error).message).toContain("not a mandate of this account");
  });

  it("raises PeerPayRateLimitError with Retry-After on 429", async () => {
    const client = clientFor(jsonFetch({ error: "rate limited" }, 429, { "Retry-After": "7" }));

    const error = await client.mandates.list().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayRateLimitError);
    expect((error as PeerPayRateLimitError).retryAfterSeconds).toBe(7);
  });
});

describe("mandates.retrieve", () => {
  it("maps every field serializeMandate sends", async () => {
    const fetchFn = jsonFetch({
      mandate: mandateView({
        status: "active",
        spentMinor: "500000",
        remainingMinor: "19500000",
        permitTxHash: "0xpermit",
        activatedAt: "2026-07-21T10:05:00.000Z",
      }),
    });
    const client = clientFor(fetchFn);

    const mandate = await client.mandates.retrieve("mnd_1");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/mandates/mnd_1");
    expect(init.method).toBe("GET");
    expect(mandate).toEqual({
      id: "mnd_1",
      kind: "per_use",
      status: "active",
      asset: "USDC",
      chainId: 84532,
      payerWallet: payer,
      destinationWallet: destination,
      allowanceMinor: "20000000",
      capPerChargeMinor: "100000",
      spentMinor: "500000",
      remainingMinor: "19500000",
      amountPerPeriodMinor: null,
      periodDays: null,
      nextChargeAt: null,
      permitDeadline: "2026-07-21T11:00:00.000Z",
      permitTxHash: "0xpermit",
      createdAt: "2026-07-21T10:00:00.000Z",
      activatedAt: "2026-07-21T10:05:00.000Z",
      revokedAt: null,
      subscriptionPlanId: null,
    });
  });

  it("carries the plan a subscription mandate came from", async () => {
    const client = clientFor(
      jsonFetch({
        mandate: mandateView({
          kind: "subscription",
          subscriptionPlanId: "1f0c4a6e-0000-4000-8000-000000000001",
        }),
      }),
    );

    await expect(client.mandates.retrieve("mnd_1")).resolves.toMatchObject({
      subscriptionPlanId: "1f0c4a6e-0000-4000-8000-000000000001",
    });
  });

  it("keeps subscriptionPlanId null against a backend that does not send it", async () => {
    const withoutPlan: Record<string, unknown> = { ...mandateView() };
    delete withoutPlan.subscriptionPlanId;
    const client = clientFor(jsonFetch({ mandate: withoutPlan }));

    await expect(client.mandates.retrieve("mnd_1")).resolves.toMatchObject({
      subscriptionPlanId: null,
    });
  });

  it("degrades an unknown status to pending_permit — the inert state, never active", async () => {
    const client = clientFor(jsonFetch({ mandate: mandateView({ status: "quantum" }) }));

    // Guessing "active" for a status this SDK version has never heard of would
    // invite a gate to serve something it should not.
    await expect(client.mandates.retrieve("mnd_1")).resolves.toMatchObject({
      status: "pending_permit",
    });
  });

  it("keeps 'not set' distinguishable from zero on the subscription fields", async () => {
    const client = clientFor(
      jsonFetch({ mandate: mandateView({ amountPerPeriodMinor: "0", periodDays: 0 }) }),
    );

    const mandate = await client.mandates.retrieve("mnd_1");

    expect(mandate.amountPerPeriodMinor).toBe("0");
    expect(mandate.periodDays).toBe(0);
  });

  it("URL-encodes the id and raises PeerPayNotFoundError on 404", async () => {
    const fetchFn = jsonFetch({ error: "Mandate not found." }, 404);
    const client = clientFor(fetchFn);

    const error = await client.mandates.retrieve("a b/c").catch((e: unknown) => e);

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:3000/api/v1/mandates/a%20b%2Fc");
    expect(error).toBeInstanceOf(PeerPayNotFoundError);
    expect((error as Error).message).toContain("a b/c");
  });

  it("rejects an empty id before touching the network", async () => {
    const fetchFn = jsonFetch({ mandate: mandateView() });
    const client = clientFor(fetchFn);

    await expect(client.mandates.retrieve("  ")).rejects.toBeInstanceOf(PeerPayConfigError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when the 200 body carries no mandate", async () => {
    const client = clientFor(jsonFetch({}));

    await expect(client.mandates.retrieve("mnd_1")).rejects.toBeInstanceOf(PeerPayConfigError);
  });
});

describe("mandates.charge", () => {
  it("POSTs the amount and maps the settled charge", async () => {
    const fetchFn = jsonFetch({
      charge: { id: "chg_1", status: "settled", amountMinor: "80000", txHash: "0xabc" },
    });
    const client = clientFor(fetchFn);

    const charge = await client.mandates.charge("mnd_1", { amount: "0.08" });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/mandates/mnd_1/charge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ amount: "0.08" });
    expect(charge).toEqual({
      id: "chg_1",
      status: "settled",
      amountMinor: "80000",
      txHash: "0xabc",
    });
  });

  it("forwards resourceUrl and description when given", async () => {
    const fetchFn = jsonFetch({
      charge: { id: "chg_1", status: "settled", amountMinor: "80000", txHash: "0xabc" },
    });
    const client = clientFor(fetchFn);

    await client.mandates.charge("mnd_1", {
      amount: "0.08",
      resourceUrl: "https://api.example/v1/summarize",
      description: "1 summary",
    });

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      amount: "0.08",
      resourceUrl: "https://api.example/v1/summarize",
      description: "1 summary",
    });
  });

  it("maps a charge that has no txHash yet to null", async () => {
    const client = clientFor(
      jsonFetch({ charge: { id: "chg_1", status: "pending", amountMinor: "80000", txHash: null } }),
    );

    await expect(client.mandates.charge("mnd_1", { amount: "0.08" })).resolves.toMatchObject({
      status: "pending",
      txHash: null,
    });
  });

  it("raises PeerPayNotFoundError for an unknown mandate", async () => {
    const client = clientFor(
      jsonFetch({ error: "Mandate not found.", code: "mandate_not_found" }, 404),
    );

    const error = await client.mandates
      .charge("mnd_missing", { amount: "0.08" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayNotFoundError);
    expect((error as Error).message).toContain("mnd_missing");
  });

  it("surfaces a refused charge (cap or allowance) as a config error with the server text", async () => {
    const client = clientFor(
      jsonFetch({ error: "Charge exceeds the mandate cap.", code: "cap_exceeded" }, 409),
    );

    const error = await client.mandates
      .charge("mnd_1", { amount: "5" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("Charge exceeds the mandate cap.");
  });

  it("raises PeerPayRateLimitError with Retry-After on 429", async () => {
    const client = clientFor(jsonFetch({ error: "rate limited" }, 429, { "Retry-After": "3" }));

    const error = await client.mandates
      .charge("mnd_1", { amount: "0.08" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayRateLimitError);
    expect((error as PeerPayRateLimitError).retryAfterSeconds).toBe(3);
  });

  it("rejects an empty id before touching the network", async () => {
    const fetchFn = jsonFetch({ charge: { id: "chg_1" } });
    const client = clientFor(fetchFn);

    await expect(client.mandates.charge("", { amount: "1" })).rejects.toBeInstanceOf(
      PeerPayConfigError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when the 200 body carries no charge", async () => {
    const client = clientFor(jsonFetch({}));

    await expect(
      client.mandates.charge("mnd_1", { amount: "0.08" }),
    ).rejects.toBeInstanceOf(PeerPayConfigError);
  });
});

describe("mandates.revoke", () => {
  it("POSTs to the revoke route and returns the revoked mandate", async () => {
    const fetchFn = jsonFetch({
      mandate: mandateView({ status: "revoked", revokedAt: "2026-07-22T08:00:00.000Z" }),
    });
    const client = clientFor(fetchFn);

    const mandate = await client.mandates.revoke("mnd_1");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/mandates/mnd_1/revoke");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(mandate).toMatchObject({
      status: "revoked",
      revokedAt: "2026-07-22T08:00:00.000Z",
    });
  });

  it("raises PeerPayNotFoundError on 404", async () => {
    const client = clientFor(jsonFetch({ error: "Mandate not found." }, 404));

    await expect(client.mandates.revoke("mnd_missing")).rejects.toBeInstanceOf(
      PeerPayNotFoundError,
    );
  });

  it("rejects an empty id before touching the network", async () => {
    const fetchFn = jsonFetch({ mandate: mandateView() });
    const client = clientFor(fetchFn);

    await expect(client.mandates.revoke("   ")).rejects.toBeInstanceOf(PeerPayConfigError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
