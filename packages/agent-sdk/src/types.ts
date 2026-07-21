export type AgentPaymentStatus =
  | "pending_approval"
  | "approved"
  | "denied"
  | "executing"
  | "settled"
  | "failed"
  | "expired";

/** An agent payment record as returned by the PeerPay Agent API. */
export type AgentPaymentRecord = {
  id: string;
  agentAccountId: string;
  resourceUrl: string;
  description: string | null;
  destinationWallet: string;
  /** Asset the payment settles in. Absent on older PeerPay servers (USDC). */
  asset?: "USDC" | "EURC";
  /** Minor units (6 decimals) as a decimal string; denominated in `asset`. */
  amountUsdcMinor: string;
  /** PeerPay fee in minor units of `asset`, recorded for billing/receipts. */
  feeUsdcMinor: string;
  chainId: number;
  status: AgentPaymentStatus;
  txHash: string | null;
  failureReason: string | null;
  approvalExpiresAt: string | null;
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
  status: "active" | "paused";
  /** USDC minor units as a decimal string; null when the balance read failed. */
  usdcBalance: string | null;
  policy: AgentSpendingPolicy;
  spentTodayUsdcMinor: string;
  spentThisMonthUsdcMinor: string;
};

/** A service found via the public PeerPay discovery endpoint. */
export type DiscoveredService = {
  title: string;
  description: string | null;
  /** Decimal USDC amount, e.g. "0.10". */
  priceUsdc: string;
  /** "api" = external x402 endpoint, "link" = PeerPay payment link. */
  kind: "api" | "link";
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
  /** How long to wait for a human decision. Default: 15 minutes. */
  timeoutMs?: number;
  /** Delay between status polls. Default: 5 seconds. */
  pollIntervalMs?: number;
};

/** Settlement asset symbols supported by the PeerPay Agent API. */
export type PaymentAsset = "USDC" | "EURC";

export type PayOptions = {
  /**
   * Refuse to pay more than this decimal USDC amount, e.g. "0.50".
   * Legacy alias of `maxAmount` — prefer `maxAmount` (with `asset`) in new code.
   */
  maxAmountUsdc?: string | number;
  /**
   * Refuse to pay more than this decimal amount of `asset` (USDC when no
   * `asset` is given), e.g. "0.50". Wins over `maxAmountUsdc` when both are set.
   */
  maxAmount?: string | number;
  /**
   * Restrict the payment to this settlement asset. Without it the server
   * keeps its historical behavior: any supported asset, preferring USDC.
   */
  asset?: PaymentAsset;
  /** Free-text note stored with the payment. */
  description?: string;
  /**
   * When set, transparently poll a pending approval and execute the payment
   * once it is approved. Pass `true` for defaults or tune the polling.
   */
  waitForApproval?: boolean | WaitForApprovalOptions;
};
