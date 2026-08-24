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

/** A service found via the public GenesisPay discovery endpoint. */
export type DiscoveredService = {
  title: string;
  description: string | null;
  /** Decimal USDC amount, e.g. "0.10". */
  priceUsdc: string;
  /** "api" = external x402 endpoint, "link" = GenesisPay payment link. */
  kind: "api" | "link" | (string & {});
  /** The x402-payable URL — pass it to `agent.pay()`. */
  resourceUrl: string;
  category: string | null;
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

/** Settlement asset symbols supported by the GenesisPay Agent API. */
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
   * `asset` is given), e.g. "0.50". Wins over `maxAmountUsdc` when both are set.
   */
  maxAmount?: string;
  /**
   * Settlement asset. USDC on Base is the only one agent payments support in
   * v1, so this can be omitted.
   */
  asset?: PaymentAsset;
  /** Free-text note stored with the payment. */
  description?: string;
  /**
   * Identifies this purchase so retrying it is safe.
   *
   * When a call fails without saying whether the payment went through — a
   * timeout, a dropped connection, a 500 from the resource — retrying without a
   * key signs a brand-new authorization, and the network cannot tell it apart
   * from a second purchase. With a key, the retry re-presents the *same*
   * authorization and the token contract itself refuses the duplicate.
   *
   * Use anything stable that identifies the purchase (an order id, a hash of
   * the request). A second call with the same key returns
   * `GenesisPayDuplicatePaymentError` carrying the original payment id.
   */
  idempotencyKey?: string;
  /**
   * When set, transparently poll a pending approval and execute the payment
   * once it is approved. Pass `true` for defaults or tune the polling.
   */
  waitForApproval?: boolean | WaitForApprovalOptions;
};
