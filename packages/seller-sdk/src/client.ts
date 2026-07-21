import {
  PeerPayConfigError,
  PeerPayNetworkSafetyError,
  throwForErrorResponse,
} from "./errors.js";
import { createMandatesResource } from "./mandates.js";
import type { MandatesResource } from "./mandates.js";
import { createPaymentGate } from "./payment-gate.js";
import type { PaymentGate, VerifySettlement } from "./payment-gate.js";
import { DEFAULT_FACILITATOR_BASE_URL, peerPaySettlement } from "./peerpay-settlement.js";
import { createPlansResource } from "./plans.js";
import type { PlansResource } from "./plans.js";
import { resolvePaymentGateNetwork } from "./networks.js";
import type { PaymentGateNetwork } from "./networks.js";
import {
  asRecord,
  oneOf,
  optionalMetadata,
  optionalString,
  requiredString,
  toCount,
  type PeerPayRequest,
  type PeerPayRequestOptions,
} from "./resource.js";
import { constructEvent } from "./webhooks.js";
import type { ConstructEventOptions, PeerPayEvent } from "./webhooks.js";

/**
 * The `PeerPay` client — a Stripe-like entry point that owns the seller key and
 * resolves everything else (payout wallet, network, base URL) from it. The key
 * prefix decides the mode: `pp_sk_test_…` / legacy `pp_sk_…` → test,
 * `pp_sk_live_…` → live. See docs/SELLER_SDK_DX_SPEC.md.
 */
export type PeerPayKeyMode = "test" | "live";

export type PeerPayClientOptions = {
  /** pp_sk_test_… | pp_sk_live_… | legacy pp_sk_… — the only required field. */
  apiKey: string;
  /** Overrides the mode→URL default (self-host / staging). Must be https (http only for localhost). */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Seller-config cache TTL. Default 5 min. */
  configTtlMs?: number;
  /** Optional local pin on the resolved payout wallet; recommended for live keys. */
  expectedPayTo?: string;
};

export type SellerConfig = {
  id: string;
  mode: PeerPayKeyMode;
  payTo: string | null;
  hasPayTo: boolean;
  network: {
    networkName: PaymentGateNetwork;
    chainId: number;
    usdcAddress: string;
    asset: "USDC";
  };
};

export type CheckoutCreateInput = {
  title: string;
  amountUsdc: string;
  description?: string;
  linkType?: "single" | "reusable";
  destinationWallet?: string;
  asset?: "USDC" | "EURC";
  /** Free-form correlation data; echoed back in webhooks and `checkout.retrieve()`. */
  metadata?: Record<string, string>;
  /** The merchant's own reference (Stripe: client_reference_id). */
  clientReferenceId?: string;
  /** Where the payer returns after a successful payment (https). */
  returnUrl?: string;
  /** Where the payer returns when they cancel (https). */
  cancelUrl?: string;
};

export type CheckoutLink = {
  publicId: string;
  payUrl: string;
  amountUsdc: string;
  title: string;
  metadata: Record<string, string> | null;
  clientReferenceId: string | null;
  returnUrl: string | null;
  cancelUrl: string | null;
};

/** Lifecycle of a single payment attempt on a link, as the server reports it. */
export type CheckoutAttemptStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired";

/**
 * One payment attempt against a checkout link — the receipt data (`txHash`,
 * `payerWallet`) that `paid === true` alone cannot give you.
 *
 * A `reusable` link accumulates attempts; the newest comes first. `txHash` is
 * null while an attempt is still pending, and stays null for attempts created
 * by the test-mode `simulate-payment` endpoint (no transaction exists).
 */
export type CheckoutAttempt = {
  id: string;
  status: CheckoutAttemptStatus;
  txHash: string | null;
  payerWallet: string | null;
  createdAt: string;
  confirmedAt: string | null;
  failureReason: string | null;
  /**
   * True for attempts created by `checkout.simulatePayment` in test mode. Note
   * that a simulated attempt also has `txHash: null` — but so does a pending
   * real one, which is why this flag exists rather than inferring it.
   *
   * Defaults to `false` against a backend that does not report it.
   */
  simulated: boolean;
};

export type CheckoutSession = CheckoutLink & {
  description: string | null;
  asset: "USDC" | "EURC";
  linkType: "single" | "reusable";
  status: "active" | "paid" | "archived";
  destinationWallet: string;
  chainId: number;
  /**
   * true as soon as at least one payment is confirmed — the value to poll on.
   *
   * For a `reusable` link this answers "has this link ever been paid", not "has
   * this buyer paid": `confirmedPaymentCount` only grows, so `paid` stays true
   * from the first payment onward. Per-buyer fulfilment on a reusable link needs
   * a webhook, or `confirmedPaymentCount` tracked as a delta.
   */
  paid: boolean;
  confirmedPaymentCount: number;
  createdAt: string;
  /**
   * Payment attempts for this link, newest first — empty when the server does
   * not report them (older backend) or when nobody has tried to pay yet.
   */
  attempts: CheckoutAttempt[];
};

export type SimulatePaymentOptions = {
  /**
   * Payer address recorded on the simulated attempt. Defaults to a deliberately
   * synthetic server-side placeholder, so nobody mistakes a simulated payment
   * for a real payer in a dashboard or an export.
   */
  payerWallet?: string;
};

export type GateConfig = {
  amountUsdc: string;
  description?: string;
  resource?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
};

type GateHandler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

export interface ResolvingGate {
  wrap<Args extends unknown[]>(
    handler: GateHandler<Args>,
    opts?: { verifySettlement?: VerifySettlement },
  ): (request: Request, ...args: Args) => Promise<Response>;
  /** Warm the seller-config cache (and surface auth/wallet errors) before traffic. */
  prime(): Promise<void>;
}

// The error classes live in ./errors.js (shared with every future resource:
// plans, mandates, …) and are re-exported here so existing imports from
// "./client.js" keep working.
export {
  PeerPayConfigError,
  PeerPayNetworkSafetyError,
  PeerPayNotFoundError,
  PeerPayRateLimitError,
  PeerPayValidationError,
  type PeerPayValidationIssue,
} from "./errors.js";

/**
 * Production PeerPay facilitator — the `peerpay-app` Railway production
 * environment (see docs/DEPLOY_RAILWAY.md). Hardcoded so a live key always
 * resolves to our facilitator with zero config, mirroring the test default.
 * Update this if/when PeerPay moves to a custom production domain (D4).
 */
const PRODUCTION_FACILITATOR_BASE_URL = "https://peerpay-app-production.up.railway.app";

// Both facilitator URLs are hardcoded so the key mode alone routes to the right
// PeerPay facilitator; an explicit `baseUrl` still overrides for self-host/staging.
const MODE_BASE_URLS: Record<PeerPayKeyMode, string> = {
  test: DEFAULT_FACILITATOR_BASE_URL,
  live: PRODUCTION_FACILITATOR_BASE_URL,
};

/**
 * Appended to the error when simulate-payment answers 403. The server sends its
 * own explanation in the body, but a proxy or a future rewording must not be
 * able to leave the caller without the one fact that matters: the endpoint is
 * gated on the *key mode*, and a live key can never mint a payment.
 */
const SIMULATE_PAYMENT_LIVE_KEY_HINT =
  "simulate-payment only works with a test-mode key (pp_sk_test_…); this client " +
  "is using a live key, and live keys can only record real, on-chain payments.";

/** Which networks each key mode may legitimately resolve to (fail-closed guard). */
const MODE_NETWORKS: Record<PeerPayKeyMode, PaymentGateNetwork[]> = {
  test: ["base-sepolia"],
  live: ["base"],
};

function parseKeyMode(apiKey: string): PeerPayKeyMode {
  if (apiKey.startsWith("pp_sk_live_")) return "live";
  if (apiKey.startsWith("pp_sk_")) return "test"; // pp_sk_test_… and legacy pp_sk_<32>
  throw new PeerPayConfigError(
    "apiKey must be a PeerPay seller key (pp_sk_test_… or pp_sk_live_…).",
  );
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const isHttps = /^https:\/\//i.test(trimmed);
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
  if (!isHttps && !isLocalHttp) {
    throw new PeerPayConfigError(`baseUrl must be https (got "${trimmed}").`);
  }
  return trimmed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Raw link shapes as they arrive over the wire. Everything is `unknown` because
 * an older backend (one that predates metadata/returnUrl) must not be able to
 * crash a newer SDK — every field is normalized below, missing ones become null.
 */
type RawCheckoutLink = {
  publicId?: unknown;
  payUrl?: unknown;
  amountUsdc?: unknown;
  title?: unknown;
  metadata?: unknown;
  clientReferenceId?: unknown;
  returnUrl?: unknown;
  cancelUrl?: unknown;
};

type RawCheckoutSession = RawCheckoutLink & {
  description?: unknown;
  asset?: unknown;
  linkType?: unknown;
  status?: unknown;
  destinationWallet?: unknown;
  chainId?: unknown;
  confirmedPaymentCount?: unknown;
  createdAt?: unknown;
  attempts?: unknown;
};

function toCheckoutLink(raw: RawCheckoutLink): CheckoutLink {
  return {
    publicId: requiredString(raw.publicId),
    payUrl: requiredString(raw.payUrl),
    amountUsdc: requiredString(raw.amountUsdc),
    title: requiredString(raw.title),
    metadata: optionalMetadata(raw.metadata),
    clientReferenceId: optionalString(raw.clientReferenceId),
    returnUrl: optionalString(raw.returnUrl),
    cancelUrl: optionalString(raw.cancelUrl),
  };
}

/**
 * Maps the server's attempt views tolerantly: a non-array (or missing) field
 * yields `[]`, an entry without a usable `id` is skipped, and every optional
 * field degrades to `null` — an older backend must never crash a poll loop.
 */
function toCheckoutAttempts(value: unknown): CheckoutAttempt[] {
  if (!Array.isArray(value)) return [];

  const attempts: CheckoutAttempt[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const id = optionalString(raw.id);
    if (!id) continue;

    attempts.push({
      id,
      status: oneOf(
        raw.status,
        ["pending", "submitted", "confirmed", "failed", "expired"] as const,
        "pending",
      ),
      txHash: optionalString(raw.txHash),
      payerWallet: optionalString(raw.payerWallet),
      createdAt: requiredString(raw.createdAt),
      confirmedAt: optionalString(raw.confirmedAt),
      failureReason: optionalString(raw.failureReason),
      // Only an explicit `true` counts: an older backend omits the field, and
      // treating anything truthy as simulated would misreport real payments.
      simulated: raw.simulated === true,
    });
  }
  return attempts;
}

function toCheckoutSession(raw: RawCheckoutSession): CheckoutSession {
  const confirmedPaymentCount = toCount(raw.confirmedPaymentCount);
  return {
    ...toCheckoutLink(raw),
    description: optionalString(raw.description),
    asset: oneOf(raw.asset, ["USDC", "EURC"] as const, "USDC"),
    linkType: oneOf(raw.linkType, ["single", "reusable"] as const, "single"),
    status: oneOf(raw.status, ["active", "paid", "archived"] as const, "active"),
    destinationWallet: requiredString(raw.destinationWallet),
    chainId: toCount(raw.chainId),
    // Derived, not sent by the server: one confirmed payment is what "paid" means
    // for a reusable link too, so this is the single value worth polling on.
    paid: confirmedPaymentCount > 0,
    confirmedPaymentCount,
    createdAt: requiredString(raw.createdAt),
    attempts: toCheckoutAttempts(raw.attempts),
  };
}

/**
 * Folds the `{ attempt, link }` that `simulate-payment` answers with into one
 * `CheckoutSession`, so the method returns the same shape `checkout.retrieve`
 * does and a test can go straight from simulating to asserting on `paid`.
 *
 * The merge is necessary rather than cosmetic: the simulate route's `link` is a
 * plain link view with no `confirmedPaymentCount` and no `attempts`, so mapping
 * it alone would report `paid: false` immediately after minting a confirmed
 * payment. The confirmed attempt from the same response supplies both.
 *
 * The one thing this cannot know is how many payments a *reusable* link already
 * had — `confirmedPaymentCount` is therefore "at least this one". Call
 * `checkout.retrieve()` when the exact total matters.
 */
function toSimulatedCheckoutSession(
  rawLink: RawCheckoutSession,
  attempt: CheckoutAttempt,
): CheckoutSession {
  const session = toCheckoutSession(rawLink);
  const confirmedPaymentCount =
    session.confirmedPaymentCount + (attempt.status === "confirmed" ? 1 : 0);

  return {
    ...session,
    attempts: [attempt, ...session.attempts],
    confirmedPaymentCount,
    paid: confirmedPaymentCount > 0,
  };
}

function paymentNotConfiguredResponse(): Response {
  return Response.json(
    {
      error: "payment_not_configured",
      message: "This seller has no receiving wallet configured yet.",
    },
    { status: 402 },
  );
}

function paymentUnavailableResponse(error: unknown): Response {
  return Response.json(
    {
      error: "payment_unavailable",
      message: `Payment is temporarily unavailable: ${describeError(error)}`,
    },
    { status: 503 },
  );
}

export class PeerPay {
  readonly mode: PeerPayKeyMode;
  readonly baseUrl: string;
  readonly checkout: {
    create(input: CheckoutCreateInput): Promise<CheckoutLink>;
    retrieve(publicId: string): Promise<CheckoutSession>;
    /**
     * Test mode only: records a confirmed payment on one of your links without
     * any money moving, and fires the real `payment.confirmed` (plus
     * `link.paid` for a single-use link) webhooks — the point being that you can
     * exercise your webhook handler end to end.
     *
     * The resulting attempt carries `simulated: true` and `txHash: null`; there
     * is no transaction, and a made-up hash would be a lie in a field other
     * systems point a block explorer at.
     */
    simulatePayment(
      publicId: string,
      opts?: SimulatePaymentOptions,
    ): Promise<CheckoutSession>;
  };
  /** Subscription plans and their hosted `checkoutUrl` — see ./plans.ts. */
  readonly plans: PlansResource;
  /**
   * Payment mandates: bounded, revocable spending approvals a payer signs once.
   *
   * There is no `mandates.activate` on purpose — activation carries the
   * *payer's* signature, is authorized by their wallet rather than by this API
   * key, and therefore belongs in the payer-facing frontend. See the module
   * comment in ./mandates.ts.
   */
  readonly mandates: MandatesResource;
  /**
   * Webhook signature verification. Also exported as the free function
   * `constructEvent` — a webhook route rarely has a client instance in scope,
   * and verification needs the endpoint secret rather than the API key.
   */
  readonly webhooks: {
    constructEvent(
      rawBody: string | Uint8Array,
      signatureHeader: string,
      secret: string,
      opts?: ConstructEventOptions,
    ): Promise<PeerPayEvent>;
  };

  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly configTtlMs: number;
  private readonly expectedPayTo?: string;

  private cache?: { config: SellerConfig; fetchedAt: number };
  private inflight?: Promise<SellerConfig>;

  /**
   * The single authenticated-JSON seam every resource goes through. Bound as a
   * field so it can be handed to `./plans.ts` / `./mandates.ts` without leaking
   * the key, the base URL or `fetch` into them.
   */
  private readonly request: PeerPayRequest = (options) => this.performRequest(options);

  constructor(options: PeerPayClientOptions) {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) {
      throw new PeerPayConfigError("apiKey (pp_sk_test_… / pp_sk_live_…) is required.");
    }
    this.apiKey = apiKey;
    this.mode = parseKeyMode(apiKey);

    const chosen = options.baseUrl?.trim() || MODE_BASE_URLS[this.mode];
    if (!chosen) {
      throw new PeerPayConfigError(
        `PeerPay ${this.mode} base URL is not configured yet; pass baseUrl explicitly.`,
      );
    }
    this.baseUrl = normalizeBaseUrl(chosen);
    this.fetchFn = options.fetchFn ?? fetch;
    this.configTtlMs = options.configTtlMs ?? 300_000;
    this.expectedPayTo = options.expectedPayTo?.trim().toLowerCase() || undefined;

    this.checkout = {
      create: (input) => this.createCheckout(input),
      retrieve: (publicId) => this.retrieveCheckout(publicId),
      simulatePayment: (publicId, opts) => this.simulateCheckoutPayment(publicId, opts),
    };

    // Both resources get the same bound request seam, so their errors go
    // through the one shared mapper in ./errors.ts like checkout's do.
    this.plans = createPlansResource(this.request, (wallet, what) =>
      this.assertPinnedDestination(wallet, what),
    );
    this.mandates = createMandatesResource(this.request);

    // Stateless pass-through: verification depends only on the endpoint secret,
    // never on this client's key, mode or base URL.
    this.webhooks = {
      constructEvent: (rawBody, signatureHeader, secret, opts) =>
        constructEvent(rawBody, signatureHeader, secret, opts),
    };
  }

  /**
   * Resolve (and cache) the seller config from the key. Single-flight so a
   * cold-start burst shares one request; failures are never cached (the memo is
   * cleared on rejection so the next call retries).
   */
  async retrieveSeller(opts?: { forceRefresh?: boolean }): Promise<SellerConfig> {
    const now = Date.now();
    if (!opts?.forceRefresh && this.cache && now - this.cache.fetchedAt < this.configTtlMs) {
      return this.cache.config;
    }
    if (!this.inflight) {
      this.inflight = this.fetchSeller()
        .then((config) => {
          this.cache = { config, fetchedAt: Date.now() };
          return config;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  gate(config: GateConfig): ResolvingGate {
    const innerGates = new Map<string, PaymentGate>();
    const defaultSettle = peerPaySettlement({
      facilitatorBaseUrl: this.baseUrl,
      apiKey: this.apiKey,
      fetchFn: this.fetchFn,
    });

    const buildInner = (seller: SellerConfig): PaymentGate => {
      // Key by (payTo, chainId): a wallet rotation after TTL builds a fresh gate,
      // while any single gate stays internally consistent across challenge/replay.
      const cacheKey = `${seller.payTo}:${seller.network.chainId}`;
      let inner = innerGates.get(cacheKey);
      if (!inner) {
        inner = createPaymentGate({
          amountUsdc: config.amountUsdc,
          payTo: seller.payTo as string,
          network: seller.network.networkName,
          description: config.description,
          resource: config.resource,
          mimeType: config.mimeType,
          maxTimeoutSeconds: config.maxTimeoutSeconds,
        });
        innerGates.set(cacheKey, inner);
      }
      return inner;
    };

    const resolveSeller = () => this.retrieveSeller();

    return {
      prime: async () => {
        await resolveSeller();
      },
      wrap: <Args extends unknown[]>(
        handler: GateHandler<Args>,
        opts?: { verifySettlement?: VerifySettlement },
      ) => {
        const verifySettlement = opts?.verifySettlement ?? defaultSettle;
        return async (request: Request, ...args: Args): Promise<Response> => {
          let seller: SellerConfig;
          try {
            seller = await resolveSeller();
          } catch (error) {
            // Fail closed: never run the paid handler when config can't be resolved.
            return paymentUnavailableResponse(error);
          }
          if (!seller.hasPayTo || !seller.payTo) {
            return paymentNotConfiguredResponse();
          }
          return buildInner(seller).wrap(handler, { verifySettlement })(request, ...args);
        };
      },
    };
  }

  private async fetchSeller(): Promise<SellerConfig> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/v1/seller`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
    } catch (error) {
      throw new PeerPayConfigError(
        `Failed to reach PeerPay to resolve the seller: ${describeError(error)}`,
      );
    }
    if (!response.ok) {
      // 401/403/500 land on PeerPayConfigError with the key/base-URL hint; a
      // 429 on the seller lookup is a rate limit like any other, not a broken key.
      await throwForErrorResponse(response, {
        operation: "GET /api/v1/seller",
        hint: "Could not resolve the seller — check the API key and base URL.",
      });
    }
    const config = (await response.json()) as SellerConfig;
    this.assertSafe(config);
    return config;
  }

  private assertSafe(config: SellerConfig): void {
    const net = config.network;

    // (1) Mode consistency: the mode encoded in the key prefix and the mode the
    // server resolved from its stored column must agree. For keys minted by this
    // system they always do (both come from the deployment network at creation);
    // a disagreement means key/DB corruption or a spoofed response — fail closed.
    if (config.mode !== this.mode) {
      throw new PeerPayNetworkSafetyError(
        `Key mode "${this.mode}" does not match the server-resolved mode "${config.mode}".`,
      );
    }

    // (2) Mode↔network: a live key must never resolve to a testnet, and vice
    // versa. Checked before the asset table so an unknown/foreign network name
    // surfaces as a typed safety error instead of a generic lookup throw.
    if (!MODE_NETWORKS[this.mode].includes(net.networkName)) {
      throw new PeerPayNetworkSafetyError(
        `A ${this.mode} key must not resolve to network "${net.networkName}".`,
      );
    }

    // (3) Asset integrity: the backend-reported USDC/chainId must match the
    // SDK's own native-USDC table for that (now-known) network.
    const known = resolvePaymentGateNetwork(net.networkName);
    if (
      known.chainId !== net.chainId ||
      known.usdcAddress.toLowerCase() !== String(net.usdcAddress).toLowerCase()
    ) {
      throw new PeerPayNetworkSafetyError(
        `Backend network is inconsistent for "${net.networkName}" (chainId ${net.chainId}, usdc ${net.usdcAddress}).`,
      );
    }

    // (4) Optional local pin on the payout wallet.
    if (this.expectedPayTo && config.payTo && config.payTo.toLowerCase() !== this.expectedPayTo) {
      throw new PeerPayNetworkSafetyError(
        `Resolved payTo does not match expectedPayTo.`,
      );
    }
  }

  /**
   * Applies the `expectedPayTo` pin to a destination the server just froze onto
   * a newly created object.
   *
   * Checking it in `assertSafe` alone was not enough: that only covers the
   * `/api/v1/seller` config lookup, while a checkout link and a subscription
   * plan each record their own `destinationWallet` at creation. Those are the
   * addresses money actually moves to — a pin that does not cover them is not
   * the guarantee the option advertises.
   */
  private assertPinnedDestination(wallet: unknown, what: string): void {
    if (!this.expectedPayTo) return;
    if (typeof wallet !== "string" || !wallet) return;
    if (wallet.toLowerCase() !== this.expectedPayTo) {
      throw new PeerPayNetworkSafetyError(
        `The ${what} was created with a destinationWallet that does not match expectedPayTo.`,
      );
    }
  }

  /**
   * One authenticated JSON round-trip, with the error mapping every method
   * shares. A transport failure (no response at all) is the only case handled
   * here rather than in `throwForErrorResponse`, because there is no status to
   * map — it is always a config/connectivity problem.
   */
  private async performRequest(options: PeerPayRequestOptions): Promise<unknown> {
    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${options.path}`, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new PeerPayConfigError(
        `Failed to reach PeerPay to ${options.action}: ${describeError(error)}`,
      );
    }

    if (!response.ok) {
      // Shared mapping: 422 → PeerPayValidationError (with the field issues),
      // 429 → PeerPayRateLimitError (with Retry-After), 404 → NotFound, rest → Config.
      await throwForErrorResponse(response, {
        operation: options.operation,
        notFoundMessage: options.notFoundMessage,
        hint:
          typeof options.hint === "function" ? options.hint(response.status) : options.hint,
      });
    }

    // An OK response with an unparseable body yields null; each caller decides
    // what a missing object means, and says so in its own error message.
    return (await response.json().catch(() => null)) as unknown;
  }

  private async createCheckout(input: CheckoutCreateInput): Promise<CheckoutLink> {
    const body = await this.request({
      method: "POST",
      path: "/api/v1/links",
      operation: "POST /api/v1/links",
      action: "create a checkout link",
      body: {
        title: input.title,
        description: input.description,
        amountUsdc: input.amountUsdc,
        linkType: input.linkType ?? "single",
        ...(input.destinationWallet ? { destinationWallet: input.destinationWallet } : {}),
        ...(input.asset ? { asset: input.asset } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.clientReferenceId ? { clientReferenceId: input.clientReferenceId } : {}),
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
      },
    });

    const link = asRecord(body)?.link as RawCheckoutLink | undefined;
    if (!link || typeof link.payUrl !== "string" || !link.payUrl) {
      throw new PeerPayConfigError(
        `PeerPay link created but no payUrl in response: ${JSON.stringify(body)}`,
      );
    }
    this.assertPinnedDestination(
      (link as { destinationWallet?: unknown }).destinationWallet,
      "checkout link",
    );
    return toCheckoutLink(link);
  }

  /**
   * Fetch the current state of a checkout link. `paid` is the field to poll on;
   * an unknown publicId raises `PeerPayNotFoundError`, never a config error.
   */
  private async retrieveCheckout(publicId: string): Promise<CheckoutSession> {
    const id = publicId?.trim();
    if (!id) {
      throw new PeerPayConfigError(
        "checkout.retrieve(publicId) requires the publicId returned by checkout.create().",
      );
    }

    const body = await this.request({
      path: `/api/v1/links/${encodeURIComponent(id)}`,
      operation: `GET /api/v1/links/${id}`,
      action: `retrieve checkout "${id}"`,
      notFoundMessage: `No PeerPay checkout with publicId "${id}". Check the id and that it belongs to the account this API key authenticates.`,
    });

    const link = asRecord(body)?.link as RawCheckoutSession | undefined;
    if (!link || typeof link.publicId !== "string" || !link.publicId) {
      throw new PeerPayConfigError(
        `PeerPay returned no link for publicId "${id}": ${JSON.stringify(body)}`,
      );
    }
    return toCheckoutSession(link);
  }

  /** Test-mode only — see the doc on `checkout.simulatePayment`. */
  private async simulateCheckoutPayment(
    publicId: string,
    opts?: SimulatePaymentOptions,
  ): Promise<CheckoutSession> {
    const id = publicId?.trim();
    if (!id) {
      throw new PeerPayConfigError(
        "checkout.simulatePayment(publicId) requires the publicId returned by checkout.create().",
      );
    }

    const body = await this.request({
      method: "POST",
      path: `/api/v1/links/${encodeURIComponent(id)}/simulate-payment`,
      operation: `POST /api/v1/links/${id}/simulate-payment`,
      action: `simulate a payment on checkout "${id}"`,
      body: opts?.payerWallet ? { payerWallet: opts.payerWallet } : {},
      // A 404 here has two very different causes and the server cannot tell you
      // which — by design, since a mainnet deployment must not even confirm the
      // endpoint exists. Naming both stops the "the id is definitely right, why
      // is it 404" hunt at the wrong end.
      notFoundMessage:
        `PeerPay simulate-payment returned 404 for checkout "${id}". Either no such ` +
        `checkout exists for the account this API key authenticates, or this PeerPay ` +
        `deployment runs on mainnet, where the endpoint does not exist at all. ` +
        `Check the publicId first, then the deployment's network.`,
      hint: (status) =>
        status === 403 ? SIMULATE_PAYMENT_LIVE_KEY_HINT : undefined,
    });

    const record = asRecord(body);
    const link = record?.link as RawCheckoutSession | undefined;
    if (!link || typeof link.publicId !== "string" || !link.publicId) {
      throw new PeerPayConfigError(
        `PeerPay simulated a payment on "${id}" but returned no link: ${JSON.stringify(body)}`,
      );
    }

    // The attempt is not an optional detail here the way an unknown field would
    // be: without it the merged session would report `paid: false` right after
    // a payment was minted. A 201 that omits it is a broken contract, not an
    // older backend — the endpoint and the field shipped together.
    const [attempt] = toCheckoutAttempts([record?.attempt]);
    if (!attempt) {
      throw new PeerPayConfigError(
        `PeerPay simulated a payment on "${id}" but returned no attempt: ${JSON.stringify(body)}`,
      );
    }
    return toSimulatedCheckoutSession(link, attempt);
  }
}
