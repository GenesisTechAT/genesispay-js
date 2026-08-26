import {
  GenesisPayConfigError,
  GenesisPayNetworkSafetyError,
  GenesisPayValidationError,
  throwForErrorResponse,
  type GenesisPayValidationIssue,
} from "./errors.js";
import { createMandatesResource } from "./mandates.js";
import type { MandatesResource } from "./mandates.js";
import { createCustomersResource } from "./customers.js";
import type { CustomersResource } from "./customers.js";
import { createInvoicesResource } from "./invoices.js";
import type { InvoicesResource } from "./invoices.js";
import { createPaymentGate } from "./payment-gate.js";
import type { PaymentGate, VerifySettlement } from "./payment-gate.js";
import { DEFAULT_FACILITATOR_BASE_URL, genesisPaySettlement } from "./genesispay-settlement.js";
import { createPlansResource } from "./plans.js";
import type { PlansResource } from "./plans.js";
import { createProductsResource } from "./products.js";
import type { ProductsResource } from "./products.js";
import { createEntitlementsResource } from "./entitlements.js";
import type { EntitlementsResource } from "./entitlements.js";
import { resolvePaymentGateNetwork } from "./networks.js";
import type { PaymentGateNetwork } from "./networks.js";
import { parseUsdcAmountToMinorUnits } from "./usdc-amount.js";
import {
  asRecord,
  oneOf,
  optionalMetadata,
  optionalString,
  requiredString,
  toCount,
  type GenesisPayRequest,
  type GenesisPayRequestOptions,
} from "./resource.js";
import { constructEvent } from "./webhooks.js";
import type { ConstructEventOptions, GenesisPayEvent } from "./webhooks.js";
import { isPayerRedirectUrl } from "./checkout-return.js";

/**
 * The legacy `GenesisPay` client — a Stripe-like entry point that owns the seller key and
 * resolves everything else (payout wallet, network, base URL) from it. The key
 * prefix decides the mode: `gp_sk_test_…` / legacy `gp_sk_…` → test,
 * `gp_sk_live_…` → live. See docs/archive/SELLER_SDK_DX_SPEC.md.
 */
export type GenesisPayKeyMode = "test" | "live";

export type GenesisPayClientOptions = {
  /** gp_sk_test_… | gp_sk_live_… | legacy gp_sk_… — the only required field. */
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
  mode: GenesisPayKeyMode;
  payTo: string | null;
  hasPayTo: boolean;
  network: {
    networkName: PaymentGateNetwork;
    chainId: number;
    usdcAddress: string;
    asset: "USDC";
  };
};

/**
 * The amount half of {@link CheckoutCreateInput}, as a union so that **one of
 * the two names is always required at compile time** — `amountUsdc` was a
 * required property before 0.6.0, and losing that to two optional fields would
 * have turned a type error into a runtime one.
 */
export type CheckoutAmountInput =
  | {
      /**
       * Decimal amount **in `asset`** — `"5.00"`, at most 6 decimals, always a
       * string (a float would lose minor units). Hosted checkout links settle
       * in USDC during the beta, so the amount is in dollars.
       *
       * Passing the deprecated `amountUsdc` alongside it is allowed only when
       * both are the same amount; two different values throw
       * `GenesisPayValidationError` before the request.
       */
      amount: string;
      /** @deprecated Use `amount` alone. */
      amountUsdc?: string;
    }
  | {
      amount?: string;
      /**
       * @deprecated Renamed to `amount` in 0.6.0. The name claimed a currency
       * the value did not always have. Still accepted, and still sent on the wire for backends older than
       * 0.6.0 — but new code should set `amount`.
       */
      amountUsdc: string;
    };

export type CheckoutCreateInput = CheckoutAmountInput & {
  title: string;
  description?: string;
  linkType?: "single" | "reusable";
  destinationWallet?: string;
  /**
   * Hosted checkout links settle in USDC during the beta. Omit this field in
   * new integrations; it is kept only to make the invariant explicit in the
   * request type.
   */
  asset?: "USDC";
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
  /** Decimal amount in `asset`, as the server normalized it (e.g. `"5.00"`). */
  amount: string;
  /** @deprecated Same value as {@link CheckoutLink.amount}; see the input field. */
  amountUsdc: string;
  /**
   * The currency `amount` is denominated in. Echoed back on create so a EURC
   * link can be confirmed as one without a second round-trip.
   */
  asset: "USDC" | "EURC";
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
   * True when no funds moved — an attempt created by
   * `checkout.simulatePayment`. Note that such an attempt also has
   * `txHash: null` — but so does a pending real one, which is why this flag
   * exists rather than inferring it.
   *
   * `false` for a real settlement, including on testnet and in provider
   * sandboxes: this is the fabricated-payment axis, not the environment axis.
   *
   * Defaults to `false` against a backend that does not report it.
   */
  simulated: boolean;
};

export type CheckoutSession = CheckoutLink & {
  description: string | null;
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
  GenesisPayConfigError,
  GenesisPayNetworkSafetyError,
  GenesisPayNotFoundError,
  GenesisPayRateLimitError,
  GenesisPayValidationError,
  type GenesisPayValidationIssue,
} from "./errors.js";

/**
 * Production GenesisPay facilitator. Hardcoded so a live key always resolves to
 * our facilitator with zero config, mirroring the test default.
 *
 * This is the custom domain, deliberately, not the Railway-generated hostname.
 * The generated form is derived from the service name, so it breaks the moment
 * the service is renamed — and `peerpay-app-production.up.railway.app`, which
 * this used to point at, never existed at all: production has exactly one
 * domain, `genesispay.finance`. Every zero-config live key resolved to a dead
 * host until this line was fixed. Point it at a domain we own, not at one
 * Railway generates for us.
 */
const PRODUCTION_FACILITATOR_BASE_URL = "https://genesispay.finance";

// Both facilitator URLs are hardcoded so the key mode alone routes to the right
// GenesisPay facilitator; an explicit `baseUrl` still overrides for self-host/staging.
const MODE_BASE_URLS: Record<GenesisPayKeyMode, string> = {
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
  "simulate-payment only works with a test-mode key (gp_sk_test_…); this client " +
  "is using a live key, and live keys can only record real, on-chain payments.";

/** Which networks each key mode may legitimately resolve to (fail-closed guard). */
const MODE_NETWORKS: Record<GenesisPayKeyMode, PaymentGateNetwork[]> = {
  test: ["base-sepolia"],
  live: ["base"],
};

function parseKeyMode(apiKey: string): GenesisPayKeyMode {
  if (apiKey.startsWith("gp_sk_live_")) return "live";
  if (apiKey.startsWith("gp_sk_")) return "test"; // gp_sk_test_… and legacy gp_sk_<32>
  throw new GenesisPayConfigError(
    "apiKey must be a GenesisPay seller key (gp_sk_test_… or gp_sk_live_…).",
  );
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const isHttps = /^https:\/\//i.test(trimmed);
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
  if (!isHttps && !isLocalHttp) {
    throw new GenesisPayConfigError(`baseUrl must be https (got "${trimmed}").`);
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
  amount?: unknown;
  amountUsdc?: unknown;
  asset?: unknown;
  title?: unknown;
  metadata?: unknown;
  clientReferenceId?: unknown;
  returnUrl?: unknown;
  cancelUrl?: unknown;
};

type RawCheckoutSession = RawCheckoutLink & {
  description?: unknown;
  linkType?: unknown;
  status?: unknown;
  destinationWallet?: unknown;
  chainId?: unknown;
  confirmedPaymentCount?: unknown;
  createdAt?: unknown;
  attempts?: unknown;
};

function toCheckoutLink(raw: RawCheckoutLink): CheckoutLink {
  // A backend older than 0.6.0 reports the amount only as `amountUsdc`; both
  // names carry the same decimal string, so either one populates both fields.
  // The check is on "is a string" rather than "is present", so a backend that
  // sends a non-string `amount` still falls back instead of yielding "".
  const amount = requiredString(typeof raw.amount === "string" ? raw.amount : raw.amountUsdc);

  return {
    publicId: requiredString(raw.publicId),
    payUrl: requiredString(raw.payUrl),
    amount,
    amountUsdc: amount,
    asset: oneOf(raw.asset, ["USDC", "EURC"] as const, "USDC"),
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

/**
 * True when two amount strings mean different money. `"5.0"` and `"5.00"` are
 * the same amount, so the comparison is on parsed minor units rather than on
 * the strings; a value the parser cannot read at all is left to the server,
 * which owns amount validation, and only counts as a disagreement if the other
 * string differs from it.
 */
function amountsDisagree(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return false;

  const minorUnits = (value: string): bigint | null => {
    try {
      return parseUsdcAmountToMinorUnits(value);
    } catch {
      return null;
    }
  };

  const [minorA, minorB] = [minorUnits(a), minorUnits(b)];
  if (minorA === null || minorB === null) return true;
  return minorA !== minorB;
}

/**
 * Resolves `amount` and the deprecated `amountUsdc` down to the single value
 * the request carries.
 *
 * The disagreement case is stopped here rather than on the server because a
 * create call that names two different prices has no correct interpretation —
 * picking either one would create a link for money the caller did not mean.
 */
function resolveCheckoutAmount(input: CheckoutCreateInput): string {
  const { amount, amountUsdc } = input;

  if (amount === undefined && amountUsdc === undefined) {
    throw new GenesisPayValidationError(
      'checkout.create requires `amount` — a decimal string in the link\'s asset, e.g. "5.00".',
      [{ path: "amount", message: "amount is required." }],
    );
  }

  if (amount !== undefined && amountUsdc !== undefined && amountsDisagree(amount, amountUsdc)) {
    throw new GenesisPayValidationError(
      `checkout.create got amount "${amount}" and the deprecated amountUsdc "${amountUsdc}", ` +
        "which are different amounts. Set `amount` on its own.",
      [{ path: "amount", message: "amount and amountUsdc disagree." }],
    );
  }

  return (amount ?? amountUsdc) as string;
}

const MAX_REDIRECT_URL_LENGTH = 2_048;

/**
 * Local validation for the two payer-facing redirect fields, mirroring the
 * server's `payerRedirectUrlSchema`. The point of doing it here rather than
 * waiting for a 422 is that a `javascript:`/`data:` value would otherwise be
 * serialised and sent to the API once before anyone notices — and the checkout
 * markup that later renders it as a link is exactly where an unsafe URL hurts.
 * The server stays the authoritative backstop for raw HTTP clients.
 *
 * Trims each field, drops empty-after-trim values (the server stores them as
 * `null`), and rejects anything over 2048 characters or outside the scheme
 * allowlist. A supplied non-string (a JavaScript caller passing `null` or a
 * number past the TypeScript boundary) is reported as a validation issue
 * rather than crashing on `.trim()`. A rejected call throws
 * `GenesisPayValidationError` with one issue per offending field, before any
 * network request.
 */
function validateRedirectFields(input: CheckoutCreateInput): {
  returnUrl?: string;
  cancelUrl?: string;
} {
  const issues: GenesisPayValidationIssue[] = [];

  const normalize = (field: "returnUrl" | "cancelUrl", raw: unknown) => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") {
      issues.push({ path: field, message: `${field} must be a string` });
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > MAX_REDIRECT_URL_LENGTH) {
      issues.push({
        path: field,
        message: `${field} must be ${MAX_REDIRECT_URL_LENGTH} characters or less`,
      });
      return undefined;
    }
    if (!isPayerRedirectUrl(trimmed)) {
      issues.push({
        path: field,
        message: `${field} must be an https URL (http is allowed for localhost only)`,
      });
      return undefined;
    }
    return trimmed;
  };

  const returnUrl = normalize("returnUrl", input.returnUrl);
  const cancelUrl = normalize("cancelUrl", input.cancelUrl);

  if (issues.length > 0) {
    throw new GenesisPayValidationError(
      "checkout.create rejected one or more redirect URLs.",
      issues,
    );
  }

  return { returnUrl, cancelUrl };
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

export class GenesisPay {
  readonly mode: GenesisPayKeyMode;
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
  /** The merchant's catalogue and its canonical payment links — see ./products.ts. */
  readonly products: ProductsResource;
  /** Seller-scoped redirect-entitlement verification. */
  readonly entitlements: EntitlementsResource;
  /** Reusable billing contacts for one-off invoices. */
  readonly customers: CustomersResource;
  /** Draft, finalize, deliver, and collect one-off invoices. */
  readonly invoices: InvoicesResource;
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
    ): Promise<GenesisPayEvent>;
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
  private readonly request: GenesisPayRequest = (options) => this.performRequest(options);

  constructor(options: GenesisPayClientOptions) {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) {
      throw new GenesisPayConfigError("apiKey (gp_sk_test_… / gp_sk_live_…) is required.");
    }
    this.apiKey = apiKey;
    this.mode = parseKeyMode(apiKey);

    const chosen = options.baseUrl?.trim() || MODE_BASE_URLS[this.mode];
    if (!chosen) {
      throw new GenesisPayConfigError(
        `GenesisPay ${this.mode} base URL is not configured yet; pass baseUrl explicitly.`,
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
    // Shares the client's own link mapper so the minted link's shape cannot
    // drift from `checkout.create`'s.
    this.products = createProductsResource(
      this.request,
      (wallet, what) => this.assertPinnedDestination(wallet, what),
      (raw) => toCheckoutLink(raw),
      this.baseUrl,
      (publicId, body) => this.performProductGateRequest(publicId, body),
    );
    this.entitlements = createEntitlementsResource(this.request);
    this.mandates = createMandatesResource(this.request);
    this.customers = createCustomersResource(this.request);
    this.invoices = createInvoicesResource(this.request);

    // Stateless pass-through: verification depends only on the endpoint secret,
    // never on this client's key, mode or base URL.
    this.webhooks = {
      constructEvent: (rawBody, signatureHeader, secret, opts) =>
        constructEvent(rawBody, signatureHeader, secret, opts),
    };
  }

  /** Raw on purpose: product-gate negotiation must preserve 402 protocol headers. */
  private async performProductGateRequest(
    publicId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}/api/v1/products/${encodeURIComponent(publicId)}/x402`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
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
    const defaultSettle = genesisPaySettlement({
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
      throw new GenesisPayConfigError(
        `Failed to reach GenesisPay to resolve the seller: ${describeError(error)}`,
      );
    }
    if (!response.ok) {
      // 401/403/500 land on GenesisPayConfigError with the key/base-URL hint; a
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
      throw new GenesisPayNetworkSafetyError(
        `Key mode "${this.mode}" does not match the server-resolved mode "${config.mode}".`,
      );
    }

    // (2) Mode↔network: a live key must never resolve to a testnet, and vice
    // versa. Checked before the asset table so an unknown/foreign network name
    // surfaces as a typed safety error instead of a generic lookup throw.
    if (!MODE_NETWORKS[this.mode].includes(net.networkName)) {
      throw new GenesisPayNetworkSafetyError(
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
      throw new GenesisPayNetworkSafetyError(
        `Backend network is inconsistent for "${net.networkName}" (chainId ${net.chainId}, usdc ${net.usdcAddress}).`,
      );
    }

    // (4) Optional local pin on the payout wallet.
    if (this.expectedPayTo && config.payTo && config.payTo.toLowerCase() !== this.expectedPayTo) {
      throw new GenesisPayNetworkSafetyError(
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
    if (typeof wallet !== "string" || !wallet) {
      // Fail CLOSED. A response that omits the destination is exactly the
      // response the pin cannot vouch for — an intermediary that strips the
      // field must not read as "matches". Silently returning here made the
      // guarantee bypassable by omission.
      throw new GenesisPayNetworkSafetyError(
        `The ${what} response carried no destinationWallet to check against expectedPayTo.`,
      );
    }
    if (wallet.toLowerCase() !== this.expectedPayTo) {
      throw new GenesisPayNetworkSafetyError(
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
  private async performRequest(options: GenesisPayRequestOptions): Promise<unknown> {
    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${options.path}`, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new GenesisPayConfigError(
        `Failed to reach GenesisPay to ${options.action}: ${describeError(error)}`,
      );
    }

    if (!response.ok) {
      // Shared mapping: 422 → GenesisPayValidationError (with the field issues),
      // 429 → GenesisPayRateLimitError (with Retry-After), 404 → NotFound, rest → Config.
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
    const amount = resolveCheckoutAmount(input);
    const { returnUrl, cancelUrl } = validateRedirectFields(input);

    const body = await this.request({
      method: "POST",
      path: "/api/v1/links",
      operation: "POST /api/v1/links",
      action: "create a checkout link",
      body: {
        title: input.title,
        description: input.description,
        amount,
        // Both names, one value: a backend older than 0.6.0 only knows
        // `amountUsdc`, and a newer one accepts the pair precisely because they
        // agree. Nothing here can disagree — it is the same string twice.
        amountUsdc: amount,
        linkType: input.linkType ?? "single",
        ...(input.destinationWallet ? { destinationWallet: input.destinationWallet } : {}),
        ...(input.asset ? { asset: input.asset } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.clientReferenceId ? { clientReferenceId: input.clientReferenceId } : {}),
        ...(returnUrl ? { returnUrl } : {}),
        ...(cancelUrl ? { cancelUrl } : {}),
      },
    });

    const link = asRecord(body)?.link as RawCheckoutLink | undefined;
    if (!link || typeof link.payUrl !== "string" || !link.payUrl) {
      throw new GenesisPayConfigError(
        `GenesisPay link created but no payUrl in response: ${JSON.stringify(body)}`,
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
   * an unknown publicId raises `GenesisPayNotFoundError`, never a config error.
   */
  private async retrieveCheckout(publicId: string): Promise<CheckoutSession> {
    const id = publicId?.trim();
    if (!id) {
      throw new GenesisPayConfigError(
        "checkout.retrieve(publicId) requires the publicId returned by checkout.create().",
      );
    }

    const body = await this.request({
      path: `/api/v1/links/${encodeURIComponent(id)}`,
      operation: `GET /api/v1/links/${id}`,
      action: `retrieve checkout "${id}"`,
      notFoundMessage: `No GenesisPay checkout with publicId "${id}". Check the id and that it belongs to the account this API key authenticates.`,
    });

    const link = asRecord(body)?.link as RawCheckoutSession | undefined;
    if (!link || typeof link.publicId !== "string" || !link.publicId) {
      throw new GenesisPayConfigError(
        `GenesisPay returned no link for publicId "${id}": ${JSON.stringify(body)}`,
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
      throw new GenesisPayConfigError(
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
        `GenesisPay simulate-payment returned 404 for checkout "${id}". Either no such ` +
        `checkout exists for the account this API key authenticates, or this GenesisPay ` +
        `deployment runs on mainnet, where the endpoint does not exist at all. ` +
        `Check the publicId first, then the deployment's network.`,
      hint: (status) =>
        status === 403 ? SIMULATE_PAYMENT_LIVE_KEY_HINT : undefined,
    });

    const record = asRecord(body);
    const link = record?.link as RawCheckoutSession | undefined;
    if (!link || typeof link.publicId !== "string" || !link.publicId) {
      throw new GenesisPayConfigError(
        `GenesisPay simulated a payment on "${id}" but returned no link: ${JSON.stringify(body)}`,
      );
    }

    // The attempt is not an optional detail here the way an unknown field would
    // be: without it the merged session would report `paid: false` right after
    // a payment was minted. A 201 that omits it is a broken contract, not an
    // older backend — the endpoint and the field shipped together.
    const [attempt] = toCheckoutAttempts([record?.attempt]);
    if (!attempt) {
      throw new GenesisPayConfigError(
        `GenesisPay simulated a payment on "${id}" but returned no attempt: ${JSON.stringify(body)}`,
      );
    }
    return toSimulatedCheckoutSession(link, attempt);
  }
}
