// `genesispay.products.*` — the merchant's catalogue over `/api/v1/products`.
//
// A product is what a shop sells; its payable instance is one CANONICAL
// reusable checkout link, minted (idempotently) with `createPaymentLink`. The
// price and asset are copied onto the link at mint and never re-read from the
// catalogue, so editing or archiving a product cannot change what a buyer
// already sees. Everything is scoped to the key's own account: someone else's
// product answers 404 (GenesisPayNotFoundError), never 403 — the API is no
// catalogue-enumeration oracle, and the SDK does not paper over that.

import { GenesisPayConfigError } from "./errors.js";
import {
  asRecord,
  optionalString,
  requiredString,
  toAmountString,
  oneOf,
  type GenesisPayRequest,
} from "./resource.js";
import type { CheckoutLink } from "./client.js";
import { PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER } from "@genesis-tech/genesispay-protocol";

export type ProductDelivery =
  | { type: "none" }
  | { type: "redirect"; url: string; verifiedAt: string | null }
  | { type: "gate"; resourceUrl: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };

type ProductGateMethod = Extract<ProductDelivery, { type: "gate" }>["method"];

export type Product = {
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

export type ProductGatePurchase = {
  product: { publicId: string; sku: string | null; quantity: 1 };
  payment: {
    attemptId: string;
    txHash: string;
    payer: string | null;
    asset: "USDC";
    amountMinor: string;
    chainId: number;
    simulated: false;
    idempotentReplay: boolean;
  };
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
    input: { fulfilmentUrl: string | null } | { delivery: ProductDelivery },
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
  rawGateRequest?: (publicId: string, body: Record<string, unknown>) => Promise<Response>,
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
        body: "delivery" in input ? { delivery: input.delivery } : { fulfilmentUrl: input.fulfilmentUrl },
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

function createProductGate(input: {
  publicId: string;
  retrieve(): Promise<Product>;
  createPaymentLink(): Promise<ProductPaymentLink>;
  request?: (publicId: string, body: Record<string, unknown>) => Promise<Response>;
}): ProductGate {
  return {
    async prime() {
      const product = await input.retrieve();
      if (product.delivery.type !== "gate") throw new GenesisPayConfigError(`Product "${input.publicId}" is not configured with gate delivery.`);
      return { product, paymentLink: await input.createPaymentLink() };
    },
    async protect(request, handler) {
      if (!input.request) throw new GenesisPayConfigError("This GenesisPay client cannot call product gates.");
      const signature = request.headers.get(PAYMENT_SIGNATURE_HEADER);
      const url = canonicalRequestUrl(request.url);
      const requestMethod = request.method.toUpperCase();
      let product: Product | null = null;
      let gateResourceUrl: string;

      if (signature) {
        // A settled retry belongs to the immutable resource snapshot in its
        // gate intent. Do not reject it because the merchant edited the live
        // product URL after GenesisPay returned the original 402.
        gateResourceUrl = url;
      } else {
        const primed = await this.prime();
        product = primed.product;
        if (product.delivery.type !== "gate") throw new GenesisPayConfigError("Product is not a gate.");
        if (url !== canonicalRequestUrl(product.delivery.resourceUrl) || requestMethod !== product.delivery.method) {
          throw new GenesisPayConfigError("Incoming request does not match the product's registered gate resource.");
        }
        gateResourceUrl = product.delivery.resourceUrl;
      }

      const requestFingerprint = await fingerprintRequest(request);
      const response = await input.request(input.publicId, {
        action: signature ? "settle" : "challenge",
        resourceUrl: gateResourceUrl,
        method: requestMethod as ProductGateMethod,
        requestFingerprint,
        ...(signature ? { paymentSignature: signature } : {}),
      });
      if (!response.ok) return copyResponse(response);
      const payment = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
      const attemptId = typeof payment?.paymentAttemptId === "string" ? payment.paymentAttemptId : null;
      if (!attemptId) return copyResponse(response);
      // Product data is presentation/context, never payment authority. Reading
      // it after a signed retry is safe even if delivery has changed; GenesisPay
      // already checked the intent's seller/product/link ownership.
      product ??= await input.retrieve();
      const extension = asRecord(payment?.extensions);
      const handlerResponse = await handler(request, {
        product: { publicId: product.publicId, sku: product.sku, quantity: 1 },
        payment: {
          attemptId,
          txHash: typeof payment?.transaction === "string" ? payment.transaction : "",
          payer: optionalString(payment?.payer), asset: "USDC", amountMinor: toAmountString(payment?.amount),
          chainId: payment && Number.isInteger(payment.chainId) ? payment.chainId as number : 8453,
          simulated: false, idempotentReplay: extension?.idempotentReplay === true,
        },
        requestFingerprint,
      });
      const out = new Headers(handlerResponse.headers);
      const paymentResponse = response.headers.get(PAYMENT_RESPONSE_HEADER);
      if (paymentResponse) out.set(PAYMENT_RESPONSE_HEADER, paymentResponse);
      return new Response(handlerResponse.body, { status: handlerResponse.status, statusText: handlerResponse.statusText, headers: out });
    },
  };
}

async function fingerprintRequest(request: Request): Promise<string> {
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const bodyHash = await sha256(body);
  return sha256(new TextEncoder().encode(`${request.method.toUpperCase()}\n${canonicalRequestUrl(request.url)}\n${bodyHash}`));
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
