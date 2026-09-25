import { describe, expect, it, vi } from "vitest";

import { GenesisPay } from "./client.js";
import {
  GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
  decodeSettlementResponseHeader,
  encodePaymentSignatureHeader,
  encodeSettlementPrepareParamsHeader,
} from "@genesis-tech/genesispay-protocol";
import {
  GenesisPayConfigError,
  GenesisPayNetworkSafetyError,
  GenesisPayNotFoundError,
  GenesisPayValidationError,
} from "./errors.js";
import {
  GENESISPAY_API_VERSION,
  GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER,
  GENESISPAY_REQUEST_ID_HEADER,
  GENESISPAY_VERSION_HEADER,
  type ExpectedProductContract,
} from "./fulfillment.js";

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
  it("MR-1204: carries item tax through product creation and conflict-checked updates", async () => {
    const taxConfig = { version: 1, treatment: "taxable", rateBps: 2000, note: null } as const;
    const fetchFn = jsonFetch({ product: productView({ taxConfig }) }, 201);
    const client = clientFor(fetchFn);
    const product = await client.products.create({ name: "Taxed product", price: "1.20", taxConfig });
    expect(product.taxConfig).toEqual(taxConfig);
    const [, creation] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(creation.body as string)).toEqual({ name: "Taxed product", price: "1.20", taxConfig });
    await client.products.update(product.publicId, { taxConfig, expectedTaxConfig: null });
    const [, update] = fetchFn.mock.calls[1] as unknown as [string, RequestInit];
    expect(update.method).toBe("PATCH");
    expect(JSON.parse(update.body as string)).toEqual({ taxConfig, expectedTaxConfig: null });
  });
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

describe("strict product contract and single-use checkout", () => {
  const expected: ExpectedProductContract = {
    kind: "product",
    productId: "prod_1",
    sku: "MDR-1",
    grossAmountMinor: 2_000_000n,
    network: {
      mode: "test",
      network: "base",
      chainId: 84532,
      asset: "USDC",
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      minorUnitScale: 6,
    },
    settlementDestination: receiving,
    delivery: { type: "url", url: "https://seller.example/delivery", gate: null },
  };

  const strictResponse = (body: Record<string, unknown>, status = 200) =>
    new Response(
      JSON.stringify({ ...body, requestId: "req_product", apiVersion: GENESISPAY_API_VERSION }),
      {
        status,
        headers: {
          "content-type": "application/json",
          [GENESISPAY_REQUEST_ID_HEADER]: "req_product",
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
          "cache-control": "no-store",
        },
      },
    );

  const contract = (overrides: Record<string, unknown> = {}) => ({
    object: "product_contract",
    productId: "prod_1",
    sku: "MDR-1",
    grossAmountMinor: "2000000",
    network: expected.network,
    settlementDestination: receiving,
    delivery: expected.delivery,
    ...overrides,
  });

  const gateExpected = {
    ...expected,
    delivery: {
      type: "gate" as const,
      url: null,
      gate: {
        method: "POST" as const,
        resourceUrl: "https://seller.example/gate",
        fingerprint: `sha256:${"a".repeat(64)}`,
      },
    },
  };

  it.each(["assertContract", "createCheckout"] as const)(
    "MR-103: %s refuses a contract outside expectedPayTo before the request",
    async (operation) => {
      const fetchFn = vi.fn(async () => strictResponse({
        contract: contract(),
        object: "product_checkout_link",
        linkId: "inv_single_1",
        payUrl: "https://pay.example/pay/inv_single_1",
        productContractVersion: GENESISPAY_API_VERSION,
        created: true,
      }));
      const client = clientFor(fetchFn as never, { expectedPayTo: other });
      const result = operation === "assertContract"
        ? client.products.assertContract(expected)
        : client.products.createCheckout({ expected }, { idempotencyKey: "pinned-order" });

      await expect(result).rejects.toBeInstanceOf(GenesisPayNetworkSafetyError);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("MR-202: asserts a gate contract by method and resource URL (no request fingerprint)", async () => {
    // The product contract the backend emits carries the gate's static identity
    // — method and canonical resource URL — but never a request fingerprint,
    // which is derived from one concrete request body. The readiness check must
    // not require a field the backend cannot send.
    const fetchFn = vi.fn(async () =>
      strictResponse({
        contract: contract({
          delivery: {
            type: "gate",
            url: null,
            gate: { method: "POST", resourceUrl: "https://seller.example/gate" },
          },
        }),
      }),
    );
    const client = clientFor(fetchFn as never);

    await expect(client.products.assertContract(gateExpected)).resolves.toBeUndefined();
  });

  it("MR-202: flags a gate contract whose resource URL drifted", async () => {
    const fetchFn = vi.fn(async () =>
      strictResponse({
        contract: contract({
          delivery: {
            type: "gate",
            url: null,
            gate: { method: "POST", resourceUrl: "https://seller.example/other" },
          },
        }),
      }),
    );
    const client = clientFor(fetchFn as never);

    await expect(client.products.assertContract(gateExpected)).rejects.toMatchObject({
      code: "contract_mismatch",
      mismatches: ["delivery.gate.resourceUrl"],
    });
  });

  it("asserts the complete current contract with strict request metadata", async () => {
    const fetchFn = vi.fn(async () => strictResponse({ contract: contract() }));
    const client = clientFor(fetchFn as never, { expectedPayTo: receiving });

    await expect(client.products.assertContract(expected)).resolves.toBeUndefined();

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/products/prod_1/contract");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get(GENESISPAY_VERSION_HEADER)).toBe(
      GENESISPAY_API_VERSION,
    );
  });

  it("throws a typed mismatch instead of silently accepting mutable catalogue drift", async () => {
    const fetchFn = vi.fn(async () =>
      strictResponse({ contract: contract({ sku: "MDR-2", grossAmountMinor: "2000001" }) }),
    );
    const client = clientFor(fetchFn as never);

    await expect(client.products.assertContract(expected)).rejects.toMatchObject({
      code: "contract_mismatch",
      mismatches: ["sku", "grossAmountMinor"],
      requestId: "req_product",
      apiVersion: GENESISPAY_API_VERSION,
    });
  });

  it("creates an explicit product_checkout_link with required seller-scoped idempotency", async () => {
    const fetchFn = vi.fn(async () =>
      strictResponse(
        {
          object: "product_checkout_link",
          linkId: "inv_single_1",
          payUrl: "https://pay.example/pay/inv_single_1",
          productContractVersion: GENESISPAY_API_VERSION,
          created: true,
        },
        201,
      ),
    );
    const client = clientFor(fetchFn as never, { expectedPayTo: receiving });

    const checkout = await client.products.createCheckout(
      {
        expected,
        clientReferenceId: "order_1",
        metadata: { buyer: "buyer_1" },
        returnUrl: "https://seller.example/thanks",
      },
      { idempotencyKey: "order-1-create" },
    );

    expect(checkout).toEqual({
      object: "product_checkout_link",
      linkId: "inv_single_1",
      payUrl: "https://pay.example/pay/inv_single_1",
      productContractVersion: GENESISPAY_API_VERSION,
      created: true,
      requestId: "req_product",
      apiVersion: GENESISPAY_API_VERSION,
    });
    expect(checkout).not.toHaveProperty("id");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/products/prod_1/checkouts");
    const headers = new Headers(init.headers);
    expect(headers.get("idempotency-key")).toBe("order-1-create");
    expect(headers.get(GENESISPAY_VERSION_HEADER)).toBe(GENESISPAY_API_VERSION);
    expect(JSON.parse(init.body as string)).toMatchObject({
      expected: { productId: "prod_1", grossAmountMinor: "2000000" },
      clientReferenceId: "order_1",
      metadata: { buyer: "buyer_1" },
    });
  });

  it("has no idempotency-free product checkout overload", async () => {
    const fetchFn = vi.fn(async () => strictResponse({}));
    const client = clientFor(fetchFn as never);

    // @ts-expect-error 1.0 money-bearing creation always requires caller idempotency.
    await expect(client.products.createCheckout({ expected })).rejects.toBeInstanceOf(
      GenesisPayValidationError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects malformed contract money before bigint parsing", async () => {
    const fetchFn = vi.fn(async () =>
      strictResponse({ contract: contract({ grossAmountMinor: "02000000" }) }),
    );
    const client = clientFor(fetchFn as never);
    await expect(client.products.assertContract(expected)).rejects.toMatchObject({
      code: "malformed_evidence",
    });
  });

  it("rejects wrong-typed product authority fields as malformed evidence", async () => {
    const fetchFn = vi.fn(async () =>
      strictResponse({
        contract: contract({ network: { ...expected.network, chainId: "84532" } }),
      }),
    );
    const client = clientFor(fetchFn as never);

    await expect(client.products.assertContract(expected)).rejects.toMatchObject({
      code: "malformed_evidence",
      requestId: "req_product",
    });
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
  it.each([false, true])(
    "MR-103: refuses an unpinned gate before challenge or settlement (signed=%s)",
    async (signed) => {
      const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
        method: "POST",
        body: "{}",
        ...(signed ? { headers: { "PAYMENT-SIGNATURE": "signed-payload" } } : {}),
      });
      const fetchFn = jsonFetch({ code: "must_not_request" }, 409);
      const client = clientFor(fetchFn, { expectedPayTo: other });
      const handler = vi.fn(async () => new Response("must not run"));

      await expect(client.products.gate("prod_1").protect(
        request, await expectedGate(request), handler,
      )).rejects.toBeInstanceOf(GenesisPayNetworkSafetyError);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("MR-201/MR-202: settles an in-flight retry after the registered URL changes", async () => {
    const oldUrl = "https://predictionengine.xyz/api/v1/forecast";
    const signedRequest = new Request(oldUrl, {
      method: "POST",
      body: "{}",
      headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const expected = await expectedGate(signedRequest);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            transaction: `0x${"ab".repeat(32)}`,
            paymentAttemptId: "attempt_1",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "PAYMENT-RESPONSE": "receipt",
              [GENESISPAY_REQUEST_ID_HEADER]: "req_settle",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "fulfillment_verification",
            verified: true,
            requestId: "req_verify",
            apiVersion: GENESISPAY_API_VERSION,
            evidence: gateEvidence(oldUrl, expected.delivery.gate!.fingerprint),
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              [GENESISPAY_REQUEST_ID_HEADER]: "req_verify",
              [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
            },
          },
        ),
      );
    const client = clientFor(fetchFn as never, { expectedPayTo: receiving });

    const response = await client.products.gate("prod_1").protect(
      signedRequest,
      expected,
      async (_request, purchase) => {
        expect(purchase.payment.attemptId).toBe("attempt_1");
        expect(purchase.payment.grossAmountMinor).toBe(2_000_000n);
        expect(purchase.payment.network.asset).toBe("USDC");
        expect(purchase.product.productId).toBe("prod_1");
        return new Response("forecast");
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("forecast");
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("receipt");
    const [gateUrl, gateInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(gateUrl).toBe("http://localhost:3000/api/v1/products/prod_1/x402");
    expect(new Headers(gateInit.headers).get(GENESISPAY_VERSION_HEADER)).toBe(
      GENESISPAY_API_VERSION,
    );
    expect(JSON.parse(gateInit.body as string)).toMatchObject({
      action: "settle",
      resourceUrl: oldUrl,
      method: "POST",
      paymentSignature: "signed-payload",
      requestFingerprint: expected.delivery.gate?.fingerprint.slice("sha256:".length),
    });
    expect(JSON.parse(gateInit.body as string)).not.toHaveProperty("expected");
    const [verifyUrl] = fetchFn.mock.calls[1] as [string];
    expect(verifyUrl).toBe("http://localhost:3000/api/v1/fulfillment/verify");
  });

  it.each(["request", "body"] as const)(
    "MR-202/MR-1106/MR-1302: bounds the initial signed product settlement %s",
    async (hang) => {
      vi.useFakeTimers();
      try {
        const planId = "22222222-2222-4222-8222-222222222222";
        const transactionHash = `0x${"e1".repeat(32)}` as const;
        const canonicalResourceUrl =
          "https://predictionengine.xyz/api/v1/forecast";
        const resourceUrl =
          `${canonicalResourceUrl}?gp_attempt=11111111-1111-4111-8111-111111111111`;
        const request = new Request(resourceUrl, {
          method: "POST",
          body: "{}",
          headers: {
            "PAYMENT-SIGNATURE": paymentSignatureWithResource(
              resourceUrl,
              transactionHash,
            ),
            "GENESISPAY-Settlement-Plan": planId,
          },
        });
        const expected = await expectedGate(
          new Request(canonicalResourceUrl, { method: "POST", body: "{}" }),
        );
        const fetchFn = hang === "request"
          ? vi.fn(() => new Promise<Response>(() => undefined))
          : vi.fn(async () =>
              new Response(new ReadableStream({ start: () => undefined }), {
                status: 202,
                headers: { "content-type": "application/json" },
              }));

        const pending = clientFor(fetchFn as never).products
          .gate("prod_1")
          .protect(
            request,
            expected,
            vi.fn(async () => new Response("must not run")),
          );
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(120_001);

        const response = await pending;
        expect(response.status).toBe(503);
        expect(
          decodeSettlementResponseHeader(
            response.headers.get("PAYMENT-RESPONSE") as string,
          ),
        ).toMatchObject({
          success: false,
          transaction: transactionHash,
          extensions: {
            authorizationVerified: false,
            settlementVerified: false,
            persistenceVerified: false,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("MR-1302/MR-1304: replays expired product acceptance and runs only after verified confirmation", async () => {
    const planId = "22222222-2222-4222-8222-222222222222";
    const canonicalResourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const resourceUrl = `${canonicalResourceUrl}?gp_attempt=11111111-1111-4111-8111-111111111111`;
    const signature = paymentSignatureWithResource(resourceUrl);
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": signature,
        "GENESISPAY-Settlement-Plan": planId,
      },
    });
    const expected = await expectedGate(new Request(canonicalResourceUrl, {
      method: "POST",
      body: "{}",
    }));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId,
            state: "queued",
            acceptedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() - 1).toISOString(),
            pollAfterMs: 100,
            statusUrl: `http://localhost:3000/api/v1/settlements/${planId}`,
          },
          {
            status: 202,
            headers: {
              [GENESISPAY_REQUEST_ID_HEADER]: "req_queue",
              [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId,
          state: "submitted",
          txHash: `0x${"a".repeat(64)}`,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId,
          state: "settled",
          txHash: `0x${"a".repeat(64)}`,
          settledAt: new Date().toISOString(),
          sellerTransferVerified: true,
          feeState: "settled",
        }),
      )
      .mockResolvedValueOnce(
        strictSettlementResponse("11111111-1111-4111-8111-111111111111"),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            object: "fulfillment_verification",
            verified: true,
            requestId: "req_verify",
            apiVersion: GENESISPAY_API_VERSION,
            evidence: {
              ...gateEvidence(canonicalResourceUrl, expected.delivery.gate!.fingerprint),
              attemptId: "11111111-1111-4111-8111-111111111111",
            },
          },
          {
            headers: {
              [GENESISPAY_REQUEST_ID_HEADER]: "req_verify",
              [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
            },
          },
        ),
      );
    const handler = vi.fn(async () => new Response("forecast"));

    const result = await clientFor(fetchFn as never).products.gate("prod_1")
      .protect(request, expected, handler);

    expect(result.status).toBe(200);
    expect(await result.text()).toBe("forecast");
    expect(handler).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      `http://localhost:3000/api/v1/settlements/${planId}`,
    );
    expect(JSON.parse((fetchFn.mock.calls[3]?.[1] as RequestInit).body as string)).toMatchObject({
      action: "settle",
      planId,
      paymentSignature: signature,
    });
  });

  it.each([
    ["failed", 409],
    ["expired", 410],
  ] as const)(
    "MR-1302: maps terminal %s polling state to a non-success gate response",
    async (state, expectedStatus) => {
      const planId = "22222222-2222-4222-8222-222222222222";
      const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
      const request = new Request(resourceUrl, {
        method: "POST",
        body: "{}",
        headers: {
          "PAYMENT-SIGNATURE": paymentSignatureWithResource(resourceUrl),
          "GENESISPAY-Settlement-Plan": planId,
        },
      });
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              version: 1,
              planId,
              state: "queued",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollAfterMs: 100,
            },
            { status: 202 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            { version: 1, planId, state, failureReason: `terminal ${state}` },
            {
              status: 200,
              headers: { "PAYMENT-RESPONSE": "must-not-escape" },
            },
          ),
        );
      const handler = vi.fn(async () => new Response("must not run"));

      const response = await clientFor(fetchFn as never).products
        .gate("prod_1")
        .protect(request, await expectedGate(request), handler);

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
      await expect(response.json()).resolves.toMatchObject({ state });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("MR-202/MR-1106: preserves the settled polling hash when the follow-up seller API call is lost", async () => {
    const planId = "22222222-2222-4222-8222-222222222222";
    const transactionHash = `0x${"d".repeat(64)}` as const;
    const canonicalResourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const resourceUrl = `${canonicalResourceUrl}?gp_attempt=11111111-1111-4111-8111-111111111111`;
    const signature = paymentSignatureWithResource(resourceUrl);
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": signature,
        "GENESISPAY-Settlement-Plan": planId,
      },
    });
    const expected = await expectedGate(
      new Request(canonicalResourceUrl, { method: "POST", body: "{}" }),
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 100,
            statusUrl: `http://localhost:3000/api/v1/settlements/${planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId,
          state: "settled",
          txHash: transactionHash,
          sellerTransferVerified: true,
        }),
      )
      .mockRejectedValueOnce(new Error("settled response lost"));

    const response = await clientFor(fetchFn as never).products
      .gate("prod_1")
      .protect(request, expected, vi.fn(async () => new Response("must not run")));

    expect(response.status).toBe(503);
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toMatchObject({
      success: false,
      transaction: transactionHash,
      extensions: {
        authorizationVerified: false,
        settlementVerified: false,
        persistenceVerified: false,
      },
    });
  });

  it.each(["request", "body"] as const)(
    "MR-202/MR-1106/MR-1302: bounds a hanging post-poll seller %s and preserves the settled hash",
    async (hang) => {
      vi.useFakeTimers();
      try {
        const planId = "22222222-2222-4222-8222-222222222222";
        const transactionHash = `0x${"e2".repeat(32)}` as const;
        const canonicalResourceUrl =
          "https://predictionengine.xyz/api/v1/forecast";
        const resourceUrl =
          `${canonicalResourceUrl}?gp_attempt=11111111-1111-4111-8111-111111111111`;
        const request = new Request(resourceUrl, {
          method: "POST",
          body: "{}",
          headers: {
            "PAYMENT-SIGNATURE": paymentSignatureWithResource(resourceUrl),
            "GENESISPAY-Settlement-Plan": planId,
          },
        });
        const expected = await expectedGate(
          new Request(canonicalResourceUrl, { method: "POST", body: "{}" }),
        );
        const fetchFn = vi
          .fn()
          .mockResolvedValueOnce(
            Response.json(
              {
                version: 1,
                planId,
                state: "queued",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                pollAfterMs: 100,
                statusUrl: `http://localhost:3000/api/v1/settlements/${planId}`,
              },
              { status: 202 },
            ),
          )
          .mockResolvedValueOnce(
            Response.json({
              version: 1,
              planId,
              state: "settled",
              txHash: transactionHash,
              sellerTransferVerified: true,
            }),
          );
        if (hang === "request") {
          fetchFn.mockImplementationOnce(
            () => new Promise<Response>(() => undefined),
          );
        } else {
          fetchFn.mockResolvedValueOnce(
            new Response(new ReadableStream({ start: () => undefined }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }

        const pending = clientFor(fetchFn as never).products
          .gate("prod_1")
          .protect(
            request,
            expected,
            vi.fn(async () => new Response("must not run")),
          );
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
        await vi.advanceTimersByTimeAsync(120_001);

        const response = await pending;
        expect(response.status).toBe(503);
        expect(
          decodeSettlementResponseHeader(
            response.headers.get("PAYMENT-RESPONSE") as string,
          ),
        ).toMatchObject({
          success: false,
          transaction: transactionHash,
          extensions: {
            authorizationVerified: false,
            settlementVerified: false,
            persistenceVerified: false,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("MR-103/MR-202/MR-1302: never credits product status for another plan", async () => {
    const planId = "22222222-2222-4222-8222-222222222222";
    const otherPlanId = "33333333-3333-4333-8333-333333333333";
    const transactionHash = `0x${"bd".repeat(32)}` as const;
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          resourceUrl,
          transactionHash,
        ),
        "GENESISPAY-Settlement-Plan": planId,
      },
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 100,
            statusUrl: `http://localhost:3000/api/v1/settlements/${planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          planId: otherPlanId,
          state: "settled",
          txHash: `0x${"be".repeat(32)}`,
          sellerTransferVerified: true,
        }),
      );
    const handler = vi.fn(async () => new Response("must not run"));

    const response = await clientFor(fetchFn as never).products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ state: "queued", planId });
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ).transaction,
    ).toBe(transactionHash);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-1302/MR-1304: returns the submitted hash as a 202 when later product polling fails", async () => {
    const planId = "22222222-2222-4222-8222-222222222222";
    const txHash = `0x${"b".repeat(64)}`;
    const canonicalResourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const resourceUrl = `${canonicalResourceUrl}?gp_attempt=11111111-1111-4111-8111-111111111111`;
    const signature = paymentSignatureWithResource(resourceUrl);
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": signature,
        "GENESISPAY-Settlement-Plan": planId,
      },
    });
    const expected = await expectedGate(
      new Request(canonicalResourceUrl, { method: "POST", body: "{}" }),
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 100,
            statusUrl: `http://localhost:3000/api/v1/settlements/${planId}`,
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ version: 1, planId, state: "submitted", txHash }),
      )
      .mockRejectedValueOnce(new Error("status endpoint unavailable"));
    const handler = vi.fn(async () => new Response("must not run"));

    const response = await clientFor(fetchFn as never).products
      .gate("prod_1")
      .protect(request, expected, handler);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      state: "submitted",
      txHash,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["request", "body"] as const)(
    "MR-1302/MR-1304: bounds a product status %s that never completes",
    async (hang) => {
      const planId = "22222222-2222-4222-8222-222222222222";
      const canonicalResourceUrl =
        "https://predictionengine.xyz/api/v1/forecast";
      const resourceUrl =
        `${canonicalResourceUrl}?gp_attempt=11111111-1111-4111-8111-111111111111`;
      const request = new Request(resourceUrl, {
        method: "POST",
        body: "{}",
        headers: {
          "PAYMENT-SIGNATURE": paymentSignatureWithResource(resourceUrl),
          "GENESISPAY-Settlement-Plan": planId,
        },
      });
      const expected = await expectedGate(
        new Request(canonicalResourceUrl, { method: "POST", body: "{}" }),
      );
      const fetchFn = vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            version: 1,
            planId,
            state: "queued",
            expiresAt: new Date(Date.now() + 50).toISOString(),
            pollAfterMs: 100,
            statusUrl: `http://localhost:3000/api/v1/settlements/${planId}`,
          },
          { status: 202 },
        ),
      );
      if (hang === "request") {
        fetchFn.mockImplementationOnce(
          () => new Promise<Response>(() => undefined),
        );
      } else {
        fetchFn.mockResolvedValueOnce(
          new Response(new ReadableStream({ start: () => undefined }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const handler = vi.fn(async () => new Response("must not run"));

      const response = await clientFor(fetchFn as never).products
        .gate("prod_1")
        .protect(request, expected, handler);

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        state: "queued",
        planId,
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unavailable", { status: 503, body: { error: "temporarily unavailable" } }],
    ["invalid", { status: 200, body: { state: "processing" } }],
    ["malformed-submitted", { status: 200, body: { state: "submitted", txHash: "bad" } }],
    ["conflicting-submitted", { status: 200, body: { state: "submitted", txHash: `0x${"d".repeat(64)}` } }],
    ["failed", { status: 200, body: { state: "failed" } }],
    ["expired", { status: 200, body: { state: "expired" } }],
  ] as const)(
    "MR-202/MR-1302/MR-1304: retains submitted product evidence after a later %s status",
    async (_case, later) => {
      const planId = "22222222-2222-4222-8222-222222222222";
      const txHash = `0x${"c".repeat(64)}`;
      const canonicalResourceUrl = "https://predictionengine.xyz/api/v1/forecast";
      const resourceUrl = `${canonicalResourceUrl}?gp_attempt=11111111-1111-4111-8111-111111111111`;
      const request = new Request(resourceUrl, {
        method: "POST",
        body: "{}",
        headers: {
          "PAYMENT-SIGNATURE": paymentSignatureWithResource(resourceUrl),
          "GENESISPAY-Settlement-Plan": planId,
        },
      });
      const expected = await expectedGate(
        new Request(canonicalResourceUrl, { method: "POST", body: "{}" }),
      );
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              version: 1,
              planId,
              state: "queued",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollAfterMs: 100,
              statusUrl: `http://localhost:3000/api/v1/settlements/${planId}`,
            },
            { status: 202 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ version: 1, planId, state: "submitted", txHash }),
        )
        .mockResolvedValueOnce(
          Response.json(
            { version: 1, planId, ...later.body },
            { status: later.status },
          ),
        );
      const handler = vi.fn(async () => new Response("must not run"));

      const response = await clientFor(fetchFn as never).products
        .gate("prod_1")
        .protect(request, expected, handler);

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        state: "submitted",
        txHash,
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("MR-202/MR-804: never runs the handler when strict verification is unavailable", async () => {
    const rawResponse = new Response(
      JSON.stringify({ success: true, paymentAttemptId: "attempt_1", transaction: `0x${"a".repeat(64)}`, requestId: "req_settle", apiVersion: GENESISPAY_API_VERSION }),
      {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": "settled-receipt",
          [GENESISPAY_REQUEST_ID_HEADER]: "req_settle",
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
        },
      },
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(rawResponse)
      .mockRejectedValueOnce(new Error("verification unavailable"));
    const client = clientFor(fetchFn as never);
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
      headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const handler = vi.fn(async () => new Response("must not run"));

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);
    const body = await result.json();

    expect(result.status).toBe(503);
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe("attempt_1");
    expect(result.headers.get("retry-after")).toBe("2");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settled-receipt");
    expect(body).toMatchObject({
      error: { code: "fulfillment_evidence_unavailable", retryable: true },
      paymentAttemptId: "attempt_1",
      requestId: "req_settle",
      apiVersion: GENESISPAY_API_VERSION,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-804: retries a verification stream failure after a strict confirmed settlement", async () => {
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST", body: "{}", headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(strictSettlementResponse("attempt_1"))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError("terminated: socket closed")); },
      }), { headers: {
        [GENESISPAY_REQUEST_ID_HEADER]: "req_verify",
        [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
      } }));
    const handler = vi.fn(async () => new Response("must not run"));
    const result = await clientFor(fetchFn as never).products.gate("prod_1")
      .protect(request, await expectedGate(request), handler);
    expect(result.headers.get("retry-after")).toBe("2");
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "fulfillment_evidence_unavailable", retryable: true },
      paymentAttemptId: "attempt_1", requestId: "req_verify",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["not_confirmed", "not_found"])(
    "MR-804: verification %s cannot be described as a confirmed payment",
    async (reason) => {
      const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
        method: "POST", body: "{}", headers: { "PAYMENT-SIGNATURE": "signed-payload" },
      });
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(strictSettlementResponse("attempt_1"))
        .mockResolvedValueOnce(Response.json({
          object: "fulfillment_verification", verified: false, reason,
          requestId: "req_verify", apiVersion: GENESISPAY_API_VERSION,
        }, { headers: {
          [GENESISPAY_REQUEST_ID_HEADER]: "req_verify",
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
        } }));
      const handler = vi.fn(async () => new Response("must not run"));
      const result = await clientFor(fetchFn as never).products.gate("prod_1")
        .protect(request, await expectedGate(request), handler);
      expect(result.headers.get("retry-after")).toBe("2");
      const body = await result.json();
      expect(body).toMatchObject({
        error: { code: "settlement_outcome_unknown", retryable: true },
        paymentAttemptId: "attempt_1",
      });
      expect(body.error.message).not.toContain("Payment was confirmed");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("MR-804: an unversioned settlement ID alone does not prove confirmation", async () => {
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST", body: "{}", headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, paymentAttemptId: "attempt_1" }))
      .mockRejectedValueOnce(new TypeError("verification unavailable"));
    const handler = vi.fn(async () => new Response("must not run"));
    const result = await clientFor(fetchFn as never).products.gate("prod_1")
      .protect(request, await expectedGate(request), handler);
    const body = await result.json();
    expect(body).toMatchObject({
      error: { code: "settlement_outcome_unknown", retryable: true },
      paymentAttemptId: "attempt_1",
    });
    expect(body.error.message).not.toContain("Payment was confirmed");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { status: 503, bodyAttemptId: "attempt_other", headerAttemptId: "attempt_other" },
    { status: 500, bodyAttemptId: "attempt_other", headerAttemptId: "attempt_other" },
    { status: 200, bodyAttemptId: "attempt_other", headerAttemptId: "attempt_signed" },
  ])("MR-202/MR-804: drops a conflicting attempt's receipt on HTTP $status recovery", async ({ status, bodyAttemptId, headerAttemptId }) => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_signed`,
        ),
      },
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(Response.json({
      error: {
        code: "fulfillment_evidence_unavailable",
        message: "Payment confirmed; evidence unavailable.",
        retryable: true,
      },
      paymentAttemptId: bodyAttemptId,
      requestId: "req_other",
      apiVersion: GENESISPAY_API_VERSION,
    }, { status, headers: {
      "PAYMENT-RESPONSE": "receipt-for-another-attempt",
      [GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER]: headerAttemptId,
      [GENESISPAY_REQUEST_ID_HEADER]: "req_other",
      [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
      "cache-control": "no-store",
      "retry-after": "2",
    } }));
    const handler = vi.fn(async () => new Response("must not run"));

    const result = await clientFor(fetchFn as never).products.gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(result.status).toBe(503);
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe("attempt_signed");
    expect(result.headers.get("PAYMENT-RESPONSE")).toBeNull();
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "settlement_outcome_unknown", retryable: true },
      paymentAttemptId: "attempt_signed",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-804: reports transport loss as an unknown outcome, not a confirmed payment", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_reserved`,
        ),
      },
    });
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("connection reset after commit"));
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(503);
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_reserved",
    );
    expect(result.headers.get("retry-after")).toBe("2");
    // The request never produced a response, so whether the settlement ran is
    // unknown. The locator is preserved for reconciliation, but nothing here
    // may claim the payment confirmed.
    const body = await result.json();
    expect(body).toMatchObject({
      error: { code: "settlement_outcome_unknown", retryable: true },
      paymentAttemptId: "attempt_reserved",
      requestId: null,
    });
    expect(body.error.message).not.toContain("Payment was confirmed");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["transport loss", null],
    ["seller API throttling", 429],
    ["seller API authentication refusal", 401],
  ] as const)(
    "MR-202/MR-1106: preserves a payer-broadcast hash across %s",
    async (_label, status) => {
      const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
      const transactionHash = `0x${"f".repeat(64)}` as const;
      const request = new Request(resourceUrl, {
        method: "POST",
        body: "{}",
        headers: {
          "PAYMENT-SIGNATURE": paymentSignatureWithResource(
            `${resourceUrl}?gp_attempt=attempt_broadcast`,
            transactionHash,
          ),
        },
      });
      const fetchFn = status === null
        ? vi.fn().mockRejectedValueOnce(new Error("connection reset"))
        : vi.fn().mockResolvedValueOnce(
            Response.json(
              { error: { code: "request_refused", message: "refused" } },
              { status },
            ),
          );
      const handler = vi.fn(async () => new Response("must not run"));

      const result = await clientFor(fetchFn as never).products
        .gate("prod_1")
        .protect(request, await expectedGate(request), handler);

      expect(result.status).toBe(503);
      expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
        "attempt_broadcast",
      );
      const paymentResponse = result.headers.get("PAYMENT-RESPONSE");
      expect(paymentResponse).not.toBeNull();
      expect(
        decodeSettlementResponseHeader(paymentResponse as string),
      ).toMatchObject({
        success: false,
        transaction: transactionHash,
        extensions: {
          authorizationVerified: false,
          settlementVerified: false,
          persistenceVerified: false,
        },
      });
      await expect(result.json()).resolves.toMatchObject({
        error: { code: "settlement_outcome_unknown", retryable: true },
        paymentAttemptId: "attempt_broadcast",
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["transport loss", null],
    ["seller API refusal", 401],
  ] as const)(
    "MR-202/MR-1106: preserves a payer-broadcast hash without an attempt locator across %s",
    async (_label, status) => {
      const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
      const transactionHash = `0x${"b".repeat(64)}` as const;
      const request = new Request(resourceUrl, {
        method: "POST",
        body: "{}",
        headers: {
          "PAYMENT-SIGNATURE": paymentSignatureWithResource(
            resourceUrl,
            transactionHash,
          ),
        },
      });
      const fetchFn = status === null
        ? vi.fn().mockRejectedValueOnce(new Error("connection reset"))
        : vi.fn().mockResolvedValueOnce(new Response(null, { status }));

      const result = await clientFor(fetchFn as never).products
        .gate("prod_1")
        .protect(
          request,
          await expectedGate(request),
          vi.fn(async () => new Response("must not run")),
        );

      expect(result.status).toBe(503);
      expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBeNull();
      expect(
        decodeSettlementResponseHeader(
          result.headers.get("PAYMENT-RESPONSE") as string,
        ),
      ).toMatchObject({ success: false, transaction: transactionHash });
    },
  );

  it("wraps an unstructured signed-settlement 5xx with the strict recovery locator", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_committed`,
        ),
      },
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          [GENESISPAY_REQUEST_ID_HEADER]: "req_failed_projection",
          "PAYMENT-RESPONSE": "settled-receipt",
        },
      }),
    );
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(result.status).toBe(503);
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_committed",
    );
    expect(result.headers.get(GENESISPAY_REQUEST_ID_HEADER)).toBe(
      "req_failed_projection",
    );
    expect(result.headers.get(GENESISPAY_VERSION_HEADER)).toBe(
      GENESISPAY_API_VERSION,
    );
    expect(result.headers.get("retry-after")).toBe("2");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settled-receipt");
    // A 5xx carrying no strict evidence says nothing about whether the payer's
    // signature was ever verified, let alone settled.
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "settlement_outcome_unknown", retryable: true },
      paymentAttemptId: "attempt_committed",
      requestId: "req_failed_projection",
      apiVersion: GENESISPAY_API_VERSION,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-804: passes the backend's own unknown-outcome recovery through unchanged", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_unknown`,
        ),
      },
    });
    const unknownBody = {
      error: {
        code: "settlement_outcome_unknown",
        message:
          "The settlement outcome for this payment attempt is unknown. Retry, or reconcile the attempt with the fulfillment verification API, before fulfilling.",
        retryable: true,
      },
      paymentAttemptId: "attempt_unknown",
      requestId: "req_unknown",
      apiVersion: GENESISPAY_API_VERSION,
    };
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(unknownBody), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "retry-after": "2",
          [GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER]: "attempt_unknown",
          [GENESISPAY_REQUEST_ID_HEADER]: "req_unknown",
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
        },
      }),
    );
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(result.status).toBe(503);
    await expect(result.json()).resolves.toEqual(unknownBody);
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves a structured permanent signed-settlement inconsistency without retrying", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_inconsistent`,
        ),
      },
    });
    const permanentBody = {
      error: {
        code: "fulfillment_evidence_inconsistent",
        message:
          "Payment was confirmed but its evidence requires operator intervention.",
        retryable: false,
      },
      paymentAttemptId: "attempt_inconsistent",
      requestId: "req_inconsistent",
      apiVersion: GENESISPAY_API_VERSION,
    };
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(permanentBody), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          [GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER]: "attempt_inconsistent",
          [GENESISPAY_REQUEST_ID_HEADER]: "req_inconsistent",
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
          "PAYMENT-RESPONSE": "settled-receipt",
        },
      }),
    );
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBeNull();
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_inconsistent",
    );
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settled-receipt");
    await expect(result.json()).resolves.toEqual(permanentBody);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never downgrades a recognized permanent inconsistency when strict metadata is incomplete", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_inconsistent`,
        ),
      },
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: "fulfillment_evidence_inconsistent",
            message:
              "Payment was confirmed but its evidence requires operator intervention.",
            retryable: false,
          },
          paymentAttemptId: "attempt_inconsistent",
        },
        { status: 503 },
      ),
    );
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBeNull();
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_inconsistent",
    );
    await expect(result.json()).resolves.toMatchObject({
      error: {
        code: "fulfillment_evidence_inconsistent",
        retryable: false,
      },
      paymentAttemptId: "attempt_inconsistent",
      apiVersion: GENESISPAY_API_VERSION,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("recovers the confirmed attempt ID from the settlement response header", async () => {
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
      headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transaction: `0x${"a".repeat(64)}` }), {
          status: 200,
          headers: {
            [GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER]: "attempt_from_header",
            "PAYMENT-RESPONSE": "settled-receipt",
          },
        }),
      )
      .mockRejectedValueOnce(new Error("verification unavailable"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), async () => new Response("must not run"));

    expect(result.status).toBe(503);
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_from_header",
    );
    await expect(result.json()).resolves.toMatchObject({
      paymentAttemptId: "attempt_from_header",
      error: { retryable: true },
    });
  });

  it("reports an unknown outcome when settlement body and header contradict the attempt identity", async () => {
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
      headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ paymentAttemptId: "attempt_body" }), {
        status: 200,
        headers: {
          [GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER]: "attempt_header",
          [GENESISPAY_REQUEST_ID_HEADER]: "req_settle",
          "PAYMENT-RESPONSE": "settled-receipt",
        },
      }),
    );
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(503);
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBeNull();
    expect(result.headers.get("retry-after")).toBe("2");
    expect(result.headers.get("PAYMENT-RESPONSE")).toBeNull();
    // Two contradictory attempt identities establish no single confirmation.
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "settlement_outcome_unknown", retryable: true },
      paymentAttemptId: null,
      requestId: "req_settle",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-804: reports an unstructured 2xx as an unknown outcome, not a confirmed payment", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_unstructured_2xx`,
        ),
      },
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response("settled", {
        status: 200,
        headers: { "PAYMENT-RESPONSE": "settled-receipt" },
      }),
    );
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(503);
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_unstructured_2xx",
    );
    expect(result.headers.get("retry-after")).toBe("2");
    expect(result.headers.get("PAYMENT-RESPONSE")).toBe("settled-receipt");
    // A 2xx that names no attempt (a proxy answering 200 with its own page)
    // says nothing about whether the settlement ran — same skepticism an
    // unstructured 5xx gets. The signed attempt id survives as the locator so
    // the caller has something concrete to reconcile against.
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "settlement_outcome_unknown", retryable: true },
      paymentAttemptId: "attempt_unstructured_2xx",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-804: another attempt response leaves the signed payment outcome unknown", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_signed`,
        ),
      },
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ paymentAttemptId: "attempt_response" }), {
        status: 200,
        headers: {
          [GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER]: "attempt_response",
          "PAYMENT-RESPONSE": "settled-receipt",
        },
      }),
    );
    const handler = vi.fn(async () => new Response("must not run"));
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, await expectedGate(request), handler);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBe("2");
    expect(result.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(result.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_signed",
    );
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "settlement_outcome_unknown", retryable: true },
      paymentAttemptId: "attempt_signed",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("alerts through a permanent retryable:false response on inconsistent strict evidence", async () => {
    const url = "https://predictionengine.xyz/api/v1/forecast";
    const request = new Request(url, {
      method: "POST",
      body: "{}",
      headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const expected = await expectedGate(request);
    const strictEvidence = gateEvidence(url, expected.delivery.gate!.fingerprint);
    (strictEvidence.simulation as Record<string, unknown>).simulated = true;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ paymentAttemptId: "attempt_1" }), {
          status: 200,
          headers: { "PAYMENT-RESPONSE": "settled-receipt" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "fulfillment_verification",
            verified: true,
            requestId: "req_verify",
            apiVersion: GENESISPAY_API_VERSION,
            evidence: strictEvidence,
          }),
          {
            status: 200,
            headers: {
              [GENESISPAY_REQUEST_ID_HEADER]: "req_verify",
              [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
            },
          },
        ),
      );
    const client = clientFor(fetchFn as never);
    const handler = vi.fn(async () => new Response("must not run"));

    const result = await client.products
      .gate("prod_1")
      .protect(request, expected, handler);

    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBeNull();
    await expect(result.json()).resolves.toMatchObject({
      error: {
        code: "fulfillment_evidence_inconsistent",
        retryable: false,
        message: "Fulfillment evidence requires operator intervention. Reconcile the payment attempt before fulfilling.",
      },
      paymentAttemptId: "attempt_1",
      requestId: "req_verify",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a gate fingerprint mismatch before settlement", async () => {
    const fetchFn = jsonFetch({});
    const client = clientFor(fetchFn);
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
      headers: { "PAYMENT-SIGNATURE": "signed-payload" },
    });
    const expected = await expectedGate(request);
    expected.delivery.gate!.fingerprint = `sha256:${"0".repeat(64)}`;

    await expect(
      client.products.gate("prod_1").protect(request, expected, async () => new Response()),
    ).rejects.toMatchObject({
      code: "contract_mismatch",
      mismatches: ["product.delivery.gate.fingerprint"],
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("MR-202/MR-1106: preserves a payer-broadcast hash across a local gate contract mismatch", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const transactionHash = `0x${"e".repeat(64)}` as const;
    const request = new Request(resourceUrl, {
      method: "POST",
      body: "{}",
      headers: {
        "PAYMENT-SIGNATURE": paymentSignatureWithResource(
          `${resourceUrl}?gp_attempt=attempt_local_mismatch`,
          transactionHash,
        ),
      },
    });
    const expected = await expectedGate(request);
    expected.delivery.gate!.fingerprint = `sha256:${"0".repeat(64)}`;
    const fetchFn = jsonFetch({});
    const handler = vi.fn(async () => new Response("must not run"));

    const response = await clientFor(fetchFn).products
      .gate("prod_1")
      .protect(request, expected, handler);

    expect(response.status).toBe(503);
    expect(response.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBe(
      "attempt_local_mismatch",
    );
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toMatchObject({ success: false, transaction: transactionHash });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-202/MR-1106: preserves a payer-broadcast hash across conflicting local attempt locators", async () => {
    const resourceUrl = "https://predictionengine.xyz/api/v1/forecast";
    const transactionHash = `0x${"c".repeat(64)}` as const;
    const request = new Request(
      `${resourceUrl}?gp_attempt=attempt_request_locator`,
      {
        method: "POST",
        body: "{}",
        headers: {
          "PAYMENT-SIGNATURE": paymentSignatureWithResource(
            `${resourceUrl}?gp_attempt=attempt_signed_locator`,
            transactionHash,
          ),
        },
      },
    );
    const expected = await expectedGate(
      new Request(resourceUrl, { method: "POST", body: "{}" }),
    );
    const fetchFn = jsonFetch({});
    const handler = vi.fn(async () => new Response("must not run"));

    const response = await clientFor(fetchFn).products
      .gate("prod_1")
      .protect(request, expected, handler);

    expect(response.status).toBe(503);
    expect(response.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER)).toBeNull();
    expect(
      decodeSettlementResponseHeader(
        response.headers.get("PAYMENT-RESPONSE") as string,
      ),
    ).toMatchObject({ success: false, transaction: transactionHash });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-202: never exposes a 402 from a backend that ignored the version header", async () => {
    // The old-backend / rollback fixture. A pre-strict backend ignores
    // `GENESISPAY-Version`, strips the unknown `expected` member in its tolerant
    // schema, creates a LEGACY attempt and answers a valid 402. The payer would
    // settle it — and SDK 1.0 could never establish strict evidence for an
    // attempt with no authority provenance against a backend with no verify
    // endpoint. Refuse before any money is requested.
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
    });
    const expected = await expectedGate(request);
    const legacy402 = new Response(
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "2000000" }],
        error: "Payment Required",
      }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": "legacy-challenge",
        },
      },
    );
    const fetchFn = vi.fn().mockResolvedValueOnce(legacy402);
    const client = clientFor(fetchFn as never);
    const handler = vi.fn(async () => new Response("must not run"));

    const result = await client.products
      .gate("prod_1")
      .protect(request, expected, handler);

    expect(result.status).toBe(503);
    expect(result.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get(GENESISPAY_VERSION_HEADER)).toBe(
      GENESISPAY_API_VERSION,
    );
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "strict_version_unsupported", retryable: false },
      paymentAttemptId: null,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes a transient challenge 5xx through instead of calling it a version problem", async () => {
    // The negotiation refusal is for responses a payer could act on. An opaque
    // outage offers nothing to settle against, and relabelling it
    // `strict_version_unsupported` (permanent) would send the seller to the
    // wrong runbook for a retryable incident.
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
    });
    const expected = await expectedGate(request);
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response("upstream connect error", { status: 502 }),
    );
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, expected, async () => new Response("must not run"));

    expect(result.status).toBe(502);
    expect(await result.text()).toBe("upstream connect error");
  });

  it("MR-202: refuses a challenge whose version answer was stripped in transit", async () => {
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
    });
    const expected = await expectedGate(request);
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "payment_required",
          requestId: "req_body",
          apiVersion: GENESISPAY_API_VERSION,
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            [GENESISPAY_REQUEST_ID_HEADER]: "req_header",
            [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
          },
        },
      ),
    );
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, expected, async () => new Response("must not run"));

    expect(result.status).toBe(503);
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "strict_version_unsupported" },
    });
  });

  it("serializes the strict expected contract and bare fingerprint before issuing a challenge", async () => {
    const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
      method: "POST",
      body: "{}",
    });
    const expected = await expectedGate(request);
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "payment_required",
          requestId: "req_challenge",
          apiVersion: GENESISPAY_API_VERSION,
        }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            [GENESISPAY_REQUEST_ID_HEADER]: "req_challenge",
            [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
          },
        },
      ),
    );
    const client = clientFor(fetchFn as never);

    const result = await client.products
      .gate("prod_1")
      .protect(request, expected, async () => new Response("must not run"));

    expect(result.status).toBe(402);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [gateUrl, gateInit] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(gateUrl).toBe("http://localhost:3000/api/v1/products/prod_1/x402");
    expect(new Headers(gateInit.headers).get(GENESISPAY_VERSION_HEADER)).toBe(
      GENESISPAY_API_VERSION,
    );
    expect(JSON.parse(gateInit.body as string)).toEqual({
      action: "challenge",
      resourceUrl: request.url,
      method: "POST",
      requestFingerprint: expected.delivery.gate?.fingerprint.slice("sha256:".length),
      expected: {
        ...expected,
        grossAmountMinor: "2000000",
      },
    });
  });

  it("proxies product-gate preparation against the frozen challenge intent", async () => {
    const original = new Request(
      "https://predictionengine.xyz/api/v1/forecast",
      { method: "POST", body: "{}" },
    );
    const expected = await expectedGate(original);
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const authority = {
      sellerNonce: `0x${"11".repeat(32)}`,
      feeNonce: null,
      validBefore: "9999999999",
    };
    const preparedBody = {
      settlementPlan: { planId: "22222222-2222-4222-8222-222222222222" },
      requestId: "req_prepare",
      apiVersion: GENESISPAY_API_VERSION,
    };
    const fetchFn = vi.fn().mockResolvedValueOnce(
      Response.json(preparedBody, {
        status: 201,
        headers: {
          [GENESISPAY_REQUEST_ID_HEADER]: "req_prepare",
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
        },
      }),
    );
    const client = clientFor(fetchFn as never);
    const prepareRequest = new Request(
      `${original.url}?gp_attempt=${attemptId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "GENESISPAY-Settlement-Prepare": "1",
        },
        body: JSON.stringify({
          payer: other,
          idempotencyKey: "forecast-42",
          feeMode: "record_only",
          authority,
        }),
      },
    );

    const response = await client.products
      .gate("prod_1")
      .protect(prepareRequest, expected, async () => new Response("must not run"));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(preparedBody);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      action: "prepare",
      resourceUrl: original.url,
      method: "POST",
      requestFingerprint: expected.delivery.gate?.fingerprint.slice(
        "sha256:".length,
      ),
      attemptId,
      payer: other,
      idempotencyKey: "forecast-42",
      feeMode: "record_only",
      authority,
      expected: { ...expected, grossAmountMinor: "2000000" },
    });
  });

  describe("purchase-bound preparation (params header, ADR-0083)", () => {
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const purchaseBody = JSON.stringify({ horizon: "7d", symbol: "ETH" });
    const authority = {
      sellerNonce: `0x${"11".repeat(32)}` as const,
      feeNonce: `0x${"22".repeat(32)}` as const,
      validBefore: "9999999999",
    };
    const paramsHeader = encodeSettlementPrepareParamsHeader({
      payer: other,
      idempotencyKey: "forecast-42",
      feeMode: "collect",
      authority,
    });
    const purchase = () =>
      new Request("https://predictionengine.xyz/api/v1/forecast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: purchaseBody,
      });
    const prepareRequest = (init: { body?: string; params?: string } = {}) =>
      new Request(
        `https://predictionengine.xyz/api/v1/forecast?gp_attempt=${attemptId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "GENESISPAY-Settlement-Prepare": "1",
            [GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER]: init.params ?? paramsHeader,
          },
          body: init.body ?? purchaseBody,
        },
      );

    it("MR-1011: forwards the header params when the prepare repeats the purchase", async () => {
      const expected = await expectedGate(purchase());
      const preparedBody = {
        settlementPlan: { planId: "22222222-2222-4222-8222-222222222222" },
        requestId: "req_prepare",
        apiVersion: GENESISPAY_API_VERSION,
      };
      const fetchFn = vi.fn().mockResolvedValueOnce(
        Response.json(preparedBody, {
          status: 201,
          headers: {
            [GENESISPAY_REQUEST_ID_HEADER]: "req_prepare",
            [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
          },
        }),
      );
      const client = clientFor(fetchFn as never);
      const request = prepareRequest();
      // A body-validating route can read the purchase body before `protect`.
      await expect(request.clone().json()).resolves.toEqual(JSON.parse(purchaseBody));

      const response = await client.products
        .gate("prod_1")
        .protect(request, expected, async () => new Response("must not run"));

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual(preparedBody);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({
        action: "prepare",
        resourceUrl: "https://predictionengine.xyz/api/v1/forecast",
        method: "POST",
        requestFingerprint: expected.delivery.gate?.fingerprint.slice("sha256:".length),
        attemptId,
        payer: other,
        idempotencyKey: "forecast-42",
        feeMode: "collect",
        authority,
        expected: { ...expected, grossAmountMinor: "2000000" },
      });
    });

    it("MR-1011: refuses a prepare whose body is not the expected purchase, without forwarding", async () => {
      const expected = await expectedGate(purchase());
      const fetchFn = vi.fn();
      const client = clientFor(fetchFn as never);
      const handler = vi.fn(async () => new Response("must not run"));

      const response = await client.products
        .gate("prod_1")
        .protect(
          prepareRequest({ body: JSON.stringify({ horizon: "90d", symbol: "ETH" }) }),
          expected,
          handler,
        );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining("product.delivery.gate.fingerprint"),
        code: "contract_mismatch",
        mismatches: ["product.delivery.gate.fingerprint"],
      });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("refuses a prepare whose method differs from the expected gate, without forwarding", async () => {
      const purchaseExpected = await expectedGate(purchase());
      // Same URL and fingerprint as the request; only the expected method differs.
      const expected: ExpectedProductContract = {
        ...purchaseExpected,
        delivery: {
          ...purchaseExpected.delivery,
          gate: { ...purchaseExpected.delivery.gate!, method: "PUT" },
        },
      };
      const fetchFn = vi.fn();
      const client = clientFor(fetchFn as never);

      const response = await client.products
        .gate("prod_1")
        .protect(prepareRequest(), expected, async () => new Response("must not run"));

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining("product.delivery.gate.method"),
        code: "contract_mismatch",
        mismatches: ["product.delivery.gate.method"],
      });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("refuses a prepare for a different resource URL, without forwarding", async () => {
      const expected = await expectedGate(purchase());
      const fetchFn = vi.fn();
      const client = clientFor(fetchFn as never);
      const request = new Request(
        `https://predictionengine.xyz/api/v1/other?gp_attempt=${attemptId}`,
        {
          method: "POST",
          headers: {
            "GENESISPAY-Settlement-Prepare": "1",
            [GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER]: paramsHeader,
          },
          body: purchaseBody,
        },
      );

      const response = await client.products
        .gate("prod_1")
        .protect(request, expected, async () => new Response("must not run"));

      expect(response.status).toBe(422);
      const body = (await response.json()) as { code: string; mismatches: string[] };
      expect(body.code).toBe("contract_mismatch");
      expect(body.mismatches).toEqual([
        "product.delivery.gate.resourceUrl",
        "product.delivery.gate.fingerprint",
      ]);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each([
      ["empty", ""],
      ["not base64", "not base64!"],
      ["invalid params", btoa(JSON.stringify({ payer: "0x12", idempotencyKey: null, feeMode: "collect" }))],
      ["oversized", "A".repeat(4100)],
    ])("refuses a present but %s params header, never reading the body as params", async (_label, value) => {
      const expected = await expectedGate(purchase());
      const fetchFn = vi.fn();
      const client = clientFor(fetchFn as never);

      // The body carries valid legacy params; a malformed header must not fall back to it.
      const response = await client.products.gate("prod_1").protect(
        prepareRequest({
          params: value,
          body: JSON.stringify({ payer: other, idempotencyKey: null, feeMode: "collect" }),
        }),
        expected,
        async () => new Response("must not run"),
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid settlement preparation request.",
        code: "invalid_request",
      });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("refuses header preparation without a gp_attempt locator", async () => {
      const expected = await expectedGate(purchase());
      const fetchFn = vi.fn();
      const client = clientFor(fetchFn as never);
      const request = new Request("https://predictionengine.xyz/api/v1/forecast", {
        method: "POST",
        headers: {
          "GENESISPAY-Settlement-Prepare": "1",
          [GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER]: paramsHeader,
        },
        body: purchaseBody,
      });

      const response = await client.products
        .gate("prod_1")
        .protect(request, expected, async () => new Response("must not run"));

      expect(response.status).toBe(422);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});

async function expectedGate(request: Request): Promise<ExpectedProductContract> {
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const bodyHash = await sha256Hex(body);
  const fingerprint = await sha256Hex(
    new TextEncoder().encode(
      `${request.method.toUpperCase()}\n${request.url}\n${bodyHash}`,
    ),
  );
  return {
    kind: "product",
    productId: "prod_1",
    sku: "MDR-1",
    grossAmountMinor: 2_000_000n,
    network: {
      mode: "test",
      network: "base",
      chainId: 84532,
      asset: "USDC",
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      minorUnitScale: 6,
    },
    settlementDestination: receiving,
    delivery: {
      type: "gate",
      url: null,
      gate: {
        method: "POST",
        resourceUrl: request.url,
        fingerprint: `sha256:${fingerprint}`,
      },
    },
  };
}

function gateEvidence(resourceUrl: string, fingerprint: string): Record<string, unknown> {
  return {
    schema: "genesispay.fulfillment-evidence",
    version: GENESISPAY_API_VERSION,
    authorityVersion: GENESISPAY_API_VERSION,
    sellerId: "seller_1",
    linkId: "inv_1",
    attemptId: "attempt_1",
    entitlementId: null,
    entitlement: null,
    paymentChannel: "x402",
    simulation: { simulated: false },
    status: "confirmed",
    confirmedAt: "2026-08-26T12:34:56.000Z",
    transactionHash: `0x${"a".repeat(64)}`,
    settlement: {
      strategy: "dual",
      grossAmountMinor: "2000000",
      sellerAmountMinor: "1980000",
      destination: receiving,
      feeTerms: {
        type: "payer_authorized",
        amountMinor: "20000",
        treasuryAddress: "0x3333333333333333333333333333333333333333",
      },
      feeCollection: {
        status: "recorded",
        amountMinor: "20000",
        treasuryAddress: "0x3333333333333333333333333333333333333333",
        transactionHash: null,
        collectedAt: null,
      },
    },
    network: {
      mode: "test",
      network: "base",
      chainId: 84532,
      asset: "USDC",
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      minorUnitScale: 6,
    },
    product: {
      contractVersion: GENESISPAY_API_VERSION,
      productId: "prod_1",
      sku: "MDR-1",
      delivery: {
        type: "gate",
        url: null,
        gate: {
          method: "POST",
          resourceUrl,
          fingerprint,
        },
      },
    },
  };
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function paymentSignatureWithResource(
  resourceUrl: string,
  transactionHash?: `0x${string}`,
): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: resourceUrl },
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      amount: "2000000",
      asset: "USDC",
      assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: receiving as `0x${string}`,
    },
    payload: {
      signature: "0x1234",
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: receiving as `0x${string}`,
        value: "2000000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"a".repeat(64)}`,
      },
    },
    ...(transactionHash ? { extensions: { txHash: transactionHash } } : {}),
  });
}

function strictSettlementResponse(attemptId: string): Response {
  return Response.json({
    success: true,
    transaction: `0x${"a".repeat(64)}`,
    paymentAttemptId: attemptId,
    requestId: "req_settle",
    apiVersion: GENESISPAY_API_VERSION,
  }, { headers: {
    "PAYMENT-RESPONSE": "settled-receipt",
    [GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER]: attemptId,
    [GENESISPAY_REQUEST_ID_HEADER]: "req_settle",
    [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
  } });
}
