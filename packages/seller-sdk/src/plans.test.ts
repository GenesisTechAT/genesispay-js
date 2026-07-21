import { describe, expect, it, vi } from "vitest";

import { PeerPay } from "./client.js";
import {
  PeerPayConfigError,
  PeerPayNetworkSafetyError,
  PeerPayNotFoundError,
  PeerPayRateLimitError,
  PeerPayValidationError,
} from "./errors.js";

const TEST_KEY = `pp_sk_test_${"a".repeat(32)}`;
const receiving = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";

const planView = (overrides: Record<string, unknown> = {}) => ({
  id: "internal-uuid",
  publicId: "plan_1",
  title: "Pro",
  description: "Everything in Pro",
  asset: "USDC",
  amountPerPeriod: "9.00",
  amountPerPeriodMinor: "9000000",
  periodDays: 30,
  prepaidCycles: 12,
  capPerChargeMinor: "9000000",
  allowanceMinor: "108000000",
  destinationWallet: receiving,
  chainId: 84532,
  status: "active",
  checkoutUrl: "https://pay.example/subscribe/plan_1",
  createdAt: "2026-07-21T10:00:00.000Z",
  archivedAt: null,
  ...overrides,
});

const jsonFetch = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );

const clientFor = (fetchFn: ReturnType<typeof jsonFetch>, baseUrl = "http://localhost:3000") =>
  new PeerPay({ apiKey: TEST_KEY, baseUrl, fetchFn: fetchFn as unknown as typeof fetch });

describe("plans.create", () => {
  it("sends only the fields the caller set and returns the mapped plan", async () => {
    const fetchFn = jsonFetch({ plan: planView() }, 201);
    const client = clientFor(fetchFn);

    const plan = await client.plans.create({
      title: "Pro",
      amountPerPeriod: "9",
      periodDays: 30,
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/plans");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_KEY}`);
    // Omitted optionals stay omitted so the server's own defaults apply — an
    // explicit `undefined` would be a different request than "not specified".
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Pro",
      amountPerPeriod: "9",
      periodDays: 30,
    });

    expect(plan).toEqual({
      id: "internal-uuid",
      publicId: "plan_1",
      title: "Pro",
      description: "Everything in Pro",
      asset: "USDC",
      amountPerPeriod: "9.00",
      amountPerPeriodMinor: "9000000",
      periodDays: 30,
      prepaidCycles: 12,
      capPerChargeMinor: "9000000",
      allowanceMinor: "108000000",
      destinationWallet: receiving,
      chainId: 84532,
      status: "active",
      checkoutUrl: "https://pay.example/subscribe/plan_1",
      createdAt: "2026-07-21T10:00:00.000Z",
      archivedAt: null,
    });
  });

  it("fails closed when the created plan's wallet does not match expectedPayTo", async () => {
    // A plan's destinationWallet is where every future renewal settles. The pin
    // used to cover only the /api/v1/seller lookup, which is not where that
    // address gets frozen.
    const client = new PeerPay({
      apiKey: TEST_KEY,
      baseUrl: "http://localhost:3000",
      expectedPayTo: receiving,
      fetchFn: jsonFetch(
        { plan: planView({ destinationWallet: other }) },
        201,
      ) as unknown as typeof fetch,
    });

    await expect(
      client.plans.create({ title: "Pro", amountPerPeriod: "9", periodDays: 30 }),
    ).rejects.toBeInstanceOf(PeerPayNetworkSafetyError);
  });

  it("accepts a created plan whose wallet matches expectedPayTo", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      baseUrl: "http://localhost:3000",
      // Casing must not matter — the server returns a checksummed address.
      expectedPayTo: receiving.toUpperCase().replace("0X", "0x"),
      fetchFn: jsonFetch(
        { plan: planView({ destinationWallet: receiving }) },
        201,
      ) as unknown as typeof fetch,
    });

    await expect(
      client.plans.create({ title: "Pro", amountPerPeriod: "9", periodDays: 30 }),
    ).resolves.toMatchObject({ publicId: "plan_1" });
  });

  it("forwards every optional field, including prepaidCycles: 0", async () => {
    const fetchFn = jsonFetch({ plan: planView() }, 201);
    const client = clientFor(fetchFn);

    await client.plans.create({
      title: "Pro",
      amountPerPeriod: "9",
      periodDays: 30,
      description: "Everything in Pro",
      // 0 is falsy but a deliberate value; it must not be dropped like an unset field.
      prepaidCycles: 0,
      destinationWallet: other,
      asset: "EURC",
    });

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Pro",
      amountPerPeriod: "9",
      periodDays: 30,
      description: "Everything in Pro",
      prepaidCycles: 0,
      destinationWallet: other,
      asset: "EURC",
    });
  });

  it("exposes checkoutUrl — the hosted flow is the reason to call the API at all", async () => {
    const client = clientFor(jsonFetch({ plan: planView() }, 201));

    const plan = await client.plans.create({
      title: "Pro",
      amountPerPeriod: "9",
      periodDays: 30,
    });

    expect(plan.checkoutUrl).toBe("https://pay.example/subscribe/plan_1");
  });

  it("raises PeerPayValidationError with the server issues on 422", async () => {
    const client = clientFor(
      jsonFetch(
        {
          error: "Subscription plan input is invalid.",
          issues: [{ path: "periodDays", message: "periodDays must be at least 1 day" }],
        },
        422,
      ),
    );

    const error = await client.plans
      .create({ title: "Pro", amountPerPeriod: "9", periodDays: 0 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayValidationError);
    expect((error as PeerPayValidationError).issues).toEqual([
      { path: "periodDays", message: "periodDays must be at least 1 day" },
    ]);
  });

  it("raises PeerPayRateLimitError with Retry-After on 429", async () => {
    const client = clientFor(jsonFetch({ error: "rate limited" }, 429, { "Retry-After": "12" }));

    const error = await client.plans
      .create({ title: "Pro", amountPerPeriod: "9", periodDays: 30 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayRateLimitError);
    expect((error as PeerPayRateLimitError).retryAfterSeconds).toBe(12);
  });

  it("throws when the 201 body carries no plan", async () => {
    const client = clientFor(jsonFetch({}, 201));

    await expect(
      client.plans.create({ title: "Pro", amountPerPeriod: "9", periodDays: 30 }),
    ).rejects.toBeInstanceOf(PeerPayConfigError);
  });

  it("raises PeerPayConfigError when the transport itself fails", async () => {
    const client = new PeerPay({
      apiKey: TEST_KEY,
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(
      client.plans.create({ title: "Pro", amountPerPeriod: "9", periodDays: 30 }),
    ).rejects.toBeInstanceOf(PeerPayConfigError);
  });
});

describe("plans.list", () => {
  it("GETs the collection and maps every plan", async () => {
    const fetchFn = jsonFetch({
      plans: [planView(), planView({ publicId: "plan_2", status: "archived" })],
    });
    const client = clientFor(fetchFn);

    const plans = await client.plans.list();

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/plans");
    expect(init.method).toBe("GET");
    expect(plans.map((plan) => plan.publicId)).toEqual(["plan_1", "plan_2"]);
    expect(plans[1]?.status).toBe("archived");
  });

  it("returns an empty array for an account without plans", async () => {
    const client = clientFor(jsonFetch({ plans: [] }));

    await expect(client.plans.list()).resolves.toEqual([]);
  });

  it("skips unusable rows instead of losing the whole list", async () => {
    const client = clientFor(
      jsonFetch({ plans: [null, "nope", { title: "no publicId" }, planView()] }),
    );

    const plans = await client.plans.list();

    expect(plans).toHaveLength(1);
    expect(plans[0]?.publicId).toBe("plan_1");
  });

  it("throws when the body has no plans array — that is a broken contract, not 'no plans'", async () => {
    const client = clientFor(jsonFetch({ plans: { nope: true } }));

    await expect(client.plans.list()).rejects.toBeInstanceOf(PeerPayConfigError);
  });
});

describe("plans.retrieve", () => {
  it("URL-encodes the publicId and sends the bearer key", async () => {
    const fetchFn = jsonFetch({ plan: planView({ publicId: "a b/c" }) });
    const client = clientFor(fetchFn);

    await client.plans.retrieve("a b/c");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/plans/a%20b%2Fc");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it("raises PeerPayNotFoundError on 404, naming the id", async () => {
    const client = clientFor(jsonFetch({ error: "Subscription plan not found." }, 404));

    const error = await client.plans.retrieve("plan_missing").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerPayNotFoundError);
    expect(error).not.toBeInstanceOf(PeerPayConfigError);
    expect((error as Error).message).toContain("plan_missing");
  });

  it("stays tolerant of a backend that omits fields this SDK knows about", async () => {
    const legacy = planView() as Record<string, unknown>;
    delete legacy.description;
    delete legacy.archivedAt;
    delete legacy.prepaidCycles;
    const client = clientFor(jsonFetch({ plan: legacy }));

    await expect(client.plans.retrieve("plan_1")).resolves.toMatchObject({
      description: null,
      archivedAt: null,
      prepaidCycles: 0,
      publicId: "plan_1",
    });
  });

  it("keeps amounts as strings and never routes them through a float", async () => {
    const client = clientFor(
      jsonFetch({
        plan: planView({
          amountPerPeriod: "0.100000",
          amountPerPeriodMinor: "100000",
          allowanceMinor: "9007199254740993",
        }),
      }),
    );

    const plan = await client.plans.retrieve("plan_1");

    expect(plan.amountPerPeriod).toBe("0.100000");
    expect(plan.amountPerPeriodMinor).toBe("100000");
    // Beyond Number.MAX_SAFE_INTEGER — a numeric round-trip would change it.
    expect(plan.allowanceMinor).toBe("9007199254740993");
  });

  it("degrades an unknown status to archived, not active", async () => {
    // Fail closed: a status this SDK version does not know (a future "paused",
    // "deleted", …) must not read as "keep sending customers to checkoutUrl".
    const client = clientFor(jsonFetch({ plan: planView({ status: "who_knows" }) }));

    await expect(client.plans.retrieve("plan_1")).resolves.toMatchObject({
      status: "archived",
    });
  });

  it("rejects an empty publicId before touching the network", async () => {
    const fetchFn = jsonFetch({ plan: planView() });
    const client = clientFor(fetchFn);

    await expect(client.plans.retrieve("   ")).rejects.toBeInstanceOf(PeerPayConfigError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws when the 200 body carries no plan", async () => {
    const client = clientFor(jsonFetch({}));

    await expect(client.plans.retrieve("plan_1")).rejects.toBeInstanceOf(PeerPayConfigError);
  });
});

describe("plans.archive", () => {
  it("POSTs to the archive route without a body and returns the archived plan", async () => {
    const fetchFn = jsonFetch({
      plan: planView({ status: "archived", archivedAt: "2026-07-22T08:00:00.000Z" }),
    });
    const client = clientFor(fetchFn);

    const plan = await client.plans.archive("plan_1");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/plans/plan_1/archive");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(plan).toMatchObject({ status: "archived", archivedAt: "2026-07-22T08:00:00.000Z" });
  });

  it("raises PeerPayNotFoundError on 404", async () => {
    const client = clientFor(jsonFetch({ error: "Subscription plan not found." }, 404));

    await expect(client.plans.archive("plan_missing")).rejects.toBeInstanceOf(
      PeerPayNotFoundError,
    );
  });

  it("rejects an empty publicId before touching the network", async () => {
    const fetchFn = jsonFetch({ plan: planView() });
    const client = clientFor(fetchFn);

    await expect(client.plans.archive("")).rejects.toBeInstanceOf(PeerPayConfigError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
