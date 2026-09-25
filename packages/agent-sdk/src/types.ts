/**
 * `(string & {})` keeps every known status autocompleting while still accepting
 * one this SDK version predates — the server may add a status, and an old client
 * must degrade rather than fail to read the payment at all.
 */
export type AgentPaymentStatus =
  | "pending_approval"
  | "approved"
  | "denied"
  | "executing"
  | "settled"
  | "failed"
  | "expired"
  /** The authorization was delivered; whether it settled is not yet known. */
  | "unresolved"
  | (string & {});

/** An agent payment record as returned by the GenesisPay Agent API. */
export type AgentPaymentRecord = {
  id: string;
  agentAccountId: string;
  resourceUrl: string;
  description: string | null;
  destinationWallet: string;
  /**
   * Asset the payment settles in. Absent on older GenesisPay servers (USDC).
   * Open like `status`, so a settlement asset added later still parses.
   */
  asset?: "USDC" | "EURC" | (string & {});
  /** Minor units (6 decimals) as a decimal string; denominated in `asset`. */
  amountUsdcMinor: string;
  /** GenesisPay fee in minor units of `asset`, recorded for billing/receipts. */
  feeUsdcMinor: string;
  chainId: number;
  status: AgentPaymentStatus;
  txHash: string | null;
  failureReason: string | null;
  approvalExpiresAt: string | null;
  /**
   * When an `unresolved` authorization stops being settleable. Until this
   * passes, the payment may still be charged — re-attempt the purchase only
   * with the same `idempotencyKey`.
   */
  authorizationValidBefore?: string | null;
  resolvedAt: string | null;
  settledAt: string | null;
  createdAt: string;
};

/** Captured HTTP response from the paid resource after settlement. */
export type AgentHttpResponseCapture = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  mimeType: string;
};

export type AgentSpendingPolicy = {
  perPaymentCapUsdcMinor: string | null;
  dailyCapUsdcMinor: string | null;
  monthlyCapUsdcMinor: string | null;
  allowlistEnabled: boolean;
};

/** Agent account snapshot from GET /api/v1/agent/account. */
export type AgentAccountInfo = {
  name: string;
  walletAddress: string;
  chainId: number;
  status: "active" | "paused" | (string & {});
  /** USDC minor units as a decimal string; null when the balance read failed. */
  usdcBalance: string | null;
  policy: AgentSpendingPolicy;
  spentTodayUsdcMinor: string;
  spentThisMonthUsdcMinor: string;
};

/** The HTTP method a purchase is made with. */
export type PurchaseMethod = "GET" | "POST";

/** The only content type a POST purchase body may carry. */
export type PurchaseContentType = "application/json";

/** The shop a discovery listing belongs to, when the listing names one. */
export type DiscoveredShopRef = {
  id: string;
  name: string;
  /** The shop's human storefront, or null when it has none. Not a payable URL. */
  storefrontUrl: string | null;
};

/** A service found via the public GenesisPay discovery endpoint. */
export type DiscoveredService = {
  /** Stable listing id. Absent on older GenesisPay servers. */
  id?: string;
  title: string;
  description: string | null;
  /**
   * Decimal amount, e.g. "0.10" — the advertised price. The resource's own
   * 402 challenge stays the price authority. For a listing whose `asset` is
   * USDC or absent, pass it to `pay()` as `maxAmountUsdc` so a challenge above
   * the listing is refused. The ceiling guards USDC payments only: the server
   * applies it when the payment asset equals the asset filter, and this SDK
   * can only select USDC — do not buy a listing in another asset with it.
   */
  priceUsdc: string;
  /** "api" = external x402 endpoint, "link" = GenesisPay payment link. */
  kind: "api" | "link" | (string & {});
  /** The x402-payable URL — pass it to `agent.pay()`. */
  resourceUrl: string;
  category: string | null;
  /**
   * How the resource is bought. `"POST"` means pass `method: "POST"` and the
   * exact JSON `body` the API expects. Absent on older servers (buy with GET).
   */
  method?: PurchaseMethod | (string & {});
  /** Settlement asset of the advertised price. Absent on older servers. */
  asset?: "USDC" | "EURC" | (string & {});
  /** The shop the listing belongs to; null or absent when it names none. */
  shop?: DiscoveredShopRef | null;
};

/** A shop found via `GET /api/v1/discovery/shops`. */
export type DiscoveredShop = {
  id: string;
  name: string;
  description: string | null;
  /** The shop's human storefront, or null when it has none. Not a payable URL. */
  storefrontUrl: string | null;
  category: string | null;
  /** Number of listed products; null when the server does not report it. */
  productCount: number | null;
};

export type ShopsOptions = {
  /** Max results (the server's default and maximum apply). */
  limit?: number;
};

/**
 * A product from `GET /api/v1/discovery/trending`: listed GenesisPay products
 * ranked by distinct buyers of paid orders in the last 7 days (coarse bands),
 * newest listed after them.
 */
export type TrendingProduct = {
  /** 1-based position in the response. */
  rank: number;
  /** `prod_…` */
  id: string;
  title: string;
  description: string | null;
  /** Settlement asset of the advertised price. */
  asset: "USDC" | "EURC" | (string & {});
  /** Integer minor units of `asset` as a decimal-integer string, e.g. "12500000". */
  priceMinor: string;
  /**
   * Decimal amount of `asset`, e.g. "12.5" — the advertised price; the
   * resource's own 402 stays the price authority. For a USDC product pass it to
   * `pay()` as `maxAmountUsdc`; the ceiling guards USDC payments only.
   */
  priceUsdc: string;
  /** How the resource is bought (see `DiscoveredService.method`). */
  method: PurchaseMethod | (string & {});
  /** The x402-payable URL — pass it to `agent.pay()`. */
  resourceUrl: string;
  category: string | null;
  shop: DiscoveredShopRef | null;
  /**
   * Which basis ranked it: `"sales"` (enough recent distinct buyers) or `"new"`
   * (too little signal, ranked by listing date). The count is never exposed.
   */
  signal: "sales" | "new" | (string & {});
};

export type TrendingOptions = {
  /** Max results (server default 10, max 20). */
  limit?: number;
};

export type DiscoverOptions = {
  /** Filter by category substring, e.g. "flights". */
  category?: string;
  /** Max results (server default 20, max 50). */
  limit?: number;
};

export type WaitForApprovalOptions = {
  /**
   * How long to wait for a human decision. Default: 15 minutes.
   *
   * The client never sleeps past the deadline, so the last poll is skipped:
   * `{ timeoutMs: 30_000, pollIntervalMs: 5_000 }` polls five times and gives
   * up at ~25 s, not six times at 30 s.
   */
  timeoutMs?: number;
  /** Delay between status polls. Default: 5 seconds. */
  pollIntervalMs?: number;
};

/**
 * Bounded wait for the outcome of a payment the server accepted but has not
 * confirmed yet (`unresolved`, `approved`, `executing`).
 *
 * The client only READS `paymentStatus()` while it waits — it never executes,
 * signs or re-sends anything. When the budget runs out it throws
 * `GenesisPayOutcomeWaitTimeoutError`, a `GenesisPayPaymentOutcomeUnknownError`:
 * the payment may already have been charged, so keep polling it and never buy
 * again with a new key.
 */
export type WaitForOutcomeOptions = {
  /** Total wait budget after the pay response. Default: 30 seconds. */
  timeoutMs?: number;
  /**
   * First delay between status polls. Default: 2 seconds. Each further delay
   * doubles, up to 10 seconds; the last poll lands on the deadline.
   */
  pollIntervalMs?: number;
};

/**
 * Settlement asset for an agent payment. **USDC on Base only in v1.**
 *
 * The account snapshot this SDK returns is USDC-specific — `usdcBalance` reads
 * the USDC balance and `policy` is the USDC policy row — so an option to pay in
 * another asset would let a caller check one budget and spend from another, then
 * be refused at signing with nothing in the response explaining why. Widening
 * this later is additive; shipping it wrong is not.
 */
export type PaymentAsset = "USDC";

export type PayOptions = {
  /**
   * Refuse to pay more than this decimal USDC amount, e.g. "0.50".
   * Legacy alias of `maxAmount` — prefer `maxAmount` (with `asset`) in new code.
   *
   * A decimal STRING, never a number: `0.1 + 0.2` stringifies to
   * "0.30000000000000004", which the server rejects as more than 6 decimals —
   * and a money API that accepts binary floats invites exactly that (guardrail
   * 4). Format it yourself and you keep control of the rounding.
   */
  maxAmountUsdc?: string;
  /**
   * Refuse to pay more than this decimal amount of `asset` (USDC when no
   * `asset` is given), e.g. "0.50". Must agree with `maxAmountUsdc` when both are set.
   */
  maxAmount?: string;
  /**
   * This client exposes USDC asset selection and account balances.
   * Omission preserves the server's default selection; it differs from an explicit filter.
   */
  asset?: PaymentAsset;
  /** Free-text note stored with the payment. */
  description?: string;
  /**
   * Identifies this purchase so retrying it is safe.
   *
   * When a call fails without saying whether the payment went through — a
   * timeout, a dropped connection, a 500 from the resource — retrying without a
   * key can create a second purchase on legacy APIs. This client requires a
   * saved key: exact retries recover the original payment without signing or
   * fetching its resource again.
   *
   * Use anything stable that identifies the purchase (an order id, a hash of
   * the request). Persist the key with the purchase BEFORE calling pay.
   * Exact retries return the original payment outcome; changed terms conflict.
   */
  idempotencyKey: string;
  /**
   * When set, transparently poll a pending approval and execute the payment
   * once it is approved. Pass `true` for defaults or tune the polling.
   */
  waitForApproval?: boolean | WaitForApprovalOptions;
  /**
   * HTTP method of the purchase. Default `"GET"`. Use `"POST"` with `body` for
   * an API whose price or admission depends on the request body.
   */
  method?: PurchaseMethod;
  /**
   * The exact JSON text to send as the POST body (`method: "POST"` only), at
   * most 256 KiB of UTF-8. It is sent byte-for-byte and never re-serialized,
   * and it is part of the purchase identity: every retry with the same
   * `idempotencyKey` must pass the identical string — a reformatted body is a
   * different purchase and ends in `idempotency_conflict`. Serialize it once
   * and save it with the key. Do not put secrets or personal data in it; it is
   * stored with the payment.
   */
  body?: string;
  /** Content type of `body` (`method: "POST"` only). Default and only value: `"application/json"`. */
  contentType?: PurchaseContentType;
  /**
   * Wait, bounded, for a payment the server accepted but has not confirmed —
   * `unresolved`, `approved` or `executing` — instead of throwing at once.
   * Default off. Pass `true` for defaults or tune the wait. Only reads
   * `paymentStatus()`; see `WaitForOutcomeOptions`.
   */
  waitForOutcome?: boolean | WaitForOutcomeOptions;
};
