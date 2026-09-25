// This file deliberately keeps the product resource, strict checkout contract,
// and ProductGate adapter together. They share one product wire model and one
// post-settlement authority transition; splitting the gate from the resource
// would either expose internal evidence-validation seams or duplicate the exact
// recovery rules that prevent a paid handler from running without verification.
//
// `genesispay.products.*` — the merchant's catalogue over `/api/v1/products`.
//
// A product is what a shop sells. Legacy catalogue flows expose one canonical
// reusable link; strict 1.0 checkout creation freezes a distinct single-use
// link. Price, asset, destination, and delivery are copied onto either payable
// resource and never re-read from mutable catalogue presentation for authority.
// Everything is scoped to the key's own account: someone else's product answers
// 404 (GenesisPayNotFoundError), never 403 — the API is no catalogue-enumeration
// oracle, and the SDK does not paper over that.

import { parseItemTax, type ItemTax, type ItemTaxUpdate } from "./item-tax.js";
import {
  GenesisPayAmbiguousLocatorError,
  GenesisPayConfigError,
  GenesisPayContractMismatchError,
  GenesisPayEvidenceError,
  GenesisPayNotFoundError,
  GenesisPayRateLimitError,
  GenesisPayValidationError,
  GenesisPayVersionError,
} from "./errors.js";
import {
  asRecord,
  optionalString,
  requiredString,
  toAmountString,
  oneOf,
  type GenesisPayRequest,
} from "./resource.js";
import type { CheckoutLink } from "./client.js";
import {
  GENESISPAY_SETTLEMENT_PREPARE_HEADER,
  GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodePaymentSignatureHeader,
  decodeSettlementPrepareParamsHeader,
  encodeSettlementResponseHeader,
  type SettlementResponsePayload,
} from "@genesis-tech/genesispay-protocol";
import {
  GENESISPAY_API_VERSION,
  GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER,
  GENESISPAY_REQUEST_ID_HEADER,
  GENESISPAY_VERSION_HEADER,
  validateExpectedProductContract,
  type ExpectedProductContract,
  type FulfillmentResource,
  type FulfillmentVerification,
  type VerifiedPayment,
} from "./fulfillment.js";
import {
  isStrictVersionedResponse,
  requireStrictResponseMetadata,
} from "./strict-response.js";

const PRODUCT_SETTLEMENT_TIMEOUT_MS = 120_000;

export type ProductDelivery =
  | { type: "none" }
  | { type: "redirect"; url: string; verifiedAt: string | null }
  | { type: "gate"; resourceUrl: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };

type ProductGateMethod = Extract<ProductDelivery, { type: "gate" }>["method"];

export type Product = {
  taxConfig: ItemTax | null;
  publicId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  sku: string | null;
  asset: "USDC" | "EURC";
  /** Decimal price in `asset`, as the server normalized it (e.g. "2", "0.5"). */
  price: string;
  /** Same price in 6-decimal minor units, as a string (no precision loss). */
  priceMinor: string;
  /**
   * Only an explicit `true` counts — an older backend that omits the field
   * must not read as "archived", and a product this SDK cannot classify must
   * not silently vanish from a catalogue sync.
   */
  archived: boolean;
  /** Where a paying buyer's entitlement redirects; null until the seller sets it. */
  fulfilmentUrl: string | null;
  fulfilmentVerifiedAt: string | null;
  /** Additive delivery contract; flat fulfilment fields remain for compatibility. */
  delivery: ProductDelivery;
  createdAt: string;
};

export type ProductCreateInput = {
  /** Omitted means unconfigured; human checkout requires explicit item tax. */
  taxConfig?: ItemTax;
  name: string;
  /** Decimal price, e.g. "2" or "2.00" — never a float. */
  price: string;
  description?: string;
  imageUrl?: string;
  /** The merchant's own key; unique per account, a repeat answers 409. */
  sku?: string;
  /** Defaults to USDC (the only settlement asset during the beta). */
  asset?: "USDC";
  delivery?: ProductDelivery;
};

export type ProductPaymentLink = {
  /** The product's one canonical reusable link — mint again and you get the same one. */
  link: CheckoutLink;
  /** True only on the call that actually created the link. */
  created: boolean;
};

export type ProductCheckoutCreateInput = {
  expected: ExpectedProductContract;
  clientReferenceId?: string | null;
  metadata?: Record<string, string> | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
};

export type ProductCheckoutLink = {
  object: "product_checkout_link";
  linkId: string;
  payUrl: string;
  productContractVersion: typeof GENESISPAY_API_VERSION;
  created: boolean;
  requestId: string;
  apiVersion: typeof GENESISPAY_API_VERSION;
};

export type ProductCheckoutCreationOptions = {
  idempotencyKey: string;
};

export type ProductGatePurchase = {
  product: NonNullable<VerifiedPayment["product"]> & { quantity: 1 };
  payment: VerifiedPayment;
  requestFingerprint: string;
};

export type ProductGate = {
  /** Fetches the product and idempotently ensures its canonical reusable link. */
  prime(): Promise<{ product: Product; paymentLink: ProductPaymentLink }>;
  /**
   * Protect a registered resource. The handler may run again after a confirmed
   * replay, so persist by `purchase.payment.attemptId` when effects are not
   * naturally idempotent.
   */
  protect(
    request: Request,
    expected: ExpectedProductContract,
    handler: (request: Request, purchase: ProductGatePurchase) => Response | Promise<Response>,
  ): Promise<Response>;
};

export interface ProductsResource {
  create(input: ProductCreateInput): Promise<Product>;
  /** Active products; pass `includeArchived: true` for the whole catalogue. */
  list(opts?: { includeArchived?: boolean }): Promise<Product[]>;
  retrieve(publicId: string): Promise<Product>;
  /**
   * Set or clear (`null`) the https fulfilment URL — where a paying buyer's
   * entitlement redirects. Changing it resets the server's verification stamp.
   */
  update(
    publicId: string,
    input: { fulfilmentUrl: string | null } | { delivery: ProductDelivery } | ItemTaxUpdate,
  ): Promise<Product>;
  /**
   * Stops NEW payment-link mints; the existing canonical link stays payable
   * (a buyer mid-checkout is not punished for a catalogue edit). Archiving
   * twice is a no-op that returns the same product.
   */
  archive(publicId: string): Promise<Product>;
  /**
   * Mint the product's canonical reusable payment link, or return the existing
   * one with `created: false`. Idempotent by construction: the one-live-link
   * rule is a database unique index, so even concurrent mints converge on the
   * same link.
   */
  createPaymentLink(publicId: string): Promise<ProductPaymentLink>;
  /** Fail-closed readiness check against the seller's current product contract. */
  assertContract(expected: ExpectedProductContract): Promise<void>;
  /** Create one product-backed single-use link with seller-account-scoped idempotency. */
  createCheckout(
    input: ProductCheckoutCreateInput,
    options: ProductCheckoutCreationOptions,
  ): Promise<ProductCheckoutLink>;
  /**
   * The product's payable URL — convenience for
   * `createPaymentLink(publicId)` → `link.payUrl`. The returned URL embeds the
   * link's `inv_` id, which changes when the link is archived and reminted
   * (e.g. a wallet migration): resolve it at render time, never hardcode it.
   * The mint is idempotent, but it is still a write — don't put it in a hot
   * render path uncached; prefer `permalink` where stability is what you need.
   */
  checkoutUrl(publicId: string): Promise<string>;
  /**
   * The product's PERMANENT checkout URL (`{baseUrl}/pay/p/{publicId}`) —
   * stable across every link remint, resolved server-side on every request.
   * Pure string builder: no network call, no mint. This is the URL to embed
   * in a shop's buy button.
   */
  permalink(publicId: string): string;
  gate(publicId: string): ProductGate;
}

export function createProductsResource(
  request: GenesisPayRequest,
  /**
   * Applies the client's `expectedPayTo` pin to the wallet the server froze
   * onto the minted link — the destination every sale of this product settles
   * to, which is exactly the value the pin exists to guard.
   */
  assertPinnedDestination: (wallet: unknown, what: string) => void,
  /** The client's raw-link mapper, so link shapes cannot drift between resources. */
  toLink: (raw: Record<string, unknown>) => CheckoutLink,
  /** The client's origin (no trailing slash) — the base of `permalink()`. */
  baseUrl: string,
  verifyFulfillment: FulfillmentResource["verify"],
  rawGateRequest?: (publicId: string, body: Record<string, unknown>) => Promise<Response>,
  strictRequest?: (input: {
    method?: "GET" | "POST";
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => Promise<Response>,
): ProductsResource {
  const resources: ProductsResource = {
    create: async (input) => {
      const body = await request({
        method: "POST",
        path: "/api/v1/products",
        operation: "POST /api/v1/products",
        action: "create a product",
        body: {
          name: input.name,
          price: input.price,
          ...(input.description ? { description: input.description } : {}),
          ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
          ...(input.sku ? { sku: input.sku } : {}),
          ...(input.asset ? { asset: input.asset } : {}),
          ...(input.delivery ? { delivery: input.delivery } : {}),
          ...(input.taxConfig ? { taxConfig: parseItemTax(input.taxConfig) } : {}),
        },
      });
      return requireProduct(body, "POST /api/v1/products");
    },

    list: async (opts) => {
      const query = opts?.includeArchived ? "?includeArchived=true" : "";
      const body = await request({
        path: `/api/v1/products${query}`,
        operation: "GET /api/v1/products",
        action: "list products",
      });
      const products = asRecord(body)?.products;
      if (!Array.isArray(products)) {
        // A list endpoint that answers 200 without a list is a broken
        // contract, not an old backend. Returning [] would hide it as "no
        // products yet".
        throw new GenesisPayConfigError(
          `GenesisPay GET /api/v1/products returned no products array: ${JSON.stringify(body)}`,
        );
      }
      // Individual entries stay tolerant: one unusable row must not lose the rest.
      return products
        .map(asRecord)
        .filter((raw): raw is Record<string, unknown> => raw !== null)
        .filter((raw) => typeof raw.publicId === "string" && raw.publicId.length > 0)
        .map(toProduct);
    },

    retrieve: async (publicId) => {
      const id = requirePublicId(publicId, "products.retrieve");
      const body = await request({
        path: `/api/v1/products/${encodeURIComponent(id)}`,
        operation: `GET /api/v1/products/${id}`,
        action: `retrieve product "${id}"`,
        notFoundMessage: notFoundMessage(id),
      });
      return requireProduct(body, `GET /api/v1/products/${id}`);
    },

    update: async (publicId, input) => {
      const id = requirePublicId(publicId, "products.update");
      const body = await request({
        method: "PATCH",
        path: `/api/v1/products/${encodeURIComponent(id)}`,
        operation: `PATCH /api/v1/products/${id}`,
        action: `update product "${id}"`,
        notFoundMessage: notFoundMessage(id),
        body: "taxConfig" in input
          ? { taxConfig: parseItemTax(input.taxConfig), expectedTaxConfig: parseItemTax(input.expectedTaxConfig) }
          : "delivery" in input ? { delivery: input.delivery } : { fulfilmentUrl: input.fulfilmentUrl },
      });
      return requireProduct(body, `PATCH /api/v1/products/${id}`);
    },

    archive: async (publicId) => {
      const id = requirePublicId(publicId, "products.archive");
      const body = await request({
        method: "POST",
        path: `/api/v1/products/${encodeURIComponent(id)}/archive`,
        operation: `POST /api/v1/products/${id}/archive`,
        action: `archive product "${id}"`,
        notFoundMessage: notFoundMessage(id),
      });
      return requireProduct(body, `POST /api/v1/products/${id}/archive`);
    },

    createPaymentLink: async (publicId) => {
      const id = requirePublicId(publicId, "products.createPaymentLink");
      const body = await request({
        method: "POST",
        path: `/api/v1/products/${encodeURIComponent(id)}/payment-link`,
        operation: `POST /api/v1/products/${id}/payment-link`,
        action: `mint the payment link for product "${id}"`,
        notFoundMessage: notFoundMessage(id),
        hint: (status) =>
          status === 409
            ? "An archived product mints no new links, and selling needs a receiving wallet on the account."
            : undefined,
      });
      const record = asRecord(body);
      const rawLink = asRecord(record?.link);
      if (!rawLink || typeof rawLink.publicId !== "string" || !rawLink.publicId) {
        throw new GenesisPayConfigError(
          `GenesisPay POST /api/v1/products/${id}/payment-link returned no link: ${JSON.stringify(body)}`,
        );
      }
      assertPinnedDestination(rawLink.destinationWallet, "product payment link");
      return {
        link: toLink(rawLink),
        // Only an explicit true: a proxy that drops the field must not report
        // every idempotent re-mint as a fresh link.
        created: record?.created === true,
      };
    },

    assertContract: async (expectedInput) => {
      if (!strictRequest) throw new GenesisPayConfigError("This GenesisPay client cannot verify product contracts.");
      const expected = validateExpectedProductContract(expectedInput);
      assertPinnedDestination(expected.settlementDestination, "product contract");
      const response = await strictRequest({
        path: `/api/v1/products/${encodeURIComponent(expected.productId)}/contract`,
      });
      const body = await response.clone().json().catch(() => null) as unknown;
      if (!response.ok) throwStrictProductError(response, body);
      assertProductContractResponse(response, body, expected);
    },

    createCheckout: async (input, options) => {
      if (!strictRequest) throw new GenesisPayConfigError("This GenesisPay client cannot create product checkout links.");
      const expected = validateExpectedProductContract(input?.expected);
      assertPinnedDestination(expected.settlementDestination, "product checkout contract");
      const idempotencyKey = requireStrictIdempotencyKey(options);
      const response = await strictRequest({
        method: "POST",
        path: `/api/v1/products/${encodeURIComponent(expected.productId)}/checkouts`,
        headers: { "Idempotency-Key": idempotencyKey },
        body: {
          expected: { ...expected, grossAmountMinor: expected.grossAmountMinor.toString() },
          clientReferenceId: input.clientReferenceId ?? null,
          metadata: input.metadata ?? null,
          returnUrl: input.returnUrl ?? null,
          cancelUrl: input.cancelUrl ?? null,
        },
      });
      const body = await response.clone().json().catch(() => null) as unknown;
      if (!response.ok) throwStrictProductError(response, body);
      return parseProductCheckoutResponse(response, body);
    },

    checkoutUrl: async (publicId) => {
      const { link } = await resources.createPaymentLink(publicId);
      return link.payUrl;
    },

    permalink: (publicId) =>
      `${baseUrl}/pay/p/${encodeURIComponent(requirePublicId(publicId, "products.permalink"))}`,

    gate: (publicId) => createProductGate({
      publicId: requirePublicId(publicId, "products.gate"),
      retrieve: async () => {
        const body = await request({
          path: `/api/v1/products/${encodeURIComponent(publicId)}`,
          operation: `GET /api/v1/products/${publicId}`,
          action: `retrieve product "${publicId}"`,
          notFoundMessage: notFoundMessage(publicId),
        });
        return requireProduct(body, `GET /api/v1/products/${publicId}`);
      },
      createPaymentLink: async () => {
        const body = await request({
          method: "POST",
          path: `/api/v1/products/${encodeURIComponent(publicId)}/payment-link`,
          operation: `POST /api/v1/products/${publicId}/payment-link`, action: `mint the payment link for product "${publicId}"`,
          notFoundMessage: notFoundMessage(publicId),
        });
        const record = asRecord(body); const rawLink = asRecord(record?.link);
        if (!rawLink || typeof rawLink.publicId !== "string" || !rawLink.publicId) throw new GenesisPayConfigError("GenesisPay product gate returned no link.");
        assertPinnedDestination(rawLink.destinationWallet, "product payment link");
        return { link: toLink(rawLink), created: record?.created === true };
      },
      statusRequest: strictRequest
        ? (planId) => strictRequest({
            path: `/api/v1/settlements/${encodeURIComponent(planId)}`,
          })
        : undefined,
      verifyFulfillment,
      assertPinnedDestination,
      request: rawGateRequest,
    }),
  };

  return resources;
}

function notFoundMessage(id: string): string {
  return (
    `No GenesisPay product with publicId "${id}". Check the id and that it ` +
    `belongs to the account this API key authenticates.`
  );
}

function requirePublicId(publicId: string, method: string): string {
  const id = publicId?.trim();
  if (!id) {
    throw new GenesisPayConfigError(
      `${method}(publicId) requires the publicId returned by products.create().`,
    );
  }
  return id;
}

function requireProduct(body: unknown, operation: string): Product {
  const raw = asRecord(asRecord(body)?.product);
  if (!raw || typeof raw.publicId !== "string" || !raw.publicId) {
    throw new GenesisPayConfigError(
      `GenesisPay ${operation} returned no product: ${JSON.stringify(body)}`,
    );
  }
  return toProduct(raw);
}

export function toProduct(raw: Record<string, unknown>): Product {
  return {
    taxConfig: parseItemTax(raw.taxConfig),
    publicId: requiredString(raw.publicId),
    name: requiredString(raw.name),
    description: optionalString(raw.description),
    imageUrl: optionalString(raw.imageUrl),
    sku: optionalString(raw.sku),
    asset: oneOf(raw.asset, ["USDC", "EURC"] as const, "USDC"),
    price: toAmountString(raw.price),
    priceMinor: toAmountString(raw.priceMinor),
    archived: raw.archived === true,
    fulfilmentUrl: optionalString(raw.fulfilmentUrl),
    fulfilmentVerifiedAt: optionalString(raw.fulfilmentVerifiedAt),
    delivery: toProductDelivery(raw),
    createdAt: requiredString(raw.createdAt),
  };
}

function toProductDelivery(raw: Record<string, unknown>): ProductDelivery {
  const delivery = asRecord(raw.delivery);
  if (delivery?.type === "redirect" && typeof delivery.url === "string") {
    return { type: "redirect", url: delivery.url, verifiedAt: optionalString(delivery.verifiedAt) };
  }
  if (delivery?.type === "gate" && typeof delivery.resourceUrl === "string") {
    return { type: "gate", resourceUrl: delivery.resourceUrl, method: oneOf(delivery.method, ["GET", "POST", "PUT", "PATCH", "DELETE"] as const, "POST") };
  }
  // Compatibility with servers older than the additive delivery field.
  const url = optionalString(raw.fulfilmentUrl);
  return url ? { type: "redirect", url, verifiedAt: optionalString(raw.fulfilmentVerifiedAt) } : { type: "none" };
}

function requireStrictIdempotencyKey(options: ProductCheckoutCreationOptions | undefined): string {
  const value = options?.idempotencyKey;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value
  ) {
    throw new GenesisPayValidationError(
      "products.createCheckout requires an idempotencyKey with 1–255 characters and no surrounding whitespace.",
      [{ path: "idempotencyKey", message: "invalid idempotency key" }],
    );
  }
  return value;
}

function strictResponseMetadata(
  response: Response,
  body: unknown,
): { requestId: string; apiVersion: typeof GENESISPAY_API_VERSION } {
  return requireStrictResponseMetadata(response, body, "product");
}

function assertProductContractResponse(
  response: Response,
  body: unknown,
  expected: ExpectedProductContract,
): void {
  const metadata = strictResponseMetadata(response, body);
  const contract = asRecord(asRecord(body)?.contract);
  if (!contract || contract.object !== "product_contract") {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product contract response omitted its product_contract object.",
      metadata,
    );
  }
  const amount = contract.grossAmountMinor;
  if (
    typeof amount !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(amount) ||
    amount.length > 13 ||
    BigInt(amount) <= 0n ||
    BigInt(amount) > 1_000_000_000_000n
  ) {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product contract grossAmountMinor is not canonical product money.",
      metadata,
    );
  }
  const productId = contract.productId;
  const settlementDestination = contract.settlementDestination;
  const network = requireStrictProductNetwork(contract.network, metadata);
  const delivery = requireStrictProductDelivery(contract.delivery, metadata);
  if (
    typeof productId !== "string" ||
    productId.length === 0 ||
    typeof settlementDestination !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(settlementDestination)
  ) {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product contract omitted a typed product identity or settlement destination.",
      metadata,
    );
  }
  const actualSku = contract.sku === null || typeof contract.sku === "string" ? contract.sku : undefined;
  if (actualSku === undefined) {
    throw new GenesisPayEvidenceError("malformed_evidence", "Product SKU must be string or null.", metadata);
  }

  const mismatches: string[] = [];
  const compare = (path: string, equal: boolean) => {
    if (!equal) mismatches.push(path);
  };
  compare("productId", productId === expected.productId);
  compare("sku", actualSku === expected.sku);
  compare("grossAmountMinor", amount === expected.grossAmountMinor.toString());
  compare("settlementDestination", equalAddress(settlementDestination, expected.settlementDestination));
  compare("network.mode", network.mode === expected.network.mode);
  compare("network.network", network.network === expected.network.network);
  compare("network.chainId", network.chainId === expected.network.chainId);
  compare("network.asset", network.asset === expected.network.asset);
  compare("network.tokenAddress", equalAddress(network.tokenAddress, expected.network.tokenAddress));
  compare("network.minorUnitScale", network.minorUnitScale === expected.network.minorUnitScale);
  compare("delivery.type", delivery.type === expected.delivery.type);
  compare("delivery.url", delivery.url === expected.delivery.url);
  if (expected.delivery.type === "gate") {
    const actualGate = asRecord(delivery.gate);
    compare("delivery.gate.method", actualGate?.method === expected.delivery.gate?.method);
    compare(
      "delivery.gate.resourceUrl",
      actualGate?.resourceUrl === expected.delivery.gate?.resourceUrl,
    );
    // The request fingerprint is deliberately not compared here: it is derived
    // from one concrete request (method + canonical URL + body digest), so it
    // cannot be part of the product contract the backend emits. The gate's
    // `protect` path compares it against the actual request instead.
  } else {
    compare("delivery.gate", delivery.gate === null);
  }
  if (mismatches.length > 0) {
    throw new GenesisPayContractMismatchError(
      `GenesisPay product no longer matches the expected contract (${mismatches.join(", ")}).`,
      mismatches,
      metadata,
    );
  }
}

function requireStrictProductNetwork(
  value: unknown,
  metadata: { requestId: string; apiVersion: typeof GENESISPAY_API_VERSION },
): Record<string, unknown> {
  const network = asRecord(value);
  if (
    !network ||
    (network.mode !== "test" && network.mode !== "live") ||
    network.network !== "base" ||
    (network.chainId !== 8453 && network.chainId !== 84532) ||
    (network.asset !== "USDC" && network.asset !== "EURC") ||
    typeof network.tokenAddress !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(network.tokenAddress) ||
    network.minorUnitScale !== 6
  ) {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product contract network is missing a required typed authority field.",
      metadata,
    );
  }
  return network;
}

function requireStrictProductDelivery(
  value: unknown,
  metadata: { requestId: string; apiVersion: typeof GENESISPAY_API_VERSION },
): Record<string, unknown> {
  const delivery = asRecord(value);
  if (!delivery || (delivery.type !== "none" && delivery.type !== "url" && delivery.type !== "gate")) {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product contract delivery has an unsupported type.",
      metadata,
    );
  }
  if (delivery.type === "none") {
    if (delivery.url !== null || delivery.gate !== null) {
      throw new GenesisPayEvidenceError(
        "inconsistent_evidence",
        "Product contract none delivery must carry null URL and gate fields.",
        metadata,
      );
    }
    return delivery;
  }
  if (delivery.type === "url") {
    if (delivery.gate !== null || requireCanonicalStrictProductUrl(delivery.url, metadata) === null) {
      throw new GenesisPayEvidenceError(
        "inconsistent_evidence",
        "Product contract URL delivery must carry one canonical URL and a null gate.",
        metadata,
      );
    }
    return delivery;
  }

  if (delivery.url !== null) {
    throw new GenesisPayEvidenceError(
      "inconsistent_evidence",
      "Product contract gate delivery must carry a null delivery URL.",
      metadata,
    );
  }
  const gate = asRecord(delivery.gate);
  if (
    !gate ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(gate.method)) ||
    requireCanonicalStrictProductUrl(gate.resourceUrl, metadata) === null
  ) {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product contract gate delivery is missing its typed method or canonical resource URL.",
      metadata,
    );
  }
  return delivery;
}

function requireCanonicalStrictProductUrl(
  value: unknown,
  metadata: { requestId: string; apiVersion: typeof GENESISPAY_API_VERSION },
): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== value) {
      throw new Error("unsafe or noncanonical product authority URL");
    }
    return url.href;
  } catch {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product contract authority URL is unsafe or not canonically serialized.",
      metadata,
    );
  }
}

function parseProductCheckoutResponse(response: Response, body: unknown): ProductCheckoutLink {
  const metadata = strictResponseMetadata(response, body);
  const root = asRecord(body);
  if (
    root?.object !== "product_checkout_link" ||
    typeof root.linkId !== "string" ||
    !root.linkId ||
    typeof root.payUrl !== "string" ||
    !root.payUrl ||
    root.productContractVersion !== GENESISPAY_API_VERSION ||
    typeof root.created !== "boolean"
  ) {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      "Product checkout response is missing a required typed field.",
      metadata,
    );
  }
  return {
    object: "product_checkout_link",
    linkId: root.linkId,
    payUrl: root.payUrl,
    productContractVersion: GENESISPAY_API_VERSION,
    created: root.created,
    requestId: metadata.requestId,
    apiVersion: metadata.apiVersion,
  };
}

function equalAddress(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(actual) &&
    actual.toLowerCase() === expected.toLowerCase()
  );
}

function throwStrictProductError(response: Response, body: unknown): never {
  const metadata = strictResponseMetadata(response, body);
  const root = asRecord(body);
  const code = typeof root?.code === "string" ? root.code : null;
  const message =
    typeof root?.error === "string"
      ? root.error
      : `GenesisPay product request failed with HTTP ${response.status}.`;
  if (code === "unsupported_api_version") {
    throw new GenesisPayVersionError(code, message, metadata);
  }
  if (code === "contract_mismatch") {
    const mismatches = Array.isArray(root?.mismatches)
      ? root.mismatches.filter((value): value is string => typeof value === "string")
      : [];
    throw new GenesisPayContractMismatchError(message, mismatches, metadata);
  }
  if (code === "not_found") throw new GenesisPayNotFoundError(message, metadata);
  if (response.status === 422) {
    const issues = Array.isArray(root?.issues)
      ? root.issues.flatMap((entry) => {
          const issue = asRecord(entry);
          return typeof issue?.message === "string"
            ? [{ path: typeof issue.path === "string" ? issue.path : "", message: issue.message }]
            : [];
        })
      : [];
    throw new GenesisPayValidationError(message, issues, metadata);
  }
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    throw new GenesisPayRateLimitError(
      message,
      retry && /^\d+$/.test(retry) ? Number(retry) : null,
      metadata,
    );
  }
  throw new GenesisPayConfigError(message, metadata);
}

function createProductGate(input: {
  publicId: string;
  retrieve(): Promise<Product>;
  createPaymentLink(): Promise<ProductPaymentLink>;
  verifyFulfillment: FulfillmentResource["verify"];
  assertPinnedDestination(wallet: unknown, what: string): void;
  request?: (publicId: string, body: Record<string, unknown>) => Promise<Response>;
  statusRequest?: (planId: string) => Promise<Response>;
}): ProductGate {
  return {
    async prime() {
      const product = await input.retrieve();
      if (product.delivery.type !== "gate") throw new GenesisPayConfigError(`Product "${input.publicId}" is not configured with gate delivery.`);
      return { product, paymentLink: await input.createPaymentLink() };
    },
    async protect(request, expectedInput, handler) {
      const signature = request.headers.get(PAYMENT_SIGNATURE_HEADER);
      const settlementDeadline = signature
        ? Date.now() + PRODUCT_SETTLEMENT_TIMEOUT_MS
        : null;
      const payerBroadcastRecovery = signature
        ? signedPayerBroadcastRecoveryResponse(signature)
        : null;
      if (!input.request) {
        if (payerBroadcastRecovery) {
          return knownBroadcastPreflightFailureResponse({
            settlementResponse: payerBroadcastRecovery,
            attemptId: null,
          });
        }
        throw new GenesisPayConfigError("This GenesisPay client cannot call product gates.");
      }
      let expected: ExpectedProductContract;
      let signedAttemptId: string | null = null;
      try {
        expected = validateExpectedProductContract(expectedInput);
        // MR-103: an explicit expected contract does not override the client's
        // local destination pin, including before a signed settlement request.
        input.assertPinnedDestination(expected.settlementDestination, "product gate contract");
        if (expected.productId !== input.publicId) {
          throw new GenesisPayContractMismatchError(
            "The product gate ID does not match expected.productId.",
            ["product.productId"],
          );
        }
        if (expected.delivery.type !== "gate" || !expected.delivery.gate) {
          throw new GenesisPayConfigError("A product gate requires expected.delivery.type gate.");
        }
        signedAttemptId = signature
          ? resolveSignedRequestAttemptId(request.url, signature)
          : null;
      } catch (error) {
        if (!payerBroadcastRecovery) throw error;
        return knownBroadcastPreflightFailureResponse({
          settlementResponse: payerBroadcastRecovery,
          attemptId: signedAttemptId,
        });
      }
      const preparationRequested =
        !signature &&
        request.headers.get(GENESISPAY_SETTLEMENT_PREPARE_HEADER) === "1";
      const expectedGate = expected.delivery.gate;

      if (preparationRequested) {
        const paramsHeader = request.headers.get(
          GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
        );
        const prepared =
          paramsHeader === null
            ? await readLegacyPrepareBody(request)
            : await readPurchaseBoundPrepareParams(request, paramsHeader, expectedGate);
        if (!prepared.ok) return prepared.response;
        const { payer, idempotencyKey, feeMode, authority, attemptId } = prepared;
        const response = await input.request(input.publicId, {
          action: "prepare",
          resourceUrl: expectedGate.resourceUrl,
          method: expectedGate.method,
          requestFingerprint: expectedGate.fingerprint.slice("sha256:".length),
          attemptId,
          payer,
          idempotencyKey,
          feeMode,
          ...(authority ? { authority } : {}),
          expected: toWireExpectedProductContract(expected),
        });
        if (response.ok && !(await respondedWithStrictVersion(response))) {
          return strictNegotiationFailedResponse(response);
        }
        return copyResponse(response);
      }

      const planId = request.headers.get("GENESISPAY-Settlement-Plan");
      let url: string;
      let requestMethod: string;
      let requestFingerprint: string;
      // Never read the mutable catalogue or mint a legacy link here. The
      // challenge carries the complete expected contract so GenesisPay can
      // compare it atomically with the exact frozen payable link before it
      // creates an attempt. A settlement similarly belongs to that intent.
      try {
        url = canonicalRequestUrl(request.url);
        requestMethod = request.method.toUpperCase();
        requestFingerprint = await createGateRequestFingerprint(request);
        const gateMismatches = [
          ...(url === expectedGate.resourceUrl ? [] : ["product.delivery.gate.resourceUrl"]),
          ...(requestMethod === expectedGate.method ? [] : ["product.delivery.gate.method"]),
          ...(requestFingerprint === expectedGate.fingerprint
            ? []
            : ["product.delivery.gate.fingerprint"]),
        ];
        if (gateMismatches.length > 0) {
          throw new GenesisPayContractMismatchError(
            `The request does not match the expected gate intent (${gateMismatches.join(", ")}).`,
            gateMismatches,
          );
        }
      } catch (error) {
        if (!payerBroadcastRecovery) throw error;
        return knownBroadcastPreflightFailureResponse({
          settlementResponse: payerBroadcastRecovery,
          attemptId: signedAttemptId,
        });
      }
      const gateResourceUrl = url;
      const transportFingerprint = requestFingerprint.slice("sha256:".length);
      const gateBody = {
        action: signature ? "settle" : "challenge",
        resourceUrl: gateResourceUrl,
        method: requestMethod as ProductGateMethod,
        requestFingerprint: transportFingerprint,
        ...(!signature ? { expected: toWireExpectedProductContract(expected) } : {}),
        ...(signature
          ? {
              paymentSignature: signature,
              ...(planId ? { planId } : {}),
            }
          : {}),
      } as const;
      let response: Response;
      try {
        response = settlementDeadline === null
          ? await input.request(input.publicId, gateBody)
          : await productResponseBeforeDeadline(
              () => input.request!(input.publicId, gateBody),
              settlementDeadline,
            );
      } catch (error) {
        if (!signedAttemptId && !payerBroadcastRecovery) throw error;
        // The request never reached a response. Whether the settlement ran at
        // all is unknown, so the caller is told to retry or reconcile — never
        // that the payment confirmed.
        return fulfillmentUnavailableResponse({
          settlementResponse: payerBroadcastRecovery ?? new Response(null),
          attemptId: signedAttemptId,
          requestId: null,
          outcome: "unknown",
          retryable: true,
        });
      }
      if (
        signature &&
        planId &&
        response.status === 202 &&
        settlementDeadline !== null
      ) {
        let polling: Awaited<ReturnType<typeof pollProductSettlement>>;
        try {
          polling = await pollProductSettlement({
            acceptanceResponse: response,
            planId,
            statusRequest: input.statusRequest,
            fallbackSettlementResponse: payerBroadcastRecovery,
            timeoutDeadline: settlementDeadline,
          });
        } catch {
          return fulfillmentUnavailableResponse({
            settlementResponse: payerBroadcastRecovery ?? new Response(null),
            attemptId: signedAttemptId,
            requestId: null,
            outcome: "unknown",
            retryable: true,
          });
        }
        if (!polling.settled) return polling.response;
        try {
          response = await productResponseBeforeDeadline(
            () => input.request!(input.publicId, gateBody),
            settlementDeadline,
          );
        } catch {
          return fulfillmentUnavailableResponse({
            settlementResponse:
              signedPayerBroadcastRecoveryResponse(
                signature,
                polling.transactionHash,
              ) ?? new Response(null),
            attemptId: signedAttemptId,
            requestId: null,
            outcome: "unknown",
            retryable: true,
          });
        }
      }
      // A challenge is the last moment before a payer is asked for money, and
      // the only moment an un-upgraded backend can still be refused for free.
      // Every response a payer could ACT on is checked — the 402 offer and any
      // 2xx, since a backend that ignored `GENESISPAY-Version` may answer either
      // and the success path below would then describe a request in which
      // nothing was paid. A 4xx/5xx offers nothing to settle against, so it
      // passes through as itself rather than being relabelled a version problem;
      // reporting an outage as "upgrade your backend" sends people to the wrong
      // runbook.
      const payableChallenge = !signature && (response.ok || response.status === 402);
      if (payableChallenge && !(await respondedWithStrictVersion(response))) {
        return strictNegotiationFailedResponse(response);
      }
      if (!response.ok) {
        if (
          payerBroadcastRecovery &&
          response.status < 500
        ) {
          return fulfillmentUnavailableResponse({
            settlementResponse: payerBroadcastRecovery,
            attemptId: signedAttemptId,
            requestId: response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
            outcome: "unknown",
            retryable: true,
          });
        }
        if (
          response.status >= 500 &&
          (signedAttemptId || payerBroadcastRecovery)
        ) {
          if (!signedAttemptId) {
            return fulfillmentUnavailableResponse({
              settlementResponse: payerBroadcastRecovery ?? new Response(null),
              attemptId: null,
              requestId: response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
              outcome: "unknown",
              retryable: true,
            });
          }
          const recovery = await classifyStrictRecoveryResponse(
            response,
            signedAttemptId,
          );
          if (recovery === "copy") return copyResponse(response);
          // Only a backend that DECLARED a permanent evidence contradiction has
          // told us a payment confirmed. An unstructured 5xx may have failed
          // before the signature was ever verified, and a response about
          // another attempt (or from another API version) is not about this
          // payment at all — both leave the outcome unknown.
          const declaredPermanent = recovery === "declared_inconsistent";
          return fulfillmentUnavailableResponse({
            settlementResponse:
              recovery === "conflicting_identity"
                ? payerBroadcastRecovery ?? new Response(null)
                : payerBroadcastRecovery ?? response,
            attemptId: signedAttemptId,
            requestId: response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
            outcome: declaredPermanent ? "confirmed" : "unknown",
            retryable: !declaredPermanent,
          });
        }
        return copyResponse(response);
      }
      const payment = asRecord(await response.clone().json().catch(() => null));
      const resolvedAttempt = resolveSettlementAttemptId(response, payment);
      if (!resolvedAttempt.ok) {
        // A 2xx that carries no usable attempt identity did not establish a
        // confirmation — a proxy answering 200 with its own page says nothing
        // about this payment. Same skepticism an unstructured 5xx gets: report
        // the outcome as unknown and point the caller at retry/reconciliation.
        // The signed attempt id survives as the locator so the caller has
        // something concrete to reconcile against.
        return fulfillmentUnavailableResponse({
          settlementResponse: hasConflictingAttemptIdentity(response, payment, signedAttemptId)
            ? new Response(null)
            : response,
          attemptId: signedAttemptId,
          requestId: response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
          outcome: "unknown",
          retryable: true,
        });
      }
      const { attemptId } = resolvedAttempt;
      if (signedAttemptId && signedAttemptId !== attemptId) {
        // The response named a different attempt than the one this request
        // signed for. Keep the signed attempt as the reconciliation locator:
        // it is the attempt the caller asked about. Neither the confirmation
        // nor the receipt for that other attempt says what happened to this one.
        return fulfillmentUnavailableResponse({
          settlementResponse: new Response(null),
          attemptId: signedAttemptId,
          requestId: response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
          outcome: "unknown",
          retryable: true,
        });
      }

      // An attempt ID alone is a locator. Only a strict successful settlement
      // response establishes confirmation before the independent verification
      // succeeds; lost metadata must not turn a later outage into a money claim.
      const settlementConfirmed =
        payment?.success === true && isStrictVersionedResponse(response, payment);
      let verification: FulfillmentVerification;
      try {
        verification = await input.verifyFulfillment({
          locator: { attemptId },
          expected,
        });
      } catch (error) {
        return fulfillmentUnavailableResponse({
          settlementResponse: response,
          attemptId,
          requestId: authorityRequestId(error) ?? response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
          outcome: settlementConfirmed ? "confirmed" : "unknown",
          retryable: !isPermanentAuthorityError(error),
        });
      }
      if (!verification.verified) {
        return fulfillmentUnavailableResponse({
          settlementResponse: response,
          attemptId,
          requestId: verification.requestId,
          // A negative authority lookup cannot corroborate the settlement
          // response. Preserve that uncertainty instead of asserting payment.
          outcome: "unknown",
          retryable:
            verification.reason === "not_found" || verification.reason === "not_confirmed",
        });
      }

      const verifiedProduct = verification.payment.product;
      if (!verifiedProduct) {
        return fulfillmentUnavailableResponse({
          settlementResponse: response,
          attemptId,
          requestId: verification.requestId,
          outcome: "confirmed",
          retryable: false,
        });
      }
      const handlerResponse = await handler(request, {
        product: { ...verifiedProduct, quantity: 1 },
        payment: verification.payment,
        requestFingerprint,
      });
      const out = new Headers(handlerResponse.headers);
      const paymentResponse = response.headers.get(PAYMENT_RESPONSE_HEADER);
      if (paymentResponse) out.set(PAYMENT_RESPONSE_HEADER, paymentResponse);
      return new Response(handlerResponse.body, { status: handlerResponse.status, statusText: handlerResponse.statusText, headers: out });
    },
  };
}

async function pollProductSettlement(input: {
  acceptanceResponse: Response;
  planId: string;
  statusRequest: ((planId: string) => Promise<Response>) | undefined;
  fallbackSettlementResponse?: Response | null;
  timeoutDeadline: number;
}): Promise<
  | { settled: true; transactionHash: `0x${string}` }
  | { settled: false; response: Response }
> {
  if (!input.statusRequest) {
    return {
      settled: false,
      response: await copyPendingSettlementResponse(
        input.acceptanceResponse,
        input.fallbackSettlementResponse,
      ),
    };
  }
  const acceptance = asRecord(await productStatusBeforeDeadline(
    () => input.acceptanceResponse.clone().json().catch(() => null),
    input.timeoutDeadline,
  ));
  const expiresAtMs = typeof acceptance?.expiresAt === "string"
    ? Date.parse(acceptance.expiresAt)
    : Number.NaN;
  if (
    acceptance?.version !== 1 ||
    acceptance.state !== "queued" ||
    acceptance.planId !== input.planId ||
    !Number.isFinite(expiresAtMs)
  ) {
    return {
      settled: false,
      response: await copyPendingSettlementResponse(
        input.acceptanceResponse,
        input.fallbackSettlementResponse,
      ),
    };
  }
  const pollAfterMs = typeof acceptance.pollAfterMs === "number"
    ? Math.min(Math.max(Math.floor(acceptance.pollAfterMs), 100), 2_000)
    : 500;
  const timeoutDeadline = input.timeoutDeadline;
  let deadline = Math.min(expiresAtMs, timeoutDeadline);
  let submittedTxHash: `0x${string}` | null = null;
  let lastPendingResponse = await copyPendingSettlementResponse(
    input.acceptanceResponse.clone(),
    input.fallbackSettlementResponse,
  );
  // A replayed durable acceptance can be older than its issuance window while
  // its status is already submitted or settled. Read status once in that case;
  // repeat only inside the applicable queue/reconciliation deadline.
  let firstPoll = true;
  while (firstPoll || Date.now() < deadline) {
    const replayRead = firstPoll;
    firstPoll = false;
    let statusResponse: Response;
    let status: Record<string, unknown> | null;
    try {
      ({ response: statusResponse, status } = await productStatusBeforeDeadline(
        async () => {
          const rawResponse = await input.statusRequest!(input.planId);
          const bytes = await rawResponse.arrayBuffer();
          const response = new Response(bytes, {
            status: rawResponse.status,
            statusText: rawResponse.statusText,
            headers: rawResponse.headers,
          });
          return {
            response,
            status: asRecord(
              await response.clone().json().catch(() => null),
            ),
          };
        },
        replayRead && deadline <= Date.now() ? timeoutDeadline : deadline,
      ));
    } catch {
      return { settled: false, response: lastPendingResponse };
    }
    if (
      statusResponse.ok &&
      (status?.version !== 1 || status.planId !== input.planId)
    ) {
      return { settled: false, response: lastPendingResponse };
    }
    if (
      statusResponse.ok &&
      status?.state === "settled" &&
      status.sellerTransferVerified === true &&
      typeof status.txHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(status.txHash)
    ) {
      return {
        settled: true,
        transactionHash: status.txHash as `0x${string}`,
      };
    }
    if (!statusResponse.ok) {
      return {
        settled: false,
        response: submittedTxHash
          ? lastPendingResponse
          : await copyResponse(statusResponse),
      };
    }
    if (status?.state === "failed" || status?.state === "expired") {
      if (submittedTxHash) {
        return { settled: false, response: lastPendingResponse };
      }
      if (statusResponse.ok && status?.state === "failed") {
        return {
          settled: false,
          response: await copyTerminalSettlementResponse(statusResponse, 409),
        };
      }
      if (statusResponse.ok && status?.state === "expired") {
        return {
          settled: false,
          response: await copyTerminalSettlementResponse(statusResponse, 410),
        };
      }
    }
    if (status?.state !== "queued" && status?.state !== "submitted") {
      return { settled: false, response: lastPendingResponse };
    }
    if (status.state === "submitted") {
      if (
        typeof status.txHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(status.txHash)
      ) {
        return { settled: false, response: lastPendingResponse };
      }
      const candidate = status.txHash as `0x${string}`;
      if (
        submittedTxHash &&
        submittedTxHash.toLowerCase() !== candidate.toLowerCase()
      ) {
        return { settled: false, response: lastPendingResponse };
      }
      submittedTxHash = candidate;
      deadline = timeoutDeadline;
    }
    lastPendingResponse = await copyPendingSettlementResponse(
      statusResponse.clone(),
      input.fallbackSettlementResponse,
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollAfterMs, remainingMs)),
    );
  }
  return { settled: false, response: lastPendingResponse };
}

async function productStatusBeforeDeadline<T>(
  request: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error("settlement polling deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("settlement polling deadline exceeded")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function productResponseBeforeDeadline(
  request: () => Promise<Response>,
  deadlineMs: number,
): Promise<Response> {
  return productStatusBeforeDeadline(async () => {
    const rawResponse = await request();
    const bytes = await rawResponse.arrayBuffer();
    return new Response(bytes, {
      status: rawResponse.status,
      statusText: rawResponse.statusText,
      headers: rawResponse.headers,
    });
  }, deadlineMs);
}

function resolveSettlementAttemptId(
  response: Response,
  payment: Record<string, unknown> | null,
): { ok: true; attemptId: string } | { ok: false } {
  const bodyValue = payment?.paymentAttemptId;
  const headerValue = response.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER);
  const valid = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.trim() === value;

  if (bodyValue !== undefined && !valid(bodyValue)) return { ok: false };
  if (headerValue !== null && !valid(headerValue)) return { ok: false };
  if (valid(bodyValue) && valid(headerValue) && bodyValue !== headerValue) {
    return { ok: false };
  }
  const attemptId = valid(bodyValue) ? bodyValue : headerValue;
  return valid(attemptId) ? { ok: true, attemptId } : { ok: false };
}

type GatePrepareParams =
  | {
      ok: true;
      payer: string;
      idempotencyKey: string | null;
      feeMode: "collect" | "record_only";
      authority: unknown;
      attemptId: string;
    }
  | { ok: false; response: Response };

function invalidPrepareRequest(): { ok: false; response: Response } {
  return {
    ok: false,
    response: Response.json(
      { error: "Invalid settlement preparation request.", code: "invalid_request" },
      { status: 422 },
    ),
  };
}

/**
 * Legacy preparation (no params header): the request BODY is the plan
 * parameters, so it cannot be the purchase body. Kept byte-for-byte for GET
 * resources, hosted links and engines that predate the params header.
 */
async function readLegacyPrepareBody(request: Request): Promise<GatePrepareParams> {
  const preparedBody = asRecord(await request.clone().json().catch(() => null));
  const payer = preparedBody?.payer;
  const idempotencyKey = preparedBody?.idempotencyKey;
  const feeMode = preparedBody?.feeMode;
  const authority = preparedBody?.authority;
  const attemptId = gateAttemptIdFromUrl(request.url);
  if (
    typeof payer !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(payer) ||
    (idempotencyKey !== null && typeof idempotencyKey !== "string") ||
    (feeMode !== "collect" && feeMode !== "record_only") ||
    !attemptId
  ) {
    return invalidPrepareRequest();
  }
  return { ok: true, payer, idempotencyKey, feeMode, authority, attemptId };
}

/**
 * Purchase-bound preparation (ADR-0083): the plan parameters travel in
 * `GENESISPAY-Settlement-Prepare-Params`, so the request itself repeats the
 * purchase — method, URL and body. It must therefore match the expected gate
 * intent exactly as the challenge and the signed retry do; a preparation for a
 * different request is refused before GenesisPay freezes any authority
 * (MR-1011). A present but malformed header is refused, never read as a body.
 */
async function readPurchaseBoundPrepareParams(
  request: Request,
  paramsHeader: string,
  expectedGate: { resourceUrl: string; method: string; fingerprint: string },
): Promise<GatePrepareParams> {
  const params = decodeSettlementPrepareParamsHeader(paramsHeader);
  const attemptId = gateAttemptIdFromUrl(request.url);
  if (!params || !attemptId) return invalidPrepareRequest();
  let requestUrl: string;
  let requestFingerprint: string;
  try {
    requestUrl = canonicalRequestUrl(request.url);
    requestFingerprint = await createGateRequestFingerprint(request);
  } catch {
    return invalidPrepareRequest();
  }
  const mismatches = [
    ...(requestUrl === expectedGate.resourceUrl ? [] : ["product.delivery.gate.resourceUrl"]),
    ...(request.method.toUpperCase() === expectedGate.method
      ? []
      : ["product.delivery.gate.method"]),
    ...(requestFingerprint === expectedGate.fingerprint
      ? []
      : ["product.delivery.gate.fingerprint"]),
  ];
  if (mismatches.length > 0) {
    return {
      ok: false,
      response: Response.json(
        {
          error: `The preparation request does not match the expected gate intent (${mismatches.join(", ")}).`,
          code: "contract_mismatch",
          mismatches,
        },
        { status: 422 },
      ),
    };
  }
  return {
    ok: true,
    payer: params.payer,
    idempotencyKey: params.idempotencyKey,
    feeMode: params.feeMode,
    authority: params.authority,
    attemptId,
  };
}

function gateAttemptIdFromUrl(value: string): string | null {
  try {
    const attemptId = new URL(value).searchParams.get("gp_attempt");
    return attemptId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        attemptId,
      )
      ? attemptId
      : null;
  } catch {
    return null;
  }
}

/** Missing identity is inconclusive; an explicit contradiction invalidates its receipt. */
function hasConflictingAttemptIdentity(
  response: Response,
  body: Record<string, unknown> | null,
  signedAttemptId: string | null,
): boolean {
  const headerAttemptId = response.headers.get(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER);
  const bodyAttemptId = body?.paymentAttemptId;
  return (
    (signedAttemptId !== null &&
      ((headerAttemptId !== null && headerAttemptId !== signedAttemptId) ||
        (bodyAttemptId !== undefined && bodyAttemptId !== signedAttemptId))) ||
    (headerAttemptId !== null && bodyAttemptId !== undefined && headerAttemptId !== bodyAttemptId)
  );
}

/**
 * What a 5xx from a signed settlement can be trusted to mean.
 *
 * - `copy` — a complete strict recovery answer about THIS attempt; pass it on.
 * - `declared_inconsistent` — the backend itself declared a permanent evidence
 *   contradiction for this attempt, which implies a persisted confirmation.
 * - `conflicting_identity` — the response names another attempt or another API
 *   version; it says nothing about this payment.
 * - `unstructured` — an opaque 5xx that may predate signature verification.
 */
async function classifyStrictRecoveryResponse(
  response: Response,
  signedAttemptId: string,
): Promise<
  "copy" | "unstructured" | "declared_inconsistent" | "conflicting_identity"
> {
  const body = asRecord(await response.clone().json().catch(() => null));
  const error = asRecord(body?.error);
  const headerAttemptId = response.headers.get(
    GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER,
  );
  const bodyAttemptId = body?.paymentAttemptId;
  const headerVersion = response.headers.get(GENESISPAY_VERSION_HEADER);
  const bodyVersion = body?.apiVersion;
  const headerRequestId = response.headers.get(GENESISPAY_REQUEST_ID_HEADER);
  const bodyRequestId = body?.requestId;

  if (
    hasConflictingAttemptIdentity(response, body, signedAttemptId) ||
    (headerVersion !== null && headerVersion !== GENESISPAY_API_VERSION) ||
    (bodyVersion !== undefined && bodyVersion !== GENESISPAY_API_VERSION) ||
    (headerRequestId !== null &&
      bodyRequestId !== undefined &&
      headerRequestId !== bodyRequestId)
  ) {
    return "conflicting_identity";
  }
  // Other 5xx statuses are opaque outcomes, but their explicit identities must
  // still be checked before retaining any PAYMENT-RESPONSE during recovery.
  if (response.status !== 503) return "unstructured";

  const retryable = error?.retryable;
  const code = error?.code;
  const retryHeader = response.headers.get("retry-after");
  const cacheControl = response.headers.get("cache-control") ?? "";
  const hasNoStore = cacheControl
    .split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store");
  const requestIdIsValid =
    typeof bodyRequestId === "string" &&
    bodyRequestId.length > 0 &&
    bodyRequestId === headerRequestId;
  const errorIsValid =
    typeof error?.message === "string" &&
    (((code === "fulfillment_evidence_unavailable" ||
      code === "settlement_outcome_unknown") &&
      retryable === true &&
      retryHeader === "2") ||
      (code === "fulfillment_evidence_inconsistent" &&
        retryable === false &&
        retryHeader === null));

  const completeStrictRecovery =
    headerAttemptId === signedAttemptId &&
    bodyAttemptId === signedAttemptId &&
    headerVersion === GENESISPAY_API_VERSION &&
    bodyVersion === GENESISPAY_API_VERSION &&
    requestIdIsValid &&
    hasNoStore &&
    errorIsValid;
  if (completeStrictRecovery) return "copy";

  // A backend that has already identified a deterministic evidence
  // contradiction must never be made retryable merely because some response
  // metadata was lost or malformed in transit. Conflicting identities were
  // rejected above; preserve the fail-closed permanent classification here.
  if (code === "fulfillment_evidence_inconsistent" && retryable === false) {
    return "declared_inconsistent";
  }
  return "unstructured";
}

function resolveSignedRequestAttemptId(requestUrl: string, signature: string): string | null {
  const requestAttemptId = readAttemptId(requestUrl);
  let payloadAttemptId: string | null = null;
  try {
    const payloadUrl = decodePaymentSignatureHeader(signature).resource?.url;
    payloadAttemptId = payloadUrl ? readAttemptId(payloadUrl) : null;
  } catch {
    // The backend owns full signature validation. A malformed signature cannot
    // supply a recovery locator, but it should still receive the normal x402
    // error response when transport succeeds.
  }
  if (requestAttemptId && payloadAttemptId && requestAttemptId !== payloadAttemptId) {
    throw new GenesisPayAmbiguousLocatorError(
      "The signed request URL and PAYMENT-SIGNATURE carry different payment attempt IDs.",
    );
  }
  return requestAttemptId ?? payloadAttemptId;
}

function signedPayerBroadcastRecoveryResponse(
  signature: string,
  knownTransactionHash?: `0x${string}`,
): Response | null {
  try {
    const payment = decodePaymentSignatureHeader(signature);
    const extensions = payment.extensions;
    let transactionHash = knownTransactionHash ?? null;
    if (!transactionHash && extensions) {
      for (const key of ["txHash", "transaction", "transactionHash"] as const) {
        const value = extensions[key];
        if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
          transactionHash = value as `0x${string}`;
          break;
        }
      }
    }
    if (!transactionHash) return null;
    const settlement: SettlementResponsePayload = {
      success: false,
      transaction: transactionHash,
      network: payment.accepted.network,
      amount: payment.accepted.amount,
      errorReason:
        "The payer transaction may already be on-chain. Do not send another payment; retry or reconcile this attempt.",
      extensions: {
        authorizationVerified: false,
        settlementVerified: false,
        persistenceVerified: false,
      },
    };
    return new Response(null, {
      headers: {
        [PAYMENT_RESPONSE_HEADER]: encodeSettlementResponseHeader(settlement),
      },
    });
  } catch {
    return null;
  }
}

function knownBroadcastPreflightFailureResponse(input: {
  settlementResponse: Response;
  attemptId: string | null;
}): Response {
  return fulfillmentUnavailableResponse({
    settlementResponse: input.settlementResponse,
    attemptId: input.attemptId,
    requestId: null,
    outcome: "unknown",
    retryable: true,
  });
}

function readAttemptId(value: string): string | null {
  try {
    const attemptId = new URL(value).searchParams.get("gp_attempt");
    return attemptId && attemptId.length <= 120 && attemptId.trim() === attemptId
      ? attemptId
      : null;
  } catch {
    return null;
  }
}

/** Canonical SHA-256 gate intent fingerprint used in ExpectedProductContract. */
export async function createGateRequestFingerprint(request: Request): Promise<string> {
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const bodyHash = await sha256(body);
  const fingerprint = await sha256(
    new TextEncoder().encode(
      `${request.method.toUpperCase()}\n${canonicalRequestUrl(request.url)}\n${bodyHash}`,
    ),
  );
  return `sha256:${fingerprint}`;
}

function isPermanentAuthorityError(error: unknown): boolean {
  return (
    error instanceof GenesisPayContractMismatchError ||
    error instanceof GenesisPayAmbiguousLocatorError ||
    error instanceof GenesisPayEvidenceError ||
    error instanceof GenesisPayVersionError
  );
}

function authorityRequestId(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("requestId" in error)) return null;
  return typeof error.requestId === "string" ? error.requestId : null;
}

/**
 * The one response shape a strict gate returns when it cannot fulfil.
 *
 * `outcome` is the money claim, and it is not cosmetic: only a settlement this
 * SDK saw succeed may say "payment was confirmed". When the settlement outcome
 * is unknown — no response at all, or a 5xx that carries no strict evidence of
 * what happened — the caller is told exactly that and pointed at reconciliation,
 * because fulfilling on a payment that may never have happened is the failure
 * this whole surface exists to prevent (MR-804).
 */
function fulfillmentUnavailableResponse(input: {
  settlementResponse: Response;
  attemptId: string | null;
  requestId: string | null;
  outcome: "confirmed" | "unknown";
  retryable: boolean;
}): Response {
  const code = !input.retryable
    ? "fulfillment_evidence_inconsistent"
    : input.outcome === "unknown"
      ? "settlement_outcome_unknown"
      : "fulfillment_evidence_unavailable";
  const message =
    !input.retryable
      ? "Fulfillment evidence requires operator intervention. Reconcile the payment attempt before fulfilling."
      : input.outcome === "unknown"
        ? "The settlement outcome for this payment attempt is unknown. Retry, or reconcile the attempt with the fulfillment verification API, before fulfilling."
        : "Payment was confirmed but fulfillment evidence is temporarily unavailable.";
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
  });
  if (input.retryable) headers.set("retry-after", "2");
  if (input.attemptId) {
    headers.set(GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER, input.attemptId);
  }
  if (input.requestId) headers.set(GENESISPAY_REQUEST_ID_HEADER, input.requestId);
  const paymentResponse = input.settlementResponse.headers.get(PAYMENT_RESPONSE_HEADER);
  if (paymentResponse) headers.set(PAYMENT_RESPONSE_HEADER, paymentResponse);

  return Response.json(
    {
      error: { code, message, retryable: input.retryable },
      paymentAttemptId: input.attemptId,
      requestId: input.requestId,
      apiVersion: GENESISPAY_API_VERSION,
    },
    { status: 503, headers },
  );
}

/**
 * Did this response come from a backend that actually speaks the strict API
 * version we asked for? Reads a cloned body so the caller can still use the
 * original response.
 */
async function respondedWithStrictVersion(response: Response): Promise<boolean> {
  const body = await response.clone().json().catch(() => null);
  return isStrictVersionedResponse(response, body);
}

/**
 * The safe answer to an un-negotiated challenge: NOT a 402. It carries no
 * `accepts` offer and no PAYMENT-REQUIRED semantics, so no payer can settle
 * against it and no unverifiable attempt is created.
 *
 * The backend a challenge reached is the backend a settlement would reach, so
 * refusing here is also what keeps the settle path from ever meeting a 0.x
 * dialect it cannot establish evidence against.
 */
function strictNegotiationFailedResponse(response: Response): Response {
  return Response.json(
    {
      error: {
        code: "strict_version_unsupported",
        message:
          `This GenesisPay backend did not answer ${GENESISPAY_API_VERSION}. ` +
          "Upgrade the GenesisPay deployment before serving strict product gates; " +
          "no payment was requested.",
        retryable: false,
      },
      paymentAttemptId: null,
      requestId: response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
      apiVersion: GENESISPAY_API_VERSION,
    },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
      },
    },
  );
}

function toWireExpectedProductContract(
  expected: ExpectedProductContract,
): Record<string, unknown> {
  return {
    ...expected,
    grossAmountMinor: expected.grossAmountMinor.toString(),
  };
}

function canonicalRequestUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.delete("gp_attempt");
  url.hash = "";
  return url.toString();
}

async function sha256(value: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer because TypeScript's DOM declarations reject a
  // potentially shared ArrayBuffer view even though Web Crypto accepts bytes.
  const bytes = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function copyResponse(response: Response): Promise<Response> {
  return new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function copyPendingSettlementResponse(
  response: Response,
  fallbackSettlementResponse?: Response | null,
): Promise<Response> {
  const headers = new Headers(response.headers);
  const paymentResponse =
    headers.get(PAYMENT_RESPONSE_HEADER) ??
    fallbackSettlementResponse?.headers.get(PAYMENT_RESPONSE_HEADER);
  if (paymentResponse) headers.set(PAYMENT_RESPONSE_HEADER, paymentResponse);
  return new Response(await response.arrayBuffer(), {
    status: 202,
    headers,
  });
}

async function copyTerminalSettlementResponse(
  response: Response,
  status: 409 | 410,
): Promise<Response> {
  const headers = new Headers(response.headers);
  // A terminal queue status is not a settlement receipt. Never let a status
  // endpoint's accidental success header escape through the protected gate.
  headers.delete(PAYMENT_RESPONSE_HEADER);
  return new Response(await response.arrayBuffer(), { status, headers });
}
