import { describe, expect, it, vi } from "vitest";

import { GenesisPay } from "./client.js";
import {
  GenesisPayAmbiguousLocatorError,
  GenesisPayConfigError,
  GenesisPayContractMismatchError,
  GenesisPayEvidenceError,
  GenesisPayNetworkSafetyError,
  GenesisPayValidationError,
  GenesisPayVersionError,
} from "./errors.js";
import {
  GENESISPAY_API_VERSION,
  GENESISPAY_REQUEST_ID_HEADER,
  GENESISPAY_VERSION_HEADER,
  type ExpectedProductContract,
  type FulfillmentLocator,
} from "./fulfillment.js";

const API_KEY = `gp_sk_test_${"a".repeat(32)}`;
const REQUEST_ID = "req_authority_1";
const DESTINATION = "0x1111111111111111111111111111111111111111" as const;
const TREASURY = "0x3333333333333333333333333333333333333333" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const TX_HASH = `0x${"a".repeat(64)}` as const;

function expectedProduct(
  overrides: Partial<ExpectedProductContract> = {},
): ExpectedProductContract {
  return {
    kind: "product",
    productId: "prod_starter",
    sku: "starter-credits",
    grossAmountMinor: 1_000_000n,
    network: {
      mode: "test",
      network: "base",
      chainId: 84532,
      asset: "USDC",
      tokenAddress: USDC,
      minorUnitScale: 6,
    },
    settlementDestination: DESTINATION,
    delivery: {
      type: "url",
      url: "https://seller.example/delivery?order=1",
      gate: null,
    },
    ...overrides,
  };
}

function evidence(): Record<string, unknown> {
  return {
    schema: "genesispay.fulfillment-evidence",
    version: GENESISPAY_API_VERSION,
    authorityVersion: GENESISPAY_API_VERSION,
    sellerId: "seller_1",
    linkId: "inv_1",
    attemptId: "attempt_1",
    entitlementId: "ent_1",
    entitlement: {
      expiresAt: "2026-09-25T12:34:56.000Z",
      revokedAt: null,
      valid: true,
    },
    paymentChannel: "checkout",
    simulation: { simulated: false },
    status: "confirmed",
    confirmedAt: "2026-08-26T12:34:56.000Z",
    transactionHash: TX_HASH,
    settlement: {
      strategy: "dual",
      grossAmountMinor: "1000000",
      sellerAmountMinor: "990000",
      destination: DESTINATION,
      feeTerms: {
        type: "payer_authorized",
        amountMinor: "10000",
        treasuryAddress: TREASURY,
      },
      feeCollection: {
        status: "recorded",
        amountMinor: "10000",
        treasuryAddress: TREASURY,
        transactionHash: null,
        collectedAt: null,
      },
    },
    network: {
      mode: "test",
      network: "base",
      chainId: 84532,
      asset: "USDC",
      tokenAddress: USDC,
      minorUnitScale: 6,
    },
    product: {
      contractVersion: GENESISPAY_API_VERSION,
      productId: "prod_starter",
      sku: "starter-credits",
      delivery: {
        type: "url",
        url: "https://seller.example/delivery?order=1",
        gate: null,
      },
    },
  };
}

function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "fulfillment_verification",
    verified: true,
    requestId: REQUEST_ID,
    apiVersion: GENESISPAY_API_VERSION,
    evidence: evidence(),
    ...overrides,
  };
}

function response(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      [GENESISPAY_REQUEST_ID_HEADER]: REQUEST_ID,
      [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
      ...options.headers,
    },
  });
}

function clientFor(body: unknown = successBody()): {
  client: GenesisPay;
  fetchFn: ReturnType<typeof vi.fn>;
} {
  const fetchFn = vi.fn(async () => response(body));
  return {
    client: new GenesisPay({ apiKey: API_KEY, fetchFn: fetchFn as unknown as typeof fetch }),
    fetchFn,
  };
}

function setEvidence(path: string, value: unknown): Record<string, unknown> {
  const body = structuredClone(successBody());
  const parts = path.split(".");
  let cursor = body;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1) as string] = value;
  return body;
}

describe("fulfillment.verify", () => {
  it.each([
    { attemptId: "attempt_1" },
    { linkId: "inv_1" },
    { entitlementId: "ent_1" },
  ] satisfies FulfillmentLocator[])(
    "MR-102: an expected contract cannot override the pin for locator %j",
    async (locator) => {
      const fetchFn = vi.fn(async () => response(successBody()));
      const client = new GenesisPay({
        apiKey: API_KEY,
        expectedPayTo: "0x2222222222222222222222222222222222222222",
        fetchFn,
      });

      await expect(client.fulfillment.verify({ locator, expected: expectedProduct() }))
        .rejects.toBeInstanceOf(GenesisPayNetworkSafetyError);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { attemptId: "attempt_1" },
    { linkId: "inv_1" },
    { entitlementId: "ent_1" },
  ] satisfies FulfillmentLocator[])(
    "MR-202: a client pinned to the original destination can verify history by %j",
    async (locator) => {
      const client = new GenesisPay({
        apiKey: API_KEY,
        expectedPayTo: ` ${DESTINATION} `,
        fetchFn: async () => response(successBody()),
      });

      await expect(client.fulfillment.verify({ locator, expected: expectedProduct() }))
        .resolves.toMatchObject({ verified: true, payment: { settlementDestination: DESTINATION } });
    },
  );

  it("MR-102: a matching pin cannot excuse a conflicting wire destination", async () => {
    const client = new GenesisPay({
      apiKey: API_KEY,
      expectedPayTo: DESTINATION,
      fetchFn: async () => response(setEvidence(
        "evidence.settlement.destination", "0x2222222222222222222222222222222222222222",
      )),
    });

    await expect(client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }))
      .rejects.toMatchObject({ code: "contract_mismatch", mismatches: ["settlementDestination"] });
  });

  it("MR-103: caller mutations cannot change the registry or an in-flight verification", async () => {
    const { client, fetchFn } = clientFor();
    const first = await client.fulfillment.verify({
      locator: { attemptId: "attempt_1" },
      expected: expectedProduct(),
    });
    if (!first.verified) throw new Error("Expected verified fixture");

    let releaseResponse!: (value: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { releaseResponse = resolve; });
    fetchFn.mockImplementationOnce(() => pendingResponse);
    // The second request's expected network is validated and serialized before
    // the caller mutates a previously returned public object.
    const pending = client.fulfillment.verify({
      locator: { attemptId: "attempt_1" },
      expected: expectedProduct(),
    });
    const originalMode = first.payment.network.mode;
    try {
      first.payment.network.mode = "live";
      releaseResponse(response(successBody()));
      const second = await pending;
      expect(second.verified).toBe(true);
      if (!second.verified) return;
      expect(second.payment.network).toEqual(expectedProduct().network);
      expect(second.payment.network).not.toBe(first.payment.network);
    } finally {
      // Keep a regression run against the old shared registry from polluting
      // the remaining tests when the assertion fails.
      first.payment.network.mode = originalMode;
    }
  });

  it("MR-102/MR-103/MR-202/MR-804: retrieves strict evidence and returns bigint authority", async () => {
    const { client, fetchFn } = clientFor();

    const result = await client.fulfillment.verify({
      locator: { attemptId: "attempt_1" },
      expected: expectedProduct(),
    });

    expect(result).toEqual({
      verified: true,
      requestId: REQUEST_ID,
      apiVersion: GENESISPAY_API_VERSION,
      payment: {
        attemptId: "attempt_1",
        linkId: "inv_1",
        entitlementId: "ent_1",
        entitlement: {
          expiresAt: "2026-09-25T12:34:56.000Z",
          revokedAt: null,
          valid: true,
        },
        paymentChannel: "checkout",
        confirmedAt: "2026-08-26T12:34:56.000Z",
        transactionHash: TX_HASH,
        grossAmountMinor: 1_000_000n,
        sellerAmountMinor: 990_000n,
        feeTerms: {
          type: "payer_authorized",
          amountMinor: 10_000n,
          treasuryAddress: TREASURY,
        },
        feeCollection: {
          status: "recorded",
          amountMinor: 10_000n,
          treasuryAddress: TREASURY,
          transactionHash: null,
          collectedAt: null,
        },
        settlementDestination: DESTINATION,
        network: expectedProduct().network,
        product: {
          productId: "prod_starter",
          sku: "starter-credits",
          delivery: expectedProduct().delivery,
        },
      },
    });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.genesispay.finance/api/v1/fulfillment/verify");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get(GENESISPAY_VERSION_HEADER)).toBe(
      GENESISPAY_API_VERSION,
    );
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      locator: { attemptId: "attempt_1" },
      expected: {
        ...expectedProduct(),
        grossAmountMinor: "1000000",
      },
    });
  });

  it("accepts an atomic settlement snapshot without assuming transfer topology", async () => {
    const { client } = clientFor(
      setEvidence("evidence.settlement.strategy", "atomic"),
    );

    await expect(
      client.fulfillment.verify({
        locator: { attemptId: "attempt_1" },
        expected: expectedProduct(),
      }),
    ).resolves.toMatchObject({
      verified: true,
      payment: {
        grossAmountMinor: 1_000_000n,
        sellerAmountMinor: 990_000n,
        feeTerms: { type: "payer_authorized", amountMinor: 10_000n },
      },
    });
  });

  it.each(["not_found", "not_confirmed", "simulated", "entitlement_invalid"] as const)(
    "returns the ordinary negative outcome %s with response metadata",
    async (reason) => {
      const { client } = clientFor({
        object: "fulfillment_verification",
        verified: false,
        reason,
        requestId: REQUEST_ID,
        apiVersion: GENESISPAY_API_VERSION,
      });

      await expect(
        client.fulfillment.verify({
          locator: { attemptId: "attempt_1" },
          expected: expectedProduct(),
        }),
      ).resolves.toEqual({
        verified: false,
        reason,
        requestId: REQUEST_ID,
        apiVersion: GENESISPAY_API_VERSION,
      });
    },
  );

  it("rejects ambiguous locators before any network request", async () => {
    const { client, fetchFn } = clientFor();

    await expect(
      client.fulfillment.verify({
        locator: {
          attemptId: "attempt_1",
          linkId: "inv_1",
        } as unknown as FulfillmentLocator,
        expected: expectedProduct(),
      }),
    ).rejects.toMatchObject({
      name: "GenesisPayAmbiguousLocatorError",
      code: "ambiguous_locator",
      requestId: null,
      apiVersion: null,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a second locator field even when its value is empty", async () => {
    const { client, fetchFn } = clientFor();

    await expect(
      client.fulfillment.verify({
        locator: {
          attemptId: "attempt_1",
          linkId: "",
        } as unknown as FulfillmentLocator,
        expected: expectedProduct(),
      }),
    ).rejects.toMatchObject({
      name: "GenesisPayAmbiguousLocatorError",
      code: "ambiguous_locator",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("has no public method that accepts caller-created evidence as authority", () => {
    const { client } = clientFor();
    expect(Object.keys(client.fulfillment).sort()).toEqual(["listAttempts", "verify"]);

    if (false) {
      // @ts-expect-error Public authority accepts only a locator plus expected contract.
      void client.fulfillment.verify({ evidence: evidence(), expected: expectedProduct() });
    }
  });

  it.each([
    ["grossAmountMinor", expectedProduct({ grossAmountMinor: 999_999n })],
    ["settlementDestination", expectedProduct({ settlementDestination: "0x2222222222222222222222222222222222222222" })],
    ["network.mode", expectedProduct({ network: { ...expectedProduct().network, mode: "live", chainId: 8453, tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } })],
    ["network.asset", expectedProduct({ network: { ...expectedProduct().network, asset: "EURC", tokenAddress: "0x808456652fdb597867f38412077A9182bf77359F" } })],
    ["product.productId", expectedProduct({ productId: "prod_other" })],
    ["product.sku", expectedProduct({ sku: null })],
  ] as const)("MR-202: throws a contract mismatch for %s", async (field, expected) => {
    const { client } = clientFor();

    const rejection = client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected });
    await expect(rejection).rejects.toBeInstanceOf(GenesisPayContractMismatchError);
    const error = await rejection.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "contract_mismatch",
      requestId: REQUEST_ID,
      apiVersion: GENESISPAY_API_VERSION,
    });
    expect((error as GenesisPayContractMismatchError).mismatches).toContain(field);
  });

  it("accepts canonical URL normalization in expected input but compares the frozen URL exactly", async () => {
    const { client } = clientFor();
    const expected = expectedProduct({
      delivery: {
        type: "url",
        url: "https://SELLER.example:443/a/../delivery?order=1",
        gate: null,
      },
    });

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected }),
    ).resolves.toMatchObject({ verified: true });
  });

  it("verifies a gate against the frozen canonical method, resource and fingerprint", async () => {
    const fingerprint = `sha256:${"b".repeat(64)}`;
    const body = setEvidence("evidence.product.delivery", {
      type: "gate",
      url: null,
      gate: {
        method: "POST",
        resourceUrl: "https://api.seller.example/resource?version=1",
        fingerprint,
      },
    });
    const { client } = clientFor(body);

    await expect(
      client.fulfillment.verify({
        locator: { attemptId: "attempt_1" },
        expected: expectedProduct({
          delivery: {
            type: "gate",
            url: null,
            gate: {
              method: "POST",
              resourceUrl: "https://api.seller.example/resource?version=1",
              fingerprint,
            },
          },
        }),
      }),
    ).resolves.toMatchObject({ verified: true });
  });

  it("verifies non-product links without consulting mutable product presentation", async () => {
    const body = setEvidence("evidence.product", null);
    const { client } = clientFor(body);

    await expect(
      client.fulfillment.verify({
        locator: { linkId: "inv_1" },
        expected: {
          kind: "payment_link",
          linkId: "inv_1",
          grossAmountMinor: 1_000_000n,
          network: expectedProduct().network,
          settlementDestination: DESTINATION,
        },
      }),
    ).resolves.toMatchObject({ verified: true, payment: { product: null } });
  });

  it("MR-804: an upstream 502 is retryable, not a permanent evidence verdict", async () => {
    // A proxy's HTML error page is not a statement about the payment. Treating
    // it as `malformed_evidence` made the product gate tell a seller their
    // confirmed payment needed operator intervention when a retry would have
    // worked.
    const fetchFn = vi.fn(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    const client = new GenesisPay({
      apiKey: API_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const error = await client.fulfillment
      .verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GenesisPayConfigError);
    expect(error).not.toBeInstanceOf(GenesisPayEvidenceError);
  });

  it("MR-804: a verification response stream failure remains a transient transport error", async () => {
    const client = new GenesisPay({
      apiKey: API_KEY,
      fetchFn: async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError("terminated: socket closed"));
        },
      }), {
        status: 200,
        headers: {
          [GENESISPAY_REQUEST_ID_HEADER]: REQUEST_ID,
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
        },
      }),
    });
    const rejection = client.fulfillment.verify({
      locator: { attemptId: "attempt_1" },
      expected: expectedProduct(),
    });
    await expect(rejection).rejects.toBeInstanceOf(GenesisPayConfigError);
    await expect(rejection).rejects.toMatchObject({
      requestId: REQUEST_ID,
      apiVersion: GENESISPAY_API_VERSION,
    });
  });

  it("MR-202: a fully received malformed verification body stays a permanent evidence error", async () => {
    const client = new GenesisPay({
      apiKey: API_KEY,
      fetchFn: async () => new Response("invalid JSON", {
        status: 200,
        headers: {
          [GENESISPAY_REQUEST_ID_HEADER]: REQUEST_ID,
          [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
        },
      }),
    });
    await expect(client.fulfillment.verify({
      locator: { attemptId: "attempt_1" },
      expected: expectedProduct(),
    })).rejects.toBeInstanceOf(GenesisPayEvidenceError);
  });

  it("MR-202: refuses a product payment claimed under a plain payment-link contract", async () => {
    // Same rule as the backend's: a payment-link claim skips every product and
    // delivery comparison, so satisfying it with a product payment would report
    // a delivery check that never happened.
    const { client } = clientFor();

    await expect(
      client.fulfillment.verify({
        locator: { linkId: "inv_1" },
        expected: {
          kind: "payment_link",
          linkId: "inv_1",
          grossAmountMinor: 1_000_000n,
          network: expectedProduct().network,
          settlementDestination: DESTINATION,
        },
      }),
    ).rejects.toMatchObject({
      code: "contract_mismatch",
      mismatches: ["product"],
    });
  });

  it("rejects evidence that does not resolve to the requested locator", async () => {
    const { client } = clientFor(setEvidence("evidence.attemptId", "attempt_other"));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({
      code: "contract_mismatch",
      mismatches: ["locator.attemptId"],
    });
  });
});

describe("strict fulfillment wire validation", () => {
  it.each([
    ["leading zero", "evidence.settlement.grossAmountMinor", "01000000"],
    ["decimal", "evidence.settlement.grossAmountMinor", "1.00"],
    ["sign", "evidence.settlement.grossAmountMinor", "+1000000"],
    ["20 digits", "evidence.settlement.grossAmountMinor", "10000000000000000000"],
    ["database overflow", "evidence.settlement.grossAmountMinor", "9223372036854775808"],
    ["number", "evidence.settlement.grossAmountMinor", 1_000_000],
  ])("MR-101: rejects %s before unsafe bigint arithmetic", async (_label, path, value) => {
    const { client } = clientFor(setEvidence(path, value));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "malformed_evidence", requestId: REQUEST_ID });
  });

  it("MR-104: rejects inconsistent settlement arithmetic", async () => {
    const { client } = clientFor(setEvidence("evidence.settlement.sellerAmountMinor", "980000"));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("MR-202/MR-1004: refuses a fee-only settlement with no seller payment", async () => {
    const body = setEvidence("evidence.settlement.sellerAmountMinor", "0");
    const settlement = (body.evidence as Record<string, unknown>).settlement as Record<
      string,
      unknown
    >;
    (settlement.feeTerms as Record<string, unknown>).amountMinor = "1000000";
    (settlement.feeCollection as Record<string, unknown>).amountMinor = "1000000";
    const { client } = clientFor(body);

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence", requestId: REQUEST_ID });
  });

  it.each([10_000n, 1_000_000n])("MR-1007: a record-only fee of %s is never deducted from the seller", async (feeMinor) => {
    const body = setEvidence("evidence.settlement.sellerAmountMinor", "1000000");
    const settlement = (body.evidence as Record<string, unknown>).settlement as Record<
      string,
      unknown
    >;
    settlement.feeTerms = {
      type: "record_only",
      amountMinor: feeMinor.toString(),
      treasuryAddress: null,
    };
    (settlement.feeCollection as Record<string, unknown>).amountMinor = feeMinor.toString();
    const { client } = clientFor(body);
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).resolves.toMatchObject({
      verified: true,
      payment: {
        sellerAmountMinor: 1_000_000n,
        feeTerms: { type: "record_only", amountMinor: feeMinor, treasuryAddress: null },
      },
    });
  });

  it("MR-104: refuses a record-only quote greater than the whole payment", async () => {
    const body = setEvidence("evidence.settlement.sellerAmountMinor", "1000000");
    const settlement = (body.evidence as Record<string, unknown>).settlement as Record<string, unknown>;
    settlement.feeTerms = { type: "record_only", amountMinor: "1000001", treasuryAddress: null };
    (settlement.feeCollection as Record<string, unknown>).amountMinor = "1000001";
    const { client } = clientFor(body);

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("MR-1005: an authorized fee that never collected is reported as uncollected", async () => {
    const body = setEvidence(
      "evidence.settlement.feeCollection.status",
      "failed",
    );
    const { client } = clientFor(body);
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).resolves.toMatchObject({
      verified: true,
      payment: {
        // The seller still received net: what the payer AUTHORIZED decided the
        // split, and the fee leg failing afterwards does not give it back.
        sellerAmountMinor: 990_000n,
        feeTerms: { type: "payer_authorized", amountMinor: 10_000n },
        feeCollection: { status: "failed", transactionHash: null },
      },
    });
  });

  it("MR-1005: refuses a collected fee that names no transfer", async () => {
    const { client } = clientFor(
      setEvidence("evidence.settlement.feeCollection.status", "collected"),
    );
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("MR-1006: refuses an authorized fee leg with no treasury", async () => {
    const { client } = clientFor(
      setEvidence("evidence.settlement.feeTerms.treasuryAddress", null),
    );
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "malformed_evidence" });
  });

  it("MR-202: surfaces a revoked entitlement on an attemptId locator", async () => {
    // The payment is still confirmed — that is immutable — but delivery is not
    // authorized any more. Without this field a seller gating on `attemptId`
    // could not see an operator's fraud revocation at all.
    const body = setEvidence("evidence.entitlement.revokedAt", "2026-08-27T09:00:00.000Z");
    const entitlement = (body.evidence as Record<string, unknown>)
      .entitlement as Record<string, unknown>;
    entitlement.valid = false;
    const { client } = clientFor(body);

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).resolves.toMatchObject({
      verified: true,
      payment: {
        entitlementId: "ent_1",
        entitlement: { valid: false, revokedAt: "2026-08-27T09:00:00.000Z" },
      },
    });
  });

  it.each([
    ["revoked", "2026-08-27T09:00:00.000Z"],
    ["expired", null],
  ])("MR-202: refuses a successful entitlement lookup with %s delivery authority", async (_reason, revokedAt) => {
    const body = setEvidence("evidence.entitlement", {
      expiresAt: "2026-08-26T12:34:56.000Z",
      revokedAt,
      valid: false,
    });
    const { client } = clientFor(body);

    await expect(
      client.fulfillment.verify({ locator: { entitlementId: "ent_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence", requestId: REQUEST_ID });
  });

  it("MR-202: preserves revoked payment evidence on a linkId locator", async () => {
    const body = setEvidence("evidence.entitlement", {
      expiresAt: "2026-09-25T12:34:56.000Z",
      revokedAt: "2026-08-27T09:00:00.000Z",
      valid: false,
    });
    const { client } = clientFor(body);

    await expect(
      client.fulfillment.verify({ locator: { linkId: "inv_1" }, expected: expectedProduct() }),
    ).resolves.toMatchObject({
      verified: true,
      payment: { entitlementId: "ent_1", entitlement: { valid: false } },
    });
  });

  it("refuses evidence that calls a revoked entitlement valid", async () => {
    const { client } = clientFor(
      setEvidence("evidence.entitlement.revokedAt", "2026-08-27T09:00:00.000Z"),
    );

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("refuses an entitlement id with no state to read it by", async () => {
    const { client } = clientFor(setEvidence("evidence.entitlement", null));

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("MR-1006: refuses a recorded fee collection that names no treasury", async () => {
    const { client } = clientFor(
      setEvidence("evidence.settlement.feeCollection.treasuryAddress", null),
    );

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("MR-804: a verified success requires the literal simulated false", async () => {
    const { client } = clientFor(setEvidence("evidence.simulation.simulated", true));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("rejects a parseable but noncanonical confirmation timestamp", async () => {
    const { client } = clientFor(setEvidence("evidence.confirmedAt", "2026-08-26T12:34:56Z"));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "malformed_evidence" });
  });

  it("MR-804: historical attempts without authority provenance fail closed", async () => {
    const { client } = clientFor(setEvidence("evidence.authorityVersion", null));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({
      code: "historical_evidence_unavailable",
      requestId: REQUEST_ID,
      apiVersion: GENESISPAY_API_VERSION,
    });
  });

  it("never turns paymentChannel unknown into verified true", async () => {
    const { client } = clientFor(setEvidence("evidence.paymentChannel", "unknown"));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "unsupported_payment_channel" });
  });

  it.each([
    ["mode", "evidence.network.mode", "live"],
    ["chain", "evidence.network.chainId", 8453],
    ["network", "evidence.network.network", "base-sepolia"],
    ["token", "evidence.network.tokenAddress", "0x2222222222222222222222222222222222222222"],
    ["scale", "evidence.network.minorUnitScale", 18],
  ])("MR-102/MR-103: rejects a registry contradiction in %s", async (_label, path, value) => {
    const { client } = clientFor(setEvidence(path, value));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it("rejects a noncanonical frozen authority URL", async () => {
    const { client } = clientFor(
      setEvidence(
        "evidence.product.delivery.url",
        "https://SELLER.example:443/a/../delivery?order=1",
      ),
    );
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence" });
  });

  it.each([
    "http://seller.example/delivery",
    "https://user:pass@seller.example/delivery",
    "https://seller.example/delivery#fragment",
  ])("rejects unsafe authority URL %s", async (url) => {
    const { client } = clientFor(setEvidence("evidence.product.delivery.url", url));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "malformed_evidence" });
  });

  it("ignores unknown additive fields after all known fields validate", async () => {
    const body = setEvidence("evidence.futureSettlementProof", { digest: "future" });
    const { client } = clientFor(body);
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).resolves.toMatchObject({ verified: true });
  });

  it("rejects missing, null, and wrong-typed known required fields", async () => {
    for (const value of [undefined, null, 84532]) {
      const { client } = clientFor(setEvidence("evidence.transactionHash", value));
      await expect(
        client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
      ).rejects.toBeInstanceOf(GenesisPayEvidenceError);
    }
  });
});

describe("strict response metadata and typed errors", () => {
  it("rejects mismatched request IDs between header and body", async () => {
    const { client } = clientFor(successBody({ requestId: "req_other" }));
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "inconsistent_evidence", requestId: REQUEST_ID });
  });

  it("rejects a response that omits required request/version headers", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(successBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new GenesisPay({ apiKey: API_KEY, fetchFn: fetchFn as unknown as typeof fetch });
    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({ code: "malformed_evidence" });
  });

  it("throws a typed version error for an unsupported response version", async () => {
    const fetchFn = vi.fn(async () =>
      response(successBody({ apiVersion: "2027-01-01" }), {
        headers: { [GENESISPAY_VERSION_HEADER]: "2027-01-01" },
      }),
    );
    const client = new GenesisPay({ apiKey: API_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toBeInstanceOf(GenesisPayVersionError);
  });

  it("maps backend contract mismatch errors with request metadata", async () => {
    const fetchFn = vi.fn(async () =>
      response(
        {
          error: { code: "contract_mismatch", message: "amount mismatch" },
          mismatches: ["grossAmountMinor"],
          requestId: REQUEST_ID,
          apiVersion: GENESISPAY_API_VERSION,
        },
        { status: 409 },
      ),
    );
    const client = new GenesisPay({ apiKey: API_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({
      code: "contract_mismatch",
      mismatches: ["grossAmountMinor"],
      requestId: REQUEST_ID,
      apiVersion: GENESISPAY_API_VERSION,
    });
  });

  it("preserves the flat strict-backend error message", async () => {
    const fetchFn = vi.fn(async () =>
      response(
        {
          code: "contract_mismatch",
          error: "The confirmed payment does not match the expected contract.",
          mismatches: ["grossAmountMinor"],
          requestId: REQUEST_ID,
          apiVersion: GENESISPAY_API_VERSION,
        },
        { status: 422 },
      ),
    );
    const client = new GenesisPay({ apiKey: API_KEY, fetchFn: fetchFn as unknown as typeof fetch });

    await expect(
      client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
    ).rejects.toMatchObject({
      code: "contract_mismatch",
      message: "The confirmed payment does not match the expected contract.",
    });
  });

  it("maps backend ambiguous-locator and historical-evidence errors", async () => {
    for (const [code, ErrorClass] of [
      ["ambiguous_locator", GenesisPayAmbiguousLocatorError],
      ["historical_evidence_unavailable", GenesisPayEvidenceError],
    ] as const) {
      const fetchFn = vi.fn(async () =>
        response(
          {
            error: { code, message: code },
            requestId: REQUEST_ID,
            apiVersion: GENESISPAY_API_VERSION,
          },
          { status: 409 },
        ),
      );
      const client = new GenesisPay({ apiKey: API_KEY, fetchFn: fetchFn as unknown as typeof fetch });
      await expect(
        client.fulfillment.verify({ locator: { attemptId: "attempt_1" }, expected: expectedProduct() }),
      ).rejects.toBeInstanceOf(ErrorClass);
    }
  });

  it("keeps metadata properties present and null when transport fails before a response", async () => {
    const client = new GenesisPay({
      apiKey: API_KEY,
      fetchFn: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });

    const rejection = client.fulfillment.verify({
      locator: { attemptId: "attempt_1" },
      expected: expectedProduct(),
    });
    await expect(rejection).rejects.toBeInstanceOf(GenesisPayConfigError);
    await expect(rejection).rejects.toMatchObject({ requestId: null, apiVersion: null });
  });

  it("validates product maximums and expected asset tuples before sending", async () => {
    const { client, fetchFn } = clientFor();
    await expect(
      client.fulfillment.verify({
        locator: { attemptId: "attempt_1" },
        expected: expectedProduct({ grossAmountMinor: 1_000_000_000_001n }),
      }),
    ).rejects.toBeInstanceOf(GenesisPayValidationError);
    await expect(
      client.fulfillment.verify({
        locator: { attemptId: "attempt_1" },
        expected: expectedProduct({
          network: {
            ...expectedProduct().network,
            tokenAddress: "0x2222222222222222222222222222222222222222",
          },
        }),
      }),
    ).rejects.toBeInstanceOf(GenesisPayValidationError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
