import { describe, expect, it, vi } from "vitest";

import { GenesisPay } from "./client.js";
import {
  GenesisPayConfigError,
  GenesisPayNetworkSafetyError,
  GenesisPayNotFoundError,
  GenesisPayValidationError,
} from "./errors.js";

const TEST_KEY = `gp_sk_test_${"a".repeat(32)}`;
const receiving = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";

const productView = (overrides: Record<string, unknown> = {}) => ({
  publicId: "prod_1",
  name: "Market data report",
  description: null,
  imageUrl: null,
  sku: "MDR-1",
  asset: "USDC",
  price: "2.00",
  priceMinor: "2000000",
  archived: false,
  fulfilmentUrl: null,
  fulfilmentVerifiedAt: null,
  createdAt: "2026-08-11T10:00:00.000Z",
  ...overrides,
});

const linkView = (overrides: Record<string, unknown> = {}) => ({
  publicId: "inv_1",
  payUrl: "https://pay.example/pay/inv_1",
  amount: "2.00",
  amountUsdc: "2.00",
  asset: "USDC",
  title: "Market data report",
  metadata: null,
  clientReferenceId: null,
  returnUrl: null,
  cancelUrl: null,
  destinationWallet: receiving,
  chainId: 84532,
  ...overrides,
});

const jsonFetch = (value: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

const clientFor = (
  fetchFn: ReturnType<typeof jsonFetch>,
  options: Record<string, unknown> = {},
) =>
  new GenesisPay({
    apiKey: TEST_KEY,
    baseUrl: "http://localhost:3000",
    fetchFn: fetchFn as unknown as typeof fetch,
    ...options,
  });

describe("products.create", () => {
  it("sends only the fields the caller set and returns the mapped product", async () => {
    const fetchFn = jsonFetch({ product: productView() }, 201);
    const client = clientFor(fetchFn);

    const product = await client.products.create({
      name: "Market data report",
      price: "2.00",
      sku: "MDR-1",
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/products");
    expect(init.method).toBe("POST");
    // Unset optionals stay ABSENT — the server's schema owns the defaults.
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Market data report",
      price: "2.00",
      sku: "MDR-1",
    });

    expect(product.publicId).toBe("prod_1");
    expect(product.price).toBe("2.00");
    expect(product.priceMinor).toBe("2000000");
    expect(product.archived).toBe(false);
  });

  it("maps a 422 to GenesisPayValidationError", async () => {
    const fetchFn = jsonFetch(
      { error: "That product is not valid.", code: "invalid_request" },
      422,
    );
    const client = clientFor(fetchFn);

    await expect(
      client.products.create({ name: "", price: "x" }),
    ).rejects.toBeInstanceOf(GenesisPayValidationError);
  });

  it("throws GenesisPayConfigError when a 2xx carries no product", async () => {
    const client = clientFor(jsonFetch({ ok: true }, 201));

    await expect(
      client.products.create({ name: "A", price: "1" }),
    ).rejects.toBeInstanceOf(GenesisPayConfigError);
  });
});

describe("products.list", () => {
  it("returns mapped products and drops only unusable rows", async () => {
    const fetchFn = jsonFetch({
      products: [productView(), { junk: true }, null, productView({ publicId: "prod_2" })],
    });
    const client = clientFor(fetchFn);

    const products = await client.products.list();

    expect(products.map((product) => product.publicId)).toEqual(["prod_1", "prod_2"]);
  });

  it("passes includeArchived through as a query parameter", async () => {
    const fetchFn = jsonFetch({ products: [] });
    const client = clientFor(fetchFn);

    await client.products.list({ includeArchived: true });

    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:3000/api/v1/products?includeArchived=true");
  });

  it("treats a 200 without a products array as a broken contract, not an empty list", async () => {
    const client = clientFor(jsonFetch({ ok: true }));

    await expect(client.products.list()).rejects.toBeInstanceOf(GenesisPayConfigError);
  });
});

describe("products.retrieve / update / archive", () => {
  it("maps a 404 to GenesisPayNotFoundError with the product wording", async () => {
    const fetchFn = jsonFetch({ error: "Product not found.", code: "not_found" }, 404);
    const client = clientFor(fetchFn);

    await expect(client.products.retrieve("prod_missing")).rejects.toMatchObject({
      constructor: GenesisPayNotFoundError,
      message: expect.stringContaining('No GenesisPay product with publicId "prod_missing"'),
    });
  });

  it("PATCHes the fulfilment URL, null included", async () => {
    const fetchFn = jsonFetch({ product: productView({ fulfilmentUrl: null }) });
    const client = clientFor(fetchFn);

    await client.products.update("prod_1", { fulfilmentUrl: null });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/products/prod_1");
    expect(init.method).toBe("PATCH");
    // `null` must survive serialization — it is the "clear it" instruction.
    expect(JSON.parse(init.body as string)).toEqual({ fulfilmentUrl: null });
  });

  it("archives via the POST subresource", async () => {
    const fetchFn = jsonFetch({ product: productView({ archived: true }) });
    const client = clientFor(fetchFn);

    const product = await client.products.archive("prod_1");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/products/prod_1/archive");
    expect(init.method).toBe("POST");
    expect(product.archived).toBe(true);
  });

  it("refuses an empty publicId before any request leaves", async () => {
    const fetchFn = jsonFetch({ product: productView() });
    const client = clientFor(fetchFn);

    await expect(client.products.retrieve("  ")).rejects.toBeInstanceOf(
      GenesisPayConfigError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("products.createPaymentLink", () => {
  it("returns the mapped canonical link and the created flag", async () => {
    const fetchFn = jsonFetch({ link: linkView(), created: true }, 201);
    const client = clientFor(fetchFn);

    const minted = await client.products.createPaymentLink("prod_1");

    expect(minted.created).toBe(true);
    expect(minted.link.publicId).toBe("inv_1");
    expect(minted.link.payUrl).toBe("https://pay.example/pay/inv_1");
    expect(minted.link.amount).toBe("2.00");
  });

  it("reports created:false only from an explicit true", async () => {
    // A proxy that drops the field must not turn every idempotent re-mint
    // into "a fresh link was created".
    const client = clientFor(jsonFetch({ link: linkView() }, 200));

    const minted = await client.products.createPaymentLink("prod_1");

    expect(minted.created).toBe(false);
  });

  it("applies the expectedPayTo pin to the minted link's destination", async () => {
    const fetchFn = jsonFetch({ link: linkView({ destinationWallet: other }), created: true }, 201);
    const client = clientFor(fetchFn, { expectedPayTo: receiving });

    await expect(client.products.createPaymentLink("prod_1")).rejects.toBeInstanceOf(
      GenesisPayNetworkSafetyError,
    );
  });

  it("fails closed when the pin is set and the mint response omits the wallet", async () => {
    // Bypass-by-omission: a response with destinationWallet stripped must not
    // pass for a match — absent is what the pin cannot vouch for.
    const fetchFn = jsonFetch(
      { link: linkView({ destinationWallet: undefined }), created: true },
      201,
    );
    const client = clientFor(fetchFn, { expectedPayTo: receiving });

    await expect(client.products.createPaymentLink("prod_1")).rejects.toBeInstanceOf(
      GenesisPayNetworkSafetyError,
    );
  });

  it("still mints without any check when no pin is configured", async () => {
    const fetchFn = jsonFetch(
      { link: linkView({ destinationWallet: undefined }), created: true },
      201,
    );
    const client = clientFor(fetchFn);

    await expect(client.products.createPaymentLink("prod_1")).resolves.toMatchObject({
      created: true,
    });
  });

  it("throws GenesisPayConfigError when a 2xx carries no link", async () => {
    const client = clientFor(jsonFetch({ created: true }, 201));

    await expect(client.products.createPaymentLink("prod_1")).rejects.toBeInstanceOf(
      GenesisPayConfigError,
    );
  });
});

describe("products.checkoutUrl", () => {
  it("resolves the canonical link's payUrl in one call", async () => {
    const fetchFn = jsonFetch({ link: linkView(), created: false }, 200);
    const client = clientFor(fetchFn);

    const url = await client.products.checkoutUrl("prod_1");

    expect(url).toBe("https://pay.example/pay/inv_1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("requires the publicId like every other product method", async () => {
    const fetchFn = jsonFetch({ link: linkView() }, 200);
    const client = clientFor(fetchFn);

    await expect(client.products.checkoutUrl("  ")).rejects.toBeInstanceOf(
      GenesisPayConfigError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("products.permalink", () => {
  it("builds the permanent product URL from the client's base URL", () => {
    const fetchFn = jsonFetch({ link: linkView() }, 200);
    const client = clientFor(fetchFn, { baseUrl: "https://pay.example" });

    expect(client.products.permalink("prod_1")).toBe(
      "https://pay.example/pay/p/prod_1",
    );
  });

  it("makes no network call and mints nothing", () => {
    const fetchFn = jsonFetch({ link: linkView() }, 200);
    const client = clientFor(fetchFn);

    client.products.permalink("prod_1");

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("encodes the publicId into the path", () => {
    const client = clientFor(jsonFetch({}), { baseUrl: "https://pay.example/" });

    expect(client.products.permalink("prod_ a/1")).toBe(
      "https://pay.example/pay/p/prod_%20a%2F1",
    );
  });

  it("requires the publicId like every other product method", () => {
    const client = clientFor(jsonFetch({}));

    expect(() => client.products.permalink("")).toThrow(GenesisPayConfigError);
  });
});

describe("products.gate", () => {
  it("MR-201/MR-202: settles an in-flight retry after the registered URL changes", async () => {
    const oldUrl = "https://predictionengine.xyz/api/v1/forecast";
    const newUrl = "https://predictionengine.xyz/api/v1/forecast-v2";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            transaction: `0x${"ab".repeat(32)}`,
            paymentAttemptId: "attempt_1",
            extensions: { idempotentReplay: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "PAYMENT-RESPONSE": "receipt" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            product: productView({
              delivery: { type: "gate", resourceUrl: newUrl, method: "POST" },
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = clientFor(fetchFn as never);

    const response = await client.products.gate("prod_1").protect(
      new Request(oldUrl, {
        method: "POST",
        body: "{}",
        headers: { "PAYMENT-SIGNATURE": "signed-payload" },
      }),
      async (_request, purchase) => {
        expect(purchase.payment.attemptId).toBe("attempt_1");
        expect(purchase.payment.idempotentReplay).toBe(true);
        return new Response("forecast");
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("forecast");
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("receipt");
    const [gateUrl, gateInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(gateUrl).toBe("http://localhost:3000/api/v1/products/prod_1/x402");
    expect(JSON.parse(gateInit.body as string)).toMatchObject({
      action: "settle",
      resourceUrl: oldUrl,
      method: "POST",
      paymentSignature: "signed-payload",
    });
  });
});
