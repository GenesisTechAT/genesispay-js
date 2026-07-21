import { describe, expect, it, vi } from "vitest";

import {
  PeerPay,
  PeerPayConfigError,
  PeerPayNetworkSafetyError,
  PeerPayNotFoundError,
  PeerPayRateLimitError,
  PeerPayValidationError,
  type SellerConfig,
} from "./client.js";
import { DEFAULT_FACILITATOR_BASE_URL } from "./peerpay-settlement.js";

const TEST_KEY = `pp_sk_test_${"a".repeat(32)}`;
const LIVE_KEY = `pp_sk_live_${"a".repeat(32)}`;
const LEGACY_KEY = `pp_sk_${"a".repeat(32)}`;
const receiving = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";

function sellerConfig(overrides: Partial<SellerConfig> = {}): SellerConfig {
  return {
    id: "u1",
    mode: "test",
    payTo: receiving,
    hasPayTo: true,
    network: {
      networkName: "base-sepolia",
      chainId: 84532,
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      asset: "USDC",
    },
    ...overrides,
  };
}

const jsonFetch = (value: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(value), { status }));

describe("PeerPay constructor", () => {
  it("parses the mode from the key prefix (test / live / legacy)", () => {
    expect(new PeerPay({ apiKey: TEST_KEY }).mode).toBe("test");
    expect(new PeerPay({ apiKey: LEGACY_KEY }).mode).toBe("test");
    expect(new PeerPay({ apiKey: LIVE_KEY, baseUrl: "https://prod.example" }).mode).toBe("live");
  });

  it("defaults a test key to the dev facilitator with zero config", () => {
    expect(new PeerPay({ apiKey: TEST_KEY }).baseUrl).toBe(DEFAULT_FACILITATOR_BASE_URL);
  });

  it("defaults a live key to the production facilitator with zero config", () => {
    expect(new PeerPay({ apiKey: LIVE_KEY }).baseUrl).toBe(
      "https://peerpay-app-production.up.railway.app",
    );
  });

  it("rejects a non-PeerPay key", () => {
    expect(() => new PeerPay({ apiKey: "sk_live_whatever" })).toThrow(PeerPayConfigError);
  });

  it("enforces https except for localhost", () => {
    expect(() => new PeerPay({ apiKey: TEST_KEY, baseUrl: "http://evil.example" })).toThrow(
      /https/,
    );
    expect(new PeerPay({ apiKey: TEST_KEY, baseUrl: "http://localhost:3000" }).baseUrl).toBe(
      "http://localhost:3000",
    );
  });
});

describe("retrieveSeller", () => {
  it("is single-flight and TTL-cached", async () => {
    const fetchFn = jsonFetch(sellerConfig());
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await Promise.all([client.retrieveSeller(), client.retrieveSeller()]);
    await client.retrieveSeller();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never caches failures — clears the memo and retries", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sellerConfig()), { status: 200 }));
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.retrieveSeller()).rejects.toBeInstanceOf(PeerPayConfigError);
    await expect(client.retrieveSeller()).resolves.toMatchObject({ id: "u1" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an asset-integrity mismatch", async () => {
    const bad = sellerConfig({
      network: {
        networkName: "base-sepolia",
        chainId: 84532,
        usdcAddress: "0x0000000000000000000000000000000000000000",
        asset: "USDC",
      },
    });
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch(bad) as unknown as typeof fetch,
    });

    await expect(client.retrieveSeller()).rejects.toBeInstanceOf(PeerPayNetworkSafetyError);
  });

  it("fails closed when the server-resolved mode disagrees with the key", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch(sellerConfig({ mode: "live" })) as unknown as typeof fetch,
    });

    await expect(client.retrieveSeller()).rejects.toBeInstanceOf(PeerPayNetworkSafetyError);
  });

  it("fails closed with a typed safety error on an unknown network name", async () => {
    const bad = sellerConfig({
      network: {
        // A network the SDK has no native-USDC entry for — must surface as a
        // PeerPayNetworkSafetyError, not a generic lookup throw.
        networkName: "base-mainnet" as unknown as SellerConfig["network"]["networkName"],
        chainId: 8453,
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        asset: "USDC",
      },
    });
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch(bad) as unknown as typeof fetch,
    });

    await expect(client.retrieveSeller()).rejects.toBeInstanceOf(PeerPayNetworkSafetyError);
  });

  it("fails closed when a live key resolves to a testnet", async () => {
    const client = new PeerPay({
      apiKey: LIVE_KEY,
      baseUrl: "https://prod.example",
      fetchFn: jsonFetch(sellerConfig({ mode: "live" })) as unknown as typeof fetch,
    });

    await expect(client.retrieveSeller()).rejects.toBeInstanceOf(PeerPayNetworkSafetyError);
  });

  it("fails closed on an expectedPayTo mismatch", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      expectedPayTo: other,
      fetchFn: jsonFetch(sellerConfig()) as unknown as typeof fetch,
    });

    await expect(client.retrieveSeller()).rejects.toBeInstanceOf(PeerPayNetworkSafetyError);
  });
});

describe("gate", () => {
  it("emits a 402 challenge carrying the resolved payTo", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/api/v1/seller")) {
        return new Response(JSON.stringify(sellerConfig()), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    const gated = client.gate({ amountUsdc: "0.02" }).wrap(() => Response.json({ ok: true }));
    const res = await gated(new Request("https://api.example.com/premium"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(JSON.stringify(body).toLowerCase()).toContain(receiving.toLowerCase());
  });

  it("returns payment_not_configured when the seller has no wallet", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch(sellerConfig({ payTo: null, hasPayTo: false })) as unknown as typeof fetch,
    });

    const gated = client.gate({ amountUsdc: "0.02" }).wrap(() => Response.json({ ok: true }));
    const res = await gated(new Request("https://api.example.com/premium"));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(402);
    expect(body.error).toBe("payment_not_configured");
  });

  it("fails closed (503) and never runs the handler when config can't be resolved", async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });

    const gated = client.gate({ amountUsdc: "0.02" }).wrap(handler);
    const res = await gated(new Request("https://api.example.com/premium"));

    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rebuilds the inner gate after a wallet rotation (advertises the new payTo)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(sellerConfig()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sellerConfig({ payTo: other })), { status: 200 }),
      );
    const client = new PeerPay({
      apiKey: TEST_KEY,
      configTtlMs: 0, // refresh every request
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const gated = client.gate({ amountUsdc: "0.02" }).wrap(() => Response.json({ ok: true }));
    const first = await (await gated(new Request("https://api.example.com/x"))).json();
    const second = await (await gated(new Request("https://api.example.com/x"))).json();

    expect(JSON.stringify(first).toLowerCase()).toContain(receiving.toLowerCase());
    expect(JSON.stringify(second).toLowerCase()).toContain(other.toLowerCase());
  });
});

describe("checkout.create", () => {
  it("unwraps the nested { link } body and returns the server-normalized amount", async () => {
    const fetchFn = jsonFetch({
      link: { publicId: "p1", payUrl: "https://pay.example/p1", amountUsdc: "5.00", title: "Credits" },
    });
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    const link = await client.checkout.create({ title: "Credits", amountUsdc: "5.00" });

    expect(link).toEqual({
      publicId: "p1",
      payUrl: "https://pay.example/p1",
      amountUsdc: "5.00",
      title: "Credits",
      // An older backend that predates these columns must not crash the SDK.
      metadata: null,
      clientReferenceId: null,
      returnUrl: null,
      cancelUrl: null,
    });
  });

  it("forwards metadata, clientReferenceId and the return/cancel URLs", async () => {
    const fetchFn = jsonFetch({
      link: {
        publicId: "p1",
        payUrl: "https://pay.example/p1",
        amountUsdc: "5.00",
        title: "Credits",
        metadata: { orderId: "A-1" },
        clientReferenceId: "cart_42",
        returnUrl: "https://shop.example/done",
        cancelUrl: "https://shop.example/cart",
      },
    });
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    const link = await client.checkout.create({
      title: "Credits",
      amountUsdc: "5.00",
      metadata: { orderId: "A-1" },
      clientReferenceId: "cart_42",
      returnUrl: "https://shop.example/done",
      cancelUrl: "https://shop.example/cart",
    });

    const body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      metadata: { orderId: "A-1" },
      clientReferenceId: "cart_42",
      returnUrl: "https://shop.example/done",
      cancelUrl: "https://shop.example/cart",
    });
    expect(link).toMatchObject({
      metadata: { orderId: "A-1" },
      clientReferenceId: "cart_42",
      returnUrl: "https://shop.example/done",
      cancelUrl: "https://shop.example/cart",
    });
  });

  it("omits the optional fields entirely when they are not set", async () => {
    const fetchFn = jsonFetch({
      link: { publicId: "p1", payUrl: "https://pay.example/p1", amountUsdc: "1.00", title: "x" },
    });
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await client.checkout.create({ title: "x", amountUsdc: "1.00" });

    const body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("clientReferenceId");
    expect(body).not.toHaveProperty("returnUrl");
    expect(body).not.toHaveProperty("cancelUrl");
  });

  it("throws PeerPayConfigError on an unclassified non-2xx response", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({ error: "nope" }, 500) as unknown as typeof fetch,
    });

    await expect(client.checkout.create({ title: "x", amountUsdc: "1.00" })).rejects.toBeInstanceOf(
      PeerPayConfigError,
    );
  });

  it("throws when the created link has no payUrl", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({ link: { publicId: "p1" } }) as unknown as typeof fetch,
    });

    await expect(client.checkout.create({ title: "x", amountUsdc: "1.00" })).rejects.toBeInstanceOf(
      PeerPayConfigError,
    );
  });
});

describe("checkout.retrieve", () => {
  const sessionLink = (overrides: Record<string, unknown> = {}) => ({
    id: "internal-uuid",
    publicId: "p1",
    payUrl: "https://pay.example/p1",
    amountUsdc: "5.00",
    amountUsdcMinor: "5000000",
    title: "Credits",
    description: "10 credits",
    asset: "EURC",
    linkType: "reusable",
    status: "paid",
    destinationWallet: receiving,
    chainId: 84532,
    confirmedPaymentCount: 2,
    createdAt: "2026-07-21T10:00:00.000Z",
    archivedAt: null,
    metadata: { orderId: "A-1" },
    clientReferenceId: "cart_42",
    returnUrl: "https://shop.example/done",
    cancelUrl: "https://shop.example/cart",
    attempts: [],
    ...overrides,
  });

  it("maps every field of the server link onto a CheckoutSession", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({ link: sessionLink() }) as unknown as typeof fetch,
    });

    await expect(client.checkout.retrieve("p1")).resolves.toEqual({
      publicId: "p1",
      payUrl: "https://pay.example/p1",
      amountUsdc: "5.00",
      title: "Credits",
      metadata: { orderId: "A-1" },
      clientReferenceId: "cart_42",
      returnUrl: "https://shop.example/done",
      cancelUrl: "https://shop.example/cart",
      description: "10 credits",
      asset: "EURC",
      linkType: "reusable",
      status: "paid",
      destinationWallet: receiving,
      chainId: 84532,
      paid: true,
      confirmedPaymentCount: 2,
      createdAt: "2026-07-21T10:00:00.000Z",
      attempts: [],
    });
  });

  it("derives paid from confirmedPaymentCount", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({
        link: sessionLink({ status: "active", confirmedPaymentCount: 0 }),
      }) as unknown as typeof fetch,
    });

    await expect(client.checkout.retrieve("p1")).resolves.toMatchObject({
      paid: false,
      status: "active",
    });
  });

  it("stays tolerant of a backend that predates the new columns", async () => {
    const legacy = sessionLink();
    delete (legacy as Record<string, unknown>).metadata;
    delete (legacy as Record<string, unknown>).clientReferenceId;
    delete (legacy as Record<string, unknown>).returnUrl;
    delete (legacy as Record<string, unknown>).cancelUrl;
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({ link: legacy }) as unknown as typeof fetch,
    });

    await expect(client.checkout.retrieve("p1")).resolves.toMatchObject({
      metadata: null,
      clientReferenceId: null,
      returnUrl: null,
      cancelUrl: null,
      paid: true,
    });
  });

  it("drops non-string metadata values instead of casting them", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({
        link: sessionLink({ metadata: { keep: "yes", drop: 7 } }),
      }) as unknown as typeof fetch,
    });

    await expect(client.checkout.retrieve("p1")).resolves.toMatchObject({
      metadata: { keep: "yes" },
    });
  });

  it("URL-encodes the publicId and sends the bearer key", async () => {
    const fetchFn = jsonFetch({ link: sessionLink({ publicId: "a b/c" }) });
    const client = new PeerPay({
      apiKey: TEST_KEY,
      baseUrl: "http://localhost:3000",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await client.checkout.retrieve("a b/c");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/links/a%20b%2Fc");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it("raises PeerPayNotFoundError on 404 — polling an unknown id is not a config error", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({ error: "Payment link not found." }, 404) as unknown as typeof fetch,
    });

    const error = await client.checkout.retrieve("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PeerPayNotFoundError);
    expect(error).not.toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).name).toBe("PeerPayNotFoundError");
  });

  it("raises PeerPayConfigError on 401 and 500", async () => {
    for (const status of [401, 500]) {
      const client = new PeerPay({
        apiKey: TEST_KEY,
        fetchFn: jsonFetch({ error: "boom" }, status) as unknown as typeof fetch,
      });
      await expect(client.checkout.retrieve("p1")).rejects.toBeInstanceOf(PeerPayConfigError);
    }
  });

  it("raises PeerPayConfigError when the transport itself fails", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(client.checkout.retrieve("p1")).rejects.toBeInstanceOf(PeerPayConfigError);
  });

  it("rejects an empty publicId before touching the network", async () => {
    const fetchFn = jsonFetch({ link: sessionLink() });
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.checkout.retrieve("   ")).rejects.toBeInstanceOf(PeerPayConfigError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when the 200 body carries no link", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({}) as unknown as typeof fetch,
    });

    await expect(client.checkout.retrieve("p1")).rejects.toBeInstanceOf(PeerPayConfigError);
  });
});

describe("checkout.retrieve — attempts", () => {
  const attempt = (overrides: Record<string, unknown> = {}) => ({
    id: "att_1",
    payerWallet: "0x3333333333333333333333333333333333333333",
    expectedAmountUsdcMinor: "5000000",
    txHash: "0xabc",
    status: "confirmed",
    createdAt: "2026-07-21T09:59:00.000Z",
    expiresAt: "2026-07-21T10:29:00.000Z",
    confirmedAt: "2026-07-21T10:00:00.000Z",
    failureReason: null,
    ...overrides,
  });

  const sessionWith = (attempts: unknown) => ({
    publicId: "p1",
    payUrl: "https://pay.example/p1",
    amountUsdc: "5.00",
    title: "Credits",
    status: "paid",
    destinationWallet: receiving,
    chainId: 84532,
    confirmedPaymentCount: 1,
    createdAt: "2026-07-21T10:00:00.000Z",
    attempts,
  });

  const clientFor = (attempts: unknown) =>
    new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({ link: sessionWith(attempts) }) as unknown as typeof fetch,
    });

  it("exposes the receipt fields the server already sends", async () => {
    const session = await clientFor([attempt()]).checkout.retrieve("p1");

    // The point of R3: after `paid === true` a receipt needs txHash + payer,
    // and those were being dropped on the floor.
    expect(session.attempts).toEqual([
      {
        id: "att_1",
        status: "confirmed",
        txHash: "0xabc",
        payerWallet: "0x3333333333333333333333333333333333333333",
        createdAt: "2026-07-21T09:59:00.000Z",
        confirmedAt: "2026-07-21T10:00:00.000Z",
        failureReason: null,
        simulated: false,
      },
    ]);
  });

  it("reports a simulated attempt as such, and only on an explicit true", async () => {
    // A simulated attempt has txHash: null — but so does a pending real one, so
    // the flag is the only honest signal. An older backend omits it entirely.
    const simulated = await clientFor([
      { ...attempt(), txHash: null, simulated: true },
    ]).checkout.retrieve("p1");
    expect(simulated.attempts[0]?.simulated).toBe(true);

    const legacy = await clientFor([{ ...attempt(), simulated: "yes" }]).checkout.retrieve(
      "p1",
    );
    expect(legacy.attempts[0]?.simulated).toBe(false);
  });

  it("keeps every attempt of a reusable link in server order", async () => {
    const session = await clientFor([
      attempt({ id: "att_2", txHash: "0xnewer" }),
      attempt({ id: "att_1", txHash: "0xolder" }),
    ]).checkout.retrieve("p1");

    expect(session.attempts.map((a) => a.id)).toEqual(["att_2", "att_1"]);
  });

  it("maps a pending attempt with no txHash to nulls instead of empty strings", async () => {
    const session = await clientFor([
      attempt({ status: "pending", txHash: null, confirmedAt: null, payerWallet: null }),
    ]).checkout.retrieve("p1");

    expect(session.attempts[0]).toMatchObject({
      status: "pending",
      txHash: null,
      confirmedAt: null,
      payerWallet: null,
    });
  });

  it("carries the failure reason of a failed attempt", async () => {
    const session = await clientFor([
      attempt({ status: "failed", confirmedAt: null, failureReason: "amount_mismatch" }),
    ]).checkout.retrieve("p1");

    expect(session.attempts[0]).toMatchObject({
      status: "failed",
      failureReason: "amount_mismatch",
    });
  });

  it("falls back to an empty list for a backend that does not send attempts", async () => {
    const legacy = sessionWith(undefined) as Record<string, unknown>;
    delete legacy.attempts;
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: jsonFetch({ link: legacy }) as unknown as typeof fetch,
    });

    await expect(client.checkout.retrieve("p1")).resolves.toMatchObject({ attempts: [] });
  });

  it("survives junk in the attempts array without crashing the poll loop", async () => {
    const session = await clientFor([
      null,
      "nope",
      { status: "confirmed" }, // no id → unusable, skipped
      attempt({ status: "who_knows" }),
    ]).checkout.retrieve("p1");

    expect(session.attempts).toHaveLength(1);
    // An unknown status degrades to "pending" rather than leaking a bogus literal.
    expect(session.attempts[0]?.status).toBe("pending");
  });

  it("returns [] when attempts is not an array at all", async () => {
    const session = await clientFor({ nope: true }).checkout.retrieve("p1");
    expect(session.attempts).toEqual([]);
  });
});

describe("typed HTTP errors", () => {
  const errorFetch = (
    body: unknown,
    status: number,
    headers: Record<string, string> = {},
  ) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
    ) as unknown as typeof fetch;

  const validationBody = {
    error: "Payment link input is invalid.",
    issues: [
      { path: "metadata", message: "metadata must have 20 keys or fewer" },
      { path: "amountUsdc", message: "amountUsdc must be greater than 0" },
    ],
  };

  it("raises PeerPayValidationError with the server issues on 422 (create)", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch(validationBody, 422),
    });

    const error = await client.checkout
      .create({ title: "x", amountUsdc: "1.00" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayValidationError);
    expect(error).not.toBeInstanceOf(PeerPayConfigError);
    expect((error as PeerPayValidationError).name).toBe("PeerPayValidationError");
    expect((error as PeerPayValidationError).issues).toEqual(validationBody.issues);
    expect((error as Error).message).toContain("Payment link input is invalid.");
  });

  it("raises PeerPayValidationError on 422 for retrieve as well — one mapping for every method", async () => {
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: errorFetch(validationBody, 422) });

    const error = await client.checkout.retrieve("p1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayValidationError);
    expect((error as PeerPayValidationError).issues).toHaveLength(2);
  });

  it("never invents issues: a 422 without a usable body yields an empty list", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: vi.fn(
        async () => new Response("<html>gateway said no</html>", { status: 422 }),
      ) as unknown as typeof fetch,
    });

    const error = await client.checkout
      .create({ title: "x", amountUsdc: "1.00" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayValidationError);
    expect((error as PeerPayValidationError).issues).toEqual([]);
    expect((error as Error).message).toContain("gateway said no");
  });

  it("drops malformed issue entries instead of throwing while building the error", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch(
        { error: "nope", issues: [null, "bad", { message: "no path" }, { path: "a", message: "m" }] },
        422,
      ),
    });

    const error = await client.checkout
      .create({ title: "x", amountUsdc: "1.00" })
      .catch((e: unknown) => e);

    expect((error as PeerPayValidationError).issues).toEqual([
      { path: "", message: "no path" },
      { path: "a", message: "m" },
    ]);
  });

  it("raises PeerPayRateLimitError with Retry-After on 429", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch({ error: "Too many requests. Retry later.", code: "rate_limited" }, 429, {
        "Retry-After": "17",
      }),
    });

    const error = await client.checkout
      .create({ title: "x", amountUsdc: "1.00" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayRateLimitError);
    expect((error as PeerPayRateLimitError).name).toBe("PeerPayRateLimitError");
    expect((error as PeerPayRateLimitError).retryAfterSeconds).toBe(17);
    expect((error as Error).message).toContain("17");
  });

  it("reports retryAfterSeconds = null rather than guessing when the header is missing", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch({ error: "rate limited" }, 429),
    });

    const error = await client.checkout.retrieve("p1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayRateLimitError);
    expect((error as PeerPayRateLimitError).retryAfterSeconds).toBeNull();
  });

  it("ignores an unparseable Retry-After instead of producing NaN", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch({ error: "rate limited" }, 429, { "Retry-After": "soon" }),
    });

    const error = await client.checkout.retrieve("p1").catch((e: unknown) => e);

    expect((error as PeerPayRateLimitError).retryAfterSeconds).toBeNull();
  });

  it("rate-limits the seller lookup too — a 429 is not a broken key", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch({ error: "rate limited" }, 429, { "Retry-After": "5" }),
    });

    const error = await client.retrieveSeller().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayRateLimitError);
    expect((error as PeerPayRateLimitError).retryAfterSeconds).toBe(5);
  });

  it("keeps 404 on PeerPayNotFoundError and everything else on PeerPayConfigError", async () => {
    const notFound = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch({ error: "Payment link not found." }, 404),
    });
    await expect(notFound.checkout.retrieve("p1")).rejects.toBeInstanceOf(PeerPayNotFoundError);

    for (const status of [400, 401, 403, 409, 500, 503]) {
      const client = new PeerPay({
        apiKey: TEST_KEY,
        fetchFn: errorFetch({ error: "boom" }, status),
      });
      const error = await client.checkout.retrieve("p1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PeerPayConfigError);
      expect(error).not.toBeInstanceOf(PeerPayValidationError);
      expect(error).not.toBeInstanceOf(PeerPayRateLimitError);
    }
  });

  it("keeps the publicId hint in the 404 message", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: errorFetch({ error: "Payment link not found." }, 404),
    });

    const error = await client.checkout.retrieve("missing-id").catch((e: unknown) => e);

    expect((error as Error).message).toContain("missing-id");
  });

  it("every typed error is a plain Error subclass with a usable stack", async () => {
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: errorFetch(validationBody, 422) });

    const error = await client.checkout.retrieve("p1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(typeof (error as Error).stack).toBe("string");
  });
});

describe("checkout.simulatePayment", () => {
  const simulatedAttempt = (overrides: Record<string, unknown> = {}) => ({
    id: "att_sim",
    payerWallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    expectedAmountUsdcMinor: "5000000",
    txHash: null,
    status: "confirmed",
    createdAt: "2026-07-21T10:00:00.000Z",
    expiresAt: "2026-07-21T10:30:00.000Z",
    confirmedAt: "2026-07-21T10:00:00.000Z",
    failureReason: null,
    simulated: true,
    ...overrides,
  });

  // What the route actually answers with: a plain SellerLinkView — no
  // confirmedPaymentCount, no attempts array.
  const simulatedLink = (overrides: Record<string, unknown> = {}) => ({
    id: "internal-uuid",
    publicId: "p1",
    title: "Credits",
    description: null,
    asset: "USDC",
    amountUsdcMinor: "5000000",
    amountUsdc: "5.00",
    destinationWallet: receiving,
    chainId: 84532,
    linkType: "single",
    status: "paid",
    payUrl: "https://pay.example/p1",
    metadata: { orderId: "A-1" },
    clientReferenceId: "cart_42",
    returnUrl: null,
    cancelUrl: null,
    createdAt: "2026-07-21T09:00:00.000Z",
    archivedAt: null,
    ...overrides,
  });

  const simulateFetch = (
    body: unknown = { attempt: simulatedAttempt(), link: simulatedLink() },
    status = 201,
    headers: Record<string, string> = {},
  ) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
    );

  it("POSTs to the simulate-payment route with the bearer key", async () => {
    const fetchFn = simulateFetch();
    const client = new PeerPay({
      apiKey: TEST_KEY,
      baseUrl: "http://localhost:3000",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await client.checkout.simulatePayment("a b/c");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/links/a%20b%2Fc/simulate-payment");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_KEY}`);
    // The body is optional server-side; an empty object keeps the request valid
    // JSON so a strict proxy or parser has nothing to choke on.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("sends payerWallet only when the caller supplies one", async () => {
    const fetchFn = simulateFetch();
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await client.checkout.simulatePayment("p1", { payerWallet: other });

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ payerWallet: other });
  });

  it("returns a CheckoutSession that already reports paid — the point of simulating", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch() as unknown as typeof fetch,
    });

    const session = await client.checkout.simulatePayment("p1");

    // The route's `link` carries neither confirmedPaymentCount nor attempts, so
    // mapping it alone would answer `paid: false` straight after minting a
    // confirmed payment. The attempt from the same response supplies both.
    expect(session).toMatchObject({
      publicId: "p1",
      status: "paid",
      paid: true,
      confirmedPaymentCount: 1,
      metadata: { orderId: "A-1" },
      clientReferenceId: "cart_42",
    });
    expect(session.attempts).toEqual([
      {
        id: "att_sim",
        status: "confirmed",
        txHash: null,
        payerWallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        createdAt: "2026-07-21T10:00:00.000Z",
        confirmedAt: "2026-07-21T10:00:00.000Z",
        failureReason: null,
        simulated: true,
      },
    ]);
  });

  it("marks the attempt simulated and leaves txHash null — there is no transaction", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch() as unknown as typeof fetch,
    });

    const session = await client.checkout.simulatePayment("p1");

    expect(session.attempts[0]?.simulated).toBe(true);
    expect(session.attempts[0]?.txHash).toBeNull();
  });

  it("reports a reusable link as paid too, even though it stays active", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch({
        attempt: simulatedAttempt(),
        link: simulatedLink({ linkType: "reusable", status: "active" }),
      }) as unknown as typeof fetch,
    });

    const session = await client.checkout.simulatePayment("p1");

    expect(session).toMatchObject({ linkType: "reusable", status: "active", paid: true });
  });

  it("names the test-key requirement on 403", async () => {
    const client = new PeerPay({
      apiKey: LIVE_KEY,
      baseUrl: "https://prod.example",
      fetchFn: simulateFetch(
        { error: "simulate-payment requires a test-mode API key (pp_sk_test_…)." },
        403,
      ) as unknown as typeof fetch,
    });

    const error = await client.checkout.simulatePayment("p1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("test-mode key");
    expect((error as Error).message).toContain("live key");
  });

  it("names both causes of a 404 — missing link or a mainnet deployment", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch({ error: "Not found." }, 404) as unknown as typeof fetch,
    });

    const error = await client.checkout.simulatePayment("missing-id").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayNotFoundError);
    expect((error as Error).message).toContain("missing-id");
    expect((error as Error).message).toContain("mainnet");
    // The live-key hint belongs to 403 only; on a 404 it would send the reader
    // off to check the key when the link id or the network is the real cause.
    expect((error as Error).message).not.toContain("pp_sk_test_");
  });

  it("surfaces the 409 for an already-paid link as a config error with the server text", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch(
        { error: "This payment link is already paid and cannot take another payment." },
        409,
      ) as unknown as typeof fetch,
    });

    const error = await client.checkout.simulatePayment("p1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("already paid");
  });

  it("uses the shared mapping for 422 and 429 like every other method", async () => {
    const invalid = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch(
        {
          error: "Simulated payment input is invalid.",
          issues: [
            { path: "payerWallet", message: "payerWallet must be a valid EVM wallet address" },
          ],
        },
        422,
      ) as unknown as typeof fetch,
    });
    const validationError = await invalid.checkout
      .simulatePayment("p1", { payerWallet: "nope" })
      .catch((e: unknown) => e);
    expect(validationError).toBeInstanceOf(PeerPayValidationError);
    expect((validationError as PeerPayValidationError).issues).toEqual([
      { path: "payerWallet", message: "payerWallet must be a valid EVM wallet address" },
    ]);

    const limited = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch({ error: "rate limited" }, 429, {
        "Retry-After": "9",
      }) as unknown as typeof fetch,
    });
    const rateLimitError = await limited.checkout
      .simulatePayment("p1")
      .catch((e: unknown) => e);
    expect(rateLimitError).toBeInstanceOf(PeerPayRateLimitError);
    expect((rateLimitError as PeerPayRateLimitError).retryAfterSeconds).toBe(9);
  });

  it("rejects an empty publicId before touching the network", async () => {
    const fetchFn = simulateFetch();
    const client = new PeerPay({ apiKey: TEST_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await expect(client.checkout.simulatePayment("  ")).rejects.toBeInstanceOf(
      PeerPayConfigError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when the 201 body carries no link or no attempt", async () => {
    const noLink = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch({ attempt: simulatedAttempt() }) as unknown as typeof fetch,
    });
    await expect(noLink.checkout.simulatePayment("p1")).rejects.toBeInstanceOf(
      PeerPayConfigError,
    );

    // Without the attempt the merged session would claim `paid: false` right
    // after a payment was minted — worse than an error.
    const noAttempt = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: simulateFetch({ link: simulatedLink() }) as unknown as typeof fetch,
    });
    const error = await noAttempt.checkout.simulatePayment("p1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("no attempt");
  });

  it("raises PeerPayConfigError when the transport itself fails", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(client.checkout.simulatePayment("p1")).rejects.toBeInstanceOf(
      PeerPayConfigError,
    );
  });
});
