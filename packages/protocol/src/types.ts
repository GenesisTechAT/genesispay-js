export type HexString = `0x${string}`;

export type EvmAddress = `0x${string}`;

/**
 * EIP-712 domain `name`/`version` of the settlement asset contract, carried
 * in the x402 `extra` field so clients sign with the exact domain the
 * contract's `DOMAIN_SEPARATOR()` uses (e.g. Base mainnet USDC is
 * "USD Coin", EURC is "EURC").
 */
export type PaymentAcceptExtra = {
  name: string;
  version: string;
};

/**
 * The optional role-tagged fee block on an `accepts` entry (fee-collection
 * brief §2, Phase 2/3). A resource that collects the platform fee on-chain
 * advertises it here: a SECOND payer-signed EIP-3009 transfer, `feeMinor` →
 * `treasury`, alongside the seller leg.
 *
 * **`maxAmountRequired` stays GROSS.** This block says how to SPLIT the price,
 * not that the price changed: a capable client signs `maxAmountRequired −
 * feeMinor` to `payTo` plus `feeMinor` to `treasury`, and a client that ignores
 * the block signs `maxAmountRequired` to `payTo` — the same total either way.
 * That is what makes the fallback safe to keep forever: ignoring an optional
 * field cannot underpay the seller, so there is nothing to gain by ignoring it.
 * Amounts are decimal integer strings in the asset's minor units, JSON-safe and
 * lossless.
 */
export type PaymentFee = {
  /** Fee in minor units of the accept's `asset`, as a decimal integer string. */
  feeMinor: string;
  /** Where the fee leg must pay — the platform fee treasury (snapshotted). */
  treasury: EvmAddress;
  /** The fee-leg asset contract (same token as the seller leg). */
  assetAddress: EvmAddress;
  chainId: number;
};

/**
 * The catalogue entry a 402 resource sells, when it sells one. Additive and
 * advisory: the money fields (`amount`, `maxAmountRequired`, `asset`) are the
 * authority with or without it, and `quantity` is fixed at 1 — a 402 carries
 * exactly one price for exactly one thing. Absent on every non-product link.
 */
export type PaymentProduct = {
  /** The seller's stable product ID (`prod_…`) — what an agent reorders by. */
  productId: string;
  /** The seller's own SKU, when they set one. */
  sku: string | null;
  quantity: 1;
};

/**
 * One entry of the `accepts` array in an x402 V2 PAYMENT-REQUIRED payload.
 */
export type PaymentAccept = {
  scheme: "exact";
  network: string;
  chainId: number;
  asset: string;
  assetAddress: EvmAddress;
  /** Human-readable decimal USDC amount, e.g. "0.005". */
  amount: string;
  /** USDC minor-unit amount as a decimal integer string, e.g. "5000". */
  maxAmountRequired: string;
  destination: EvmAddress;
  payTo: EvmAddress;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the asset contract (x402 spec `extra`). */
  extra?: PaymentAcceptExtra;
  /**
   * The optional fee leg (fee-collection Phase 2/3). Present when the resource
   * collects the platform fee on-chain via a second payer-signed authorization;
   * absent on a single-auth (record-only) resource. `maxAmountRequired` remains
   * the GROSS price with or without it — the seller leg is
   * `maxAmountRequired − fee.feeMinor`. See `PaymentFee`.
   */
  fee?: PaymentFee;
  /**
   * The product this resource sells (additive, advisory — see `PaymentProduct`).
   * Old clients that drop unknown keys lose nothing but the catalogue hint.
   */
  product?: PaymentProduct;
};

/**
 * The x402 V2 PAYMENT-REQUIRED payload (response body + base64 header).
 */
export type PaymentRequiredPayload = {
  x402Version: 2;
  linkId?: string;
  accepts: [PaymentAccept, ...PaymentAccept[]];
  description: string;
  error: string;
};

export type BuildPaymentRequiredInput = {
  linkId?: string;
  /** Human-readable decimal USDC amount, e.g. "0.005". */
  amount: string;
  /** USDC minor-unit amount (6 decimals). */
  amountUsdcMinor: bigint | string;
  asset: "USDC";
  assetAddress: EvmAddress;
  chainId: number;
  network: string;
  destination: EvmAddress;
  description: string;
  resource: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  /** EIP-712 domain of the asset contract, advertised as x402 `extra`. */
  extra?: PaymentAcceptExtra;
  /** The optional on-chain fee leg (fee-collection Phase 2/3), advertised additively. */
  fee?: PaymentFee;
  /**
   * The product this resource sells (additive, advisory — see `PaymentProduct`).
   * Old clients that drop unknown keys lose nothing but the catalogue hint.
   */
  product?: PaymentProduct;
};

/**
 * EIP-3009 TransferWithAuthorization message fields. Numeric fields are
 * decimal integer strings so payloads stay JSON-safe and lossless.
 */
export type TransferAuthorization = {
  from: EvmAddress;
  to: EvmAddress;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: HexString;
};

export type PaymentSignatureAccepted = {
  scheme: "exact";
  network: string;
  amount: string;
  chainId?: number;
  asset?: string;
  assetAddress?: EvmAddress;
  payTo?: EvmAddress;
  destination?: EvmAddress;
  maxTimeoutSeconds?: number;
};

/**
 * The x402 V2 PAYMENT-SIGNATURE payload an agent submits to pay.
 */
export type PaymentSignaturePayload = {
  x402Version: 2;
  resource?: {
    url?: string;
    description?: string;
    mimeType?: string;
  };
  accepted: PaymentSignatureAccepted;
  payload: {
    signature: HexString;
    authorization: TransferAuthorization;
    /**
     * The optional SECOND authorization slot (fee-collection Phase 2/3): the
     * payer-signed fee-leg EIP-3009 transfer (fee → treasury) paired with its
     * signature. Present only when paying a fee-collecting resource dual-auth;
     * absent for single-auth payments (which the server accepts indefinitely,
     * fee recorded-only). Old clients never populate it; old servers ignore it.
     */
    feeAuthorization?: TransferAuthorization;
    feeSignature?: HexString;
  };
  extensions?: Record<string, unknown>;
};

/**
 * The x402 V2 settlement response payload (response body + PAYMENT-RESPONSE header).
 */
export type SettlementResponsePayload = {
  success: boolean;
  transaction: string;
  network: string;
  amount?: string;
  payer?: EvmAddress;
  paymentAttemptId?: string;
  errorReason?: string;
  extensions?: Record<string, unknown>;
};
