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
