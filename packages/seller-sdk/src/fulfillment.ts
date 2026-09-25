// This intentionally stays one authority-boundary module even though it is
// large: the public contract, request serializer, strict wire parser, registry
// cross-check, and expected-contract comparator must evolve atomically. Splitting
// those pieces across tolerant resource helpers would make it possible to parse
// evidence under one rule set and authorize it under another; the repetition
// here is the audit trail for every field that can release fulfilment.

import {
  GenesisPayAmbiguousLocatorError,
  GenesisPayConfigError,
  GenesisPayContractMismatchError,
  GenesisPayEvidenceError,
  GenesisPayRateLimitError,
  GenesisPayValidationError,
  GenesisPayVersionError,
  type GenesisPayResponseMetadata,
  type GenesisPayValidationIssue,
} from "./errors.js";
import {
  GENESISPAY_ASSET_DEPLOYMENTS,
  type GenesisPayAssetDeployment,
} from "@genesis-tech/genesispay-protocol";
import { createFulfillmentAttemptsLister, type FulfillmentAttemptList, type FulfillmentAttemptsQuery } from "./fulfillment-attempts.js";

export const GENESISPAY_API_VERSION = "2026-08-26" as const;
export const GENESISPAY_VERSION_HEADER = "GENESISPAY-Version" as const;
export const GENESISPAY_REQUEST_ID_HEADER = "GENESISPAY-Request-Id" as const;
export const GENESISPAY_PAYMENT_ATTEMPT_ID_HEADER =
  "GENESISPAY-Payment-Attempt-Id" as const;

export type ApiVersion = typeof GENESISPAY_API_VERSION;
export type DeploymentMode = "test" | "live";
export type SupportedAsset = "USDC" | "EURC";
export type PaymentChannel = "checkout" | "x402" | "bank_transfer";
export type DeliveryType = "none" | "url" | "gate";
export type SettlementStrategy = "dual" | "atomic";

type EvmAddress = `0x${string}`;

export interface NetworkContract {
  mode: DeploymentMode;
  network: "base";
  chainId: 8453 | 84532;
  asset: SupportedAsset;
  tokenAddress: EvmAddress;
  minorUnitScale: 6;
}

export interface ExpectedDeliveryContract {
  type: DeliveryType;
  url: string | null;
  gate:
    | null
    | {
        method: string;
        resourceUrl: string;
        fingerprint: string;
      };
}

export interface ExpectedProductContract {
  kind: "product";
  productId: string;
  sku: string | null;
  grossAmountMinor: bigint;
  network: NetworkContract;
  settlementDestination: EvmAddress;
  delivery: ExpectedDeliveryContract;
}

export interface ExpectedPaymentLinkContract {
  kind: "payment_link";
  linkId: string;
  grossAmountMinor: bigint;
  network: NetworkContract;
  settlementDestination: EvmAddress;
}

export type ExpectedFulfillmentContract =
  | ExpectedProductContract
  | ExpectedPaymentLinkContract;

export type FulfillmentLocator =
  | { attemptId: string; linkId?: never; entitlementId?: never }
  | { linkId: string; attemptId?: never; entitlementId?: never }
  | { entitlementId: string; attemptId?: never; linkId?: never };

/**
 * The fee agreement frozen onto the payment. `record_only` means the payer
 * never signed a fee leg and the seller leg moved the full gross;
 * `payer_authorized` means they did, and the seller leg moved gross − amount.
 */
export interface FeeTerms {
  type: "record_only" | "payer_authorized";
  amountMinor: bigint;
  treasuryAddress: EvmAddress | null;
}

export type FeeCollectionStatus =
  | "not_recorded"
  | "recorded"
  | "pending"
  | "collecting"
  | "collected"
  | "failed"
  | "written_off";

/**
 * The fee leg's own outcome, which is separate from — and usually later than —
 * the seller leg's. Only `collected` with a transaction hash means the platform
 * fee actually moved; every other status means the seller was paid and the fee
 * was not (yet) taken. Never derive it from `feeTerms`.
 */
export interface FeeCollection {
  status: FeeCollectionStatus;
  amountMinor: bigint | null;
  treasuryAddress: EvmAddress | null;
  transactionHash: EvmAddress | null;
  collectedAt: string | null;
}

/**
 * Current delivery capability for a minted entitlement — never payment
 * authority. A confirmed payment stays confirmed; `valid` goes false when the
 * entitlement expires or an operator revokes it for fraud. Gate DELIVERY on
 * this; gate refunds and reconciliation on the payment.
 */
export interface EntitlementState {
  expiresAt: string;
  revokedAt: string | null;
  valid: boolean;
}

export interface VerifiedPayment {
  attemptId: string;
  linkId: string;
  entitlementId: string | null;
  entitlement: EntitlementState | null;
  paymentChannel: PaymentChannel;
  confirmedAt: string;
  transactionHash: EvmAddress;
  grossAmountMinor: bigint;
  /** What the seller leg moved: gross minus the AUTHORIZED fee, not a collected one. */
  sellerAmountMinor: bigint;
  feeTerms: FeeTerms;
  feeCollection: FeeCollection;
  settlementDestination: EvmAddress;
  network: NetworkContract;
  product:
    | null
    | {
        productId: string;
        sku: string | null;
        delivery: ExpectedDeliveryContract;
      };
}

export type FulfillmentVerification =
  | {
      verified: true;
      requestId: string;
      apiVersion: ApiVersion;
      payment: VerifiedPayment;
    }
  | {
      verified: false;
      reason: "not_found" | "not_confirmed" | "simulated" | "entitlement_invalid";
      requestId: string;
      apiVersion: ApiVersion;
    };

export interface FulfillmentResource {
  /** Seller-scoped recovery candidates, never a verified payment verdict. */
  listAttempts(input?: FulfillmentAttemptsQuery): Promise<FulfillmentAttemptList>;
  /**
   * Retrieves seller-scoped evidence and verifies it against `expected`.
   * No overload accepts an evidence object: authority always comes from the
   * authenticated GenesisPay response.
   */
  verify(input: {
    locator: FulfillmentLocator;
    expected: ExpectedFulfillmentContract;
  }): Promise<FulfillmentVerification>;
}

type CreateFulfillmentResourceOptions = {
  baseUrl: string;
  apiKey: string;
  fetchFn: typeof fetch;
  assertPinnedDestination(wallet: unknown, what: string): void;
};

type ParsedEvidence = VerifiedPayment & {
  sellerId: string;
  settlementStrategy: SettlementStrategy;
};

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const PRODUCT_PRICE_MINOR_MAX = 1_000_000_000_000n;
const CANONICAL_MONEY_PATTERN = /^(0|[1-9][0-9]*)$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const ASSET_REGISTRY: Readonly<
  Record<DeploymentMode, Readonly<Record<SupportedAsset, NetworkContract>>>
> = {
  live: {
    USDC: toNetworkContract(GENESISPAY_ASSET_DEPLOYMENTS.live.USDC),
    EURC: toNetworkContract(GENESISPAY_ASSET_DEPLOYMENTS.live.EURC),
  },
  test: {
    USDC: toNetworkContract(GENESISPAY_ASSET_DEPLOYMENTS.test.USDC),
    EURC: toNetworkContract(GENESISPAY_ASSET_DEPLOYMENTS.test.EURC),
  },
};

function toNetworkContract(deployment: GenesisPayAssetDeployment): NetworkContract {
  return {
    mode: deployment.mode,
    network: deployment.network,
    chainId: deployment.chainId,
    asset: deployment.asset,
    tokenAddress: deployment.tokenAddress,
    minorUnitScale: deployment.minorUnitScale,
  };
}

export function createFulfillmentResource(
  options: CreateFulfillmentResourceOptions,
): FulfillmentResource {
  return {
    listAttempts: createFulfillmentAttemptsLister(options),
    async verify(input): Promise<FulfillmentVerification> {
      const locator = validateLocator(input?.locator);
      const expected = validateExpectedContract(input?.expected);
      // The immutable expected contract and client pin must agree. Historical
      // payments remain readable with a client pinned to their original wallet;
      // an expected contract cannot silently override local policy (MR-102/202).
      options.assertPinnedDestination(expected.settlementDestination, "fulfillment contract");

      let response: Response;
      try {
        response = await options.fetchFn(`${options.baseUrl}/api/v1/fulfillment/verify`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION,
          },
          body: JSON.stringify({ locator, expected: toWireExpectedContract(expected) }),
          cache: "no-store",
        });
      } catch (error) {
        throw new GenesisPayConfigError(
          `Failed to reach GenesisPay to verify fulfilment: ${describeError(error)}`,
        );
      }

      const rawBody = await readJsonBody(response);
      if (!response.ok) {
        throwFulfillmentHttpError(response, rawBody);
      }

      const root = requireRecord(rawBody, "response", metadataFromResponse(response, rawBody));
      const metadata = requireResponseMetadata(response, root);
      requireExact(root.object, "fulfillment_verification", "object", metadata);

      if (root.verified === false) {
        return {
          verified: false,
          reason: requireOneOf(
            root.reason,
            ["not_found", "not_confirmed", "simulated", "entitlement_invalid"] as const,
            "reason",
            metadata,
          ),
          requestId: metadata.requestId as string,
          apiVersion: GENESISPAY_API_VERSION,
        };
      }

      if (root.verified !== true) {
        malformed("verified must be the boolean true or false", metadata);
      }

      const evidence = parseEvidence(root.evidence, metadata);
      const mismatches = compareEvidence(evidence, expected, locator);
      if (mismatches.length > 0) {
        throw new GenesisPayContractMismatchError(
          `GenesisPay payment evidence does not match the expected contract (${mismatches.join(", ")}).`,
          mismatches,
          metadata,
        );
      }
      // Entitlement locators authorize delivery, whereas attempt/link locators
      // prove immutable payment history even after delivery expires or is revoked.
      if (locator.entitlementId !== undefined && evidence.entitlement?.valid !== true) {
        inconsistent("a verified entitlement lookup must carry valid delivery authority", metadata);
      }

      const payment: VerifiedPayment = {
        attemptId: evidence.attemptId,
        linkId: evidence.linkId,
        entitlementId: evidence.entitlementId,
        entitlement: evidence.entitlement,
        paymentChannel: evidence.paymentChannel,
        confirmedAt: evidence.confirmedAt,
        transactionHash: evidence.transactionHash,
        grossAmountMinor: evidence.grossAmountMinor,
        sellerAmountMinor: evidence.sellerAmountMinor,
        feeTerms: evidence.feeTerms,
        feeCollection: evidence.feeCollection,
        settlementDestination: evidence.settlementDestination,
        network: evidence.network,
        product: evidence.product,
      };

      return {
        verified: true,
        requestId: metadata.requestId as string,
        apiVersion: GENESISPAY_API_VERSION,
        payment,
      };
    },
  };
}

function validateLocator(value: unknown): Record<string, string> {
  const record = plainRecord(value);
  const fields = ["attemptId", "linkId", "entitlementId"] as const;
  const supplied = fields.filter(
    (field) => record !== null && Object.prototype.hasOwnProperty.call(record, field),
  );

  if (supplied.length !== 1) {
    throw new GenesisPayAmbiguousLocatorError(
      "fulfillment.verify requires exactly one non-empty attemptId, linkId, or entitlementId.",
    );
  }

  const field = supplied[0];
  const locator = record?.[field];
  if (typeof locator !== "string" || locator.trim().length === 0) {
    throw new GenesisPayAmbiguousLocatorError(
      "fulfillment.verify requires exactly one non-empty attemptId, linkId, or entitlementId.",
    );
  }
  return { [field]: locator.trim() };
}

function validateExpectedContract(value: unknown): ExpectedFulfillmentContract {
  const record = plainRecord(value);
  const issues: GenesisPayValidationIssue[] = [];

  if (!record || (record.kind !== "product" && record.kind !== "payment_link")) {
    throw new GenesisPayValidationError(
      'fulfillment.verify expected.kind must be "product" or "payment_link".',
      [{ path: "expected.kind", message: "unsupported contract kind" }],
    );
  }

  const grossAmountMinor = validateInputMoney(
    record.grossAmountMinor,
    "expected.grossAmountMinor",
    record.kind === "product" ? PRODUCT_PRICE_MINOR_MAX : POSTGRES_BIGINT_MAX,
    issues,
  );
  const network = validateInputNetwork(record.network, issues);
  const settlementDestination = validateInputAddress(
    record.settlementDestination,
    "expected.settlementDestination",
    issues,
  );

  if (record.kind === "product") {
    const productId = validateInputNonEmptyString(record.productId, "expected.productId", issues);
    const sku = validateInputNullableString(record.sku, "expected.sku", issues);
    const delivery = validateInputDelivery(record.delivery, issues);
    throwInputIssues(issues);
    return {
      kind: "product",
      productId,
      sku,
      grossAmountMinor,
      network,
      settlementDestination,
      delivery,
    };
  }

  const linkId = validateInputNonEmptyString(record.linkId, "expected.linkId", issues);
  throwInputIssues(issues);
  return {
    kind: "payment_link",
    linkId,
    grossAmountMinor,
    network,
    settlementDestination,
  };
}

/** Internal shared validation for product gates before any payment negotiation begins. */
export function validateExpectedProductContract(value: unknown): ExpectedProductContract {
  const expected = validateExpectedContract(value);
  if (expected.kind !== "product") {
    throw new GenesisPayValidationError(
      "A product gate requires an ExpectedProductContract.",
      [{ path: "expected.kind", message: "must be product" }],
    );
  }
  return expected;
}

function validateInputMoney(
  value: unknown,
  path: string,
  maximum: bigint,
  issues: GenesisPayValidationIssue[],
): bigint {
  if (typeof value !== "bigint") {
    issues.push({ path, message: "must be bigint minor units" });
    return 0n;
  }
  if (value <= 0n || value > maximum) {
    issues.push({ path, message: `must be between 1 and ${maximum.toString()} minor units` });
  }
  return value;
}

function validateInputNetwork(
  value: unknown,
  issues: GenesisPayValidationIssue[],
): NetworkContract {
  const raw = plainRecord(value);
  if (!raw) {
    issues.push({ path: "expected.network", message: "must be a network contract" });
    return { ...ASSET_REGISTRY.test.USDC };
  }

  const mode = raw.mode === "test" || raw.mode === "live" ? raw.mode : null;
  const asset = raw.asset === "USDC" || raw.asset === "EURC" ? raw.asset : null;
  if (!mode) issues.push({ path: "expected.network.mode", message: "must be test or live" });
  if (raw.network !== "base") {
    issues.push({ path: "expected.network.network", message: "must be base" });
  }
  if (!asset) issues.push({ path: "expected.network.asset", message: "must be USDC or EURC" });

  const known = mode && asset ? ASSET_REGISTRY[mode][asset] : ASSET_REGISTRY.test.USDC;
  if (raw.chainId !== known.chainId) {
    issues.push({ path: "expected.network.chainId", message: "does not match mode" });
  }
  if (raw.minorUnitScale !== 6) {
    issues.push({ path: "expected.network.minorUnitScale", message: "must be 6" });
  }
  if (
    typeof raw.tokenAddress !== "string" ||
    !EVM_ADDRESS_PATTERN.test(raw.tokenAddress) ||
    raw.tokenAddress.toLowerCase() !== known.tokenAddress.toLowerCase()
  ) {
    issues.push({
      path: "expected.network.tokenAddress",
      message: "does not match the canonical asset deployment",
    });
  }

  return { ...known };
}

function validateInputDelivery(
  value: unknown,
  issues: GenesisPayValidationIssue[],
): ExpectedDeliveryContract {
  const raw = plainRecord(value);
  if (!raw || (raw.type !== "none" && raw.type !== "url" && raw.type !== "gate")) {
    issues.push({ path: "expected.delivery.type", message: "must be none, url, or gate" });
    return { type: "none", url: null, gate: null };
  }

  if (raw.type === "none") {
    if (raw.url !== null) issues.push({ path: "expected.delivery.url", message: "must be null" });
    if (raw.gate !== null) {
      issues.push({ path: "expected.delivery.gate", message: "must be null" });
    }
    return { type: "none", url: null, gate: null };
  }

  if (raw.type === "url") {
    const url = validateInputUrl(raw.url, "expected.delivery.url", issues);
    if (raw.gate !== null) {
      issues.push({ path: "expected.delivery.gate", message: "must be null" });
    }
    return { type: "url", url, gate: null };
  }

  if (raw.url !== null) issues.push({ path: "expected.delivery.url", message: "must be null" });
  const gate = plainRecord(raw.gate);
  const method = validateInputMethod(gate?.method, "expected.delivery.gate.method", issues);
  const resourceUrl = validateInputUrl(
    gate?.resourceUrl,
    "expected.delivery.gate.resourceUrl",
    issues,
  );
  const fingerprint =
    typeof gate?.fingerprint === "string" && FINGERPRINT_PATTERN.test(gate.fingerprint)
      ? gate.fingerprint
      : "";
  if (!fingerprint) {
    issues.push({
      path: "expected.delivery.gate.fingerprint",
      message: "must be a lowercase sha256 fingerprint",
    });
  }
  return { type: "gate", url: null, gate: { method, resourceUrl, fingerprint } };
}

function validateInputMethod(
  value: unknown,
  path: string,
  issues: GenesisPayValidationIssue[],
): string {
  if (typeof value !== "string" || !/^[A-Z]+$/.test(value)) {
    issues.push({ path, message: "must be an uppercase HTTP method" });
    return "";
  }
  return value;
}

function validateInputUrl(
  value: unknown,
  path: string,
  issues: GenesisPayValidationIssue[],
): string {
  try {
    if (typeof value !== "string") throw new Error("not a string");
    return canonicalAuthorityUrl(value);
  } catch {
    issues.push({ path, message: "must be an absolute https URL without credentials or fragment" });
    return "";
  }
}

function validateInputAddress(
  value: unknown,
  path: string,
  issues: GenesisPayValidationIssue[],
): EvmAddress {
  if (typeof value !== "string" || !EVM_ADDRESS_PATTERN.test(value)) {
    issues.push({ path, message: "must be a 20-byte 0x address" });
    return "0x0000000000000000000000000000000000000000";
  }
  return value as EvmAddress;
}

function validateInputNonEmptyString(
  value: unknown,
  path: string,
  issues: GenesisPayValidationIssue[],
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return "";
  }
  return value.trim();
}

function validateInputNullableString(
  value: unknown,
  path: string,
  issues: GenesisPayValidationIssue[],
): string | null {
  if (value === null) return null;
  return validateInputNonEmptyString(value, path, issues);
}

function throwInputIssues(issues: GenesisPayValidationIssue[]): void {
  if (issues.length > 0) {
    throw new GenesisPayValidationError(
      "fulfillment.verify rejected the expected payment contract.",
      issues,
    );
  }
}

function toWireExpectedContract(expected: ExpectedFulfillmentContract): Record<string, unknown> {
  return {
    ...expected,
    grossAmountMinor: expected.grossAmountMinor.toString(),
  };
}

/** Internal shape check after webhook HMAC verification, not authorization. */
export function assertFulfillmentEventEvidence(value: unknown): void {
  parseEvidence(value, { requestId: null, apiVersion: GENESISPAY_API_VERSION });
}

function parseEvidence(value: unknown, metadata: GenesisPayResponseMetadata): ParsedEvidence {
  const raw = requireRecord(value, "evidence", metadata);
  requireExact(raw.schema, "genesispay.fulfillment-evidence", "evidence.schema", metadata);

  const version = requireString(raw.version, "evidence.version", metadata);
  if (version !== GENESISPAY_API_VERSION) {
    throw new GenesisPayVersionError(
      "unsupported_evidence_version",
      `Unsupported fulfillment evidence version "${version}".`,
      metadata,
    );
  }

  if (raw.authorityVersion === null || raw.authorityVersion === undefined) {
    throw new GenesisPayEvidenceError(
      "historical_evidence_unavailable",
      "This payment predates strict authority evidence and cannot authorize fulfillment.",
      metadata,
    );
  }
  const authorityVersion = requireString(
    raw.authorityVersion,
    "evidence.authorityVersion",
    metadata,
  );
  if (authorityVersion !== GENESISPAY_API_VERSION) {
    throw new GenesisPayVersionError(
      "unsupported_evidence_version",
      `Unsupported payment authority version "${authorityVersion}".`,
      metadata,
    );
  }

  requireExact(raw.status, "confirmed", "evidence.status", metadata, "inconsistent_evidence");
  const simulation = requireRecord(raw.simulation, "evidence.simulation", metadata);
  if (simulation.simulated !== false) {
    inconsistent("evidence.simulation.simulated must be the literal false", metadata);
  }

  const paymentChannel = requirePaymentChannel(raw.paymentChannel, metadata);
  const settlement = requireRecord(raw.settlement, "evidence.settlement", metadata);
  const feeTerms = parseFeeTerms(settlement.feeTerms, metadata);
  const feeCollection = parseFeeCollection(settlement.feeCollection, metadata);

  const grossAmountMinor = parseMoney(
    settlement.grossAmountMinor,
    "evidence.settlement.grossAmountMinor",
    metadata,
  );
  const sellerAmountMinor = parseMoney(
    settlement.sellerAmountMinor,
    "evidence.settlement.sellerAmountMinor",
    metadata,
  );
  if (grossAmountMinor <= 0n) {
    inconsistent("evidence gross amount must be positive", metadata);
  }
  if (feeTerms.amountMinor > grossAmountMinor) {
    inconsistent("the quoted fee must not exceed the gross payment", metadata);
  }
  // The split the SELLER leg moved is decided by what the payer authorized. A
  // record-only fee is owed to the platform but was never deducted, so it must
  // not be subtracted from what the seller received — and a fee the ledger has
  // not collected must never silently balance this equation either.
  const authorizedFeeMinor =
    feeTerms.type === "payer_authorized" ? feeTerms.amountMinor : 0n;
  if (authorizedFeeMinor >= grossAmountMinor) {
    inconsistent("the payer-authorized fee must leave a positive seller payment", metadata);
  }
  if (sellerAmountMinor + authorizedFeeMinor !== grossAmountMinor) {
    inconsistent(
      "sellerAmountMinor plus the payer-authorized fee must equal grossAmountMinor",
      metadata,
    );
  }
  if (feeCollection.amountMinor !== null && feeCollection.amountMinor !== feeTerms.amountMinor) {
    inconsistent(
      "evidence.settlement.feeCollection.amountMinor contradicts the frozen fee terms",
      metadata,
    );
  }

  const entitlementId = requireNullableString(
    raw.entitlementId,
    "evidence.entitlementId",
    metadata,
  );
  const network = parseNetwork(raw.network, metadata);
  const product = parseProduct(raw.product, metadata);
  if (product && grossAmountMinor > PRODUCT_PRICE_MINOR_MAX) {
    inconsistent("product gross amount exceeds the product-domain maximum", metadata);
  }

  return {
    sellerId: requireString(raw.sellerId, "evidence.sellerId", metadata),
    linkId: requireString(raw.linkId, "evidence.linkId", metadata),
    attemptId: requireString(raw.attemptId, "evidence.attemptId", metadata),
    entitlementId,
    entitlement: parseEntitlementState(raw.entitlement, entitlementId, metadata),
    paymentChannel,
    confirmedAt: requireTimestamp(raw.confirmedAt, "evidence.confirmedAt", metadata),
    transactionHash: requireTransactionHash(
      raw.transactionHash,
      "evidence.transactionHash",
      metadata,
    ),
    grossAmountMinor,
    sellerAmountMinor,
    feeTerms,
    feeCollection,
    settlementDestination: requireAddress(
      settlement.destination,
      "evidence.settlement.destination",
      metadata,
    ),
    settlementStrategy: requireOneOf(
      settlement.strategy,
      ["dual", "atomic"] as const,
      "evidence.settlement.strategy",
      metadata,
    ),
    network,
    product,
  };
}

function parseFeeTerms(
  value: unknown,
  metadata: GenesisPayResponseMetadata,
): FeeTerms {
  const raw = requireRecord(value, "evidence.settlement.feeTerms", metadata);
  const type = requireOneOf(
    raw.type,
    ["record_only", "payer_authorized"] as const,
    "evidence.settlement.feeTerms.type",
    metadata,
  );
  const amountMinor = parseMoney(
    raw.amountMinor,
    "evidence.settlement.feeTerms.amountMinor",
    metadata,
  );
  // An authorized fee leg names the treasury the payer signed to; a record-only
  // fee has no signed destination and must not invent one.
  if (type === "record_only") {
    requireNull(
      raw.treasuryAddress,
      "evidence.settlement.feeTerms.treasuryAddress",
      metadata,
    );
    return { type, amountMinor, treasuryAddress: null };
  }

  return {
    type,
    amountMinor,
    treasuryAddress: requireAddress(
      raw.treasuryAddress,
      "evidence.settlement.feeTerms.treasuryAddress",
      metadata,
    ),
  };
}

function parseFeeCollection(
  value: unknown,
  metadata: GenesisPayResponseMetadata,
): FeeCollection {
  const raw = requireRecord(value, "evidence.settlement.feeCollection", metadata);
  const status = requireOneOf(
    raw.status,
    [
      "not_recorded",
      "recorded",
      "pending",
      "collecting",
      "collected",
      "failed",
      "written_off",
    ] as const,
    "evidence.settlement.feeCollection.status",
    metadata,
  );
  const amountMinor =
    raw.amountMinor === null
      ? null
      : parseMoney(
          raw.amountMinor,
          "evidence.settlement.feeCollection.amountMinor",
          metadata,
        );
  const treasuryAddress =
    raw.treasuryAddress === null
      ? null
      : requireAddress(
          raw.treasuryAddress,
          "evidence.settlement.feeCollection.treasuryAddress",
          metadata,
        );
  const transactionHash =
    raw.transactionHash === null
      ? null
      : requireTransactionHash(
          raw.transactionHash,
          "evidence.settlement.feeCollection.transactionHash",
          metadata,
        );
  const collectedAt =
    raw.collectedAt === null
      ? null
      : requireTimestamp(
          raw.collectedAt,
          "evidence.settlement.feeCollection.collectedAt",
          metadata,
        );

  // `collected` is the only status that claims tokens moved, and it must carry
  // the transfer that moved them. `failed` asserts the opposite, so a hash there
  // is a contradiction; `not_recorded` means no ledger row exists at all.
  if (status === "collected" && (!transactionHash || !collectedAt || amountMinor === null)) {
    inconsistent("a collected fee must carry its amount, transaction hash and time", metadata);
  }
  if (status === "failed" && transactionHash) {
    inconsistent("a failed fee collection must carry no transaction hash", metadata);
  }
  if (
    status === "not_recorded" &&
    (amountMinor !== null ||
      treasuryAddress !== null ||
      transactionHash !== null ||
      collectedAt !== null)
  ) {
    inconsistent("an unrecorded fee collection must carry no ledger detail", metadata);
  }
  if (status !== "not_recorded" && (amountMinor === null || treasuryAddress === null)) {
    inconsistent("a recorded fee collection must name its amount and treasury", metadata);
  }

  return { status, amountMinor, treasuryAddress, transactionHash, collectedAt };
}

function parseEntitlementState(
  value: unknown,
  entitlementId: string | null,
  metadata: GenesisPayResponseMetadata,
): EntitlementState | null {
  if (value === undefined) {
    malformed("evidence.entitlement is required (null when there is none)", metadata);
  }
  // Both or neither: an id with no state would hide a revocation, and state
  // with no id names nothing.
  if (value === null) {
    if (entitlementId !== null) {
      inconsistent("evidence names an entitlement but omits its state", metadata);
    }
    return null;
  }
  if (entitlementId === null) {
    inconsistent("evidence carries entitlement state without an entitlementId", metadata);
  }

  const raw = requireRecord(value, "evidence.entitlement", metadata);
  const expiresAt = requireTimestamp(
    raw.expiresAt,
    "evidence.entitlement.expiresAt",
    metadata,
  );
  const revokedAt =
    raw.revokedAt === null
      ? null
      : requireTimestamp(raw.revokedAt, "evidence.entitlement.revokedAt", metadata);
  if (typeof raw.valid !== "boolean") {
    malformed("evidence.entitlement.valid must be a boolean", metadata);
  }
  if (raw.valid && revokedAt !== null) {
    inconsistent("a revoked entitlement cannot be valid", metadata);
  }

  return { expiresAt, revokedAt, valid: raw.valid };
}

function parseNetwork(value: unknown, metadata: GenesisPayResponseMetadata): NetworkContract {
  const raw = requireRecord(value, "evidence.network", metadata);
  const mode = requireOneOf(
    raw.mode,
    ["test", "live"] as const,
    "evidence.network.mode",
    metadata,
  );
  const asset = requireOneOf(
    raw.asset,
    ["USDC", "EURC"] as const,
    "evidence.network.asset",
    metadata,
  );
  const known = ASSET_REGISTRY[mode][asset];

  requireExact(
    raw.network,
    "base",
    "evidence.network.network",
    metadata,
    "inconsistent_evidence",
  );
  if (raw.chainId !== known.chainId) {
    inconsistent("evidence.network.chainId contradicts deployment mode", metadata);
  }
  if (raw.minorUnitScale !== 6) {
    inconsistent("evidence.network.minorUnitScale must be 6", metadata);
  }
  const tokenAddress = requireAddress(
    raw.tokenAddress,
    "evidence.network.tokenAddress",
    metadata,
  );
  if (tokenAddress.toLowerCase() !== known.tokenAddress.toLowerCase()) {
    inconsistent("evidence token address contradicts the canonical asset registry", metadata);
  }

  // Public result objects are mutable; never expose the shared trusted registry.
  return { ...known };
}

function parseProduct(
  value: unknown,
  metadata: GenesisPayResponseMetadata,
): ParsedEvidence["product"] {
  if (value === null) return null;
  const raw = requireRecord(value, "evidence.product", metadata);
  const contractVersion = requireString(
    raw.contractVersion,
    "evidence.product.contractVersion",
    metadata,
  );
  if (contractVersion !== GENESISPAY_API_VERSION) {
    throw new GenesisPayVersionError(
      "unsupported_evidence_version",
      `Unsupported product contract version "${contractVersion}".`,
      metadata,
    );
  }

  return {
    productId: requireString(raw.productId, "evidence.product.productId", metadata),
    sku: requireNullableString(raw.sku, "evidence.product.sku", metadata),
    delivery: parseDelivery(raw.delivery, metadata),
  };
}

function parseDelivery(
  value: unknown,
  metadata: GenesisPayResponseMetadata,
): ExpectedDeliveryContract {
  const raw = requireRecord(value, "evidence.product.delivery", metadata);
  const type = requireOneOf(
    raw.type,
    ["none", "url", "gate"] as const,
    "evidence.product.delivery.type",
    metadata,
  );

  if (type === "none") {
    requireNull(raw.url, "evidence.product.delivery.url", metadata);
    requireNull(raw.gate, "evidence.product.delivery.gate", metadata);
    return { type, url: null, gate: null };
  }
  if (type === "url") {
    requireNull(raw.gate, "evidence.product.delivery.gate", metadata);
    return {
      type,
      url: requireCanonicalUrl(raw.url, "evidence.product.delivery.url", metadata),
      gate: null,
    };
  }

  requireNull(raw.url, "evidence.product.delivery.url", metadata);
  const gate = requireRecord(raw.gate, "evidence.product.delivery.gate", metadata);
  const method = requireString(gate.method, "evidence.product.delivery.gate.method", metadata);
  if (!/^[A-Z]+$/.test(method)) {
    malformed("evidence.product.delivery.gate.method must be uppercase", metadata);
  }
  const fingerprint = requireString(
    gate.fingerprint,
    "evidence.product.delivery.gate.fingerprint",
    metadata,
  );
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    malformed("evidence gate fingerprint is not canonical sha256", metadata);
  }
  return {
    type,
    url: null,
    gate: {
      method,
      resourceUrl: requireCanonicalUrl(
        gate.resourceUrl,
        "evidence.product.delivery.gate.resourceUrl",
        metadata,
      ),
      fingerprint,
    },
  };
}

function compareEvidence(
  evidence: ParsedEvidence,
  expected: ExpectedFulfillmentContract,
  locator: Record<string, string>,
): string[] {
  const mismatches: string[] = [];
  const compare = (matches: boolean, path: string) => {
    if (!matches) mismatches.push(path);
  };

  if (locator.attemptId !== undefined) {
    compare(evidence.attemptId === locator.attemptId, "locator.attemptId");
  }
  if (locator.linkId !== undefined) {
    compare(evidence.linkId === locator.linkId, "locator.linkId");
  }
  if (locator.entitlementId !== undefined) {
    compare(evidence.entitlementId === locator.entitlementId, "locator.entitlementId");
  }

  compare(evidence.grossAmountMinor === expected.grossAmountMinor, "grossAmountMinor");
  compare(
    evidence.settlementDestination.toLowerCase() ===
      expected.settlementDestination.toLowerCase(),
    "settlementDestination",
  );
  compare(evidence.network.mode === expected.network.mode, "network.mode");
  compare(evidence.network.network === expected.network.network, "network.network");
  compare(evidence.network.chainId === expected.network.chainId, "network.chainId");
  compare(evidence.network.asset === expected.network.asset, "network.asset");
  compare(
    evidence.network.tokenAddress.toLowerCase() === expected.network.tokenAddress.toLowerCase(),
    "network.tokenAddress",
  );
  compare(
    evidence.network.minorUnitScale === expected.network.minorUnitScale,
    "network.minorUnitScale",
  );

  if (expected.kind === "payment_link") {
    compare(evidence.linkId === expected.linkId, "linkId");
    // A payment-link contract claims nothing about delivery, so a product
    // payment must not satisfy it: the product and delivery comparisons below
    // would be skipped entirely, and a `verified: true` would read as though
    // delivery had been checked.
    compare(evidence.product === null, "product");
    return mismatches;
  }

  if (!evidence.product) {
    mismatches.push("product");
    return mismatches;
  }
  compare(evidence.product.productId === expected.productId, "product.productId");
  compare(evidence.product.sku === expected.sku, "product.sku");
  compare(evidence.product.delivery.type === expected.delivery.type, "product.delivery.type");
  compare(evidence.product.delivery.url === expected.delivery.url, "product.delivery.url");
  compare(
    evidence.product.delivery.gate?.method === expected.delivery.gate?.method,
    "product.delivery.gate.method",
  );
  compare(
    evidence.product.delivery.gate?.resourceUrl === expected.delivery.gate?.resourceUrl,
    "product.delivery.gate.resourceUrl",
  );
  compare(
    evidence.product.delivery.gate?.fingerprint === expected.delivery.gate?.fingerprint,
    "product.delivery.gate.fingerprint",
  );
  return mismatches;
}

function requireResponseMetadata(
  response: Response,
  root: Record<string, unknown>,
): { requestId: string; apiVersion: ApiVersion } {
  const headerRequestId = response.headers.get(GENESISPAY_REQUEST_ID_HEADER);
  const headerVersion = response.headers.get(GENESISPAY_VERSION_HEADER);
  const bodyRequestId = typeof root.requestId === "string" ? root.requestId : null;
  const bodyVersion = typeof root.apiVersion === "string" ? root.apiVersion : null;
  const metadata = {
    requestId: headerRequestId ?? bodyRequestId,
    apiVersion: headerVersion ?? bodyVersion,
  };

  if (!headerVersion || !bodyVersion) {
    malformed("versioned fulfillment response omitted apiVersion metadata", metadata);
  }
  if (headerVersion !== GENESISPAY_API_VERSION || bodyVersion !== GENESISPAY_API_VERSION) {
    throw new GenesisPayVersionError(
      "unsupported_api_version",
      `Unsupported GenesisPay API version "${headerVersion ?? bodyVersion ?? "missing"}".`,
      metadata,
    );
  }
  if (!headerRequestId || !bodyRequestId) {
    malformed("versioned fulfillment response omitted requestId metadata", metadata);
  }
  if (headerRequestId !== bodyRequestId || headerVersion !== bodyVersion) {
    inconsistent("response headers and body carry different request/version metadata", metadata);
  }

  return { requestId: headerRequestId, apiVersion: GENESISPAY_API_VERSION };
}

function metadataFromResponse(response: Response, body: unknown): GenesisPayResponseMetadata {
  const root = plainRecord(body);
  return {
    requestId:
      response.headers.get(GENESISPAY_REQUEST_ID_HEADER) ??
      (typeof root?.requestId === "string" ? root.requestId : null),
    apiVersion:
      response.headers.get(GENESISPAY_VERSION_HEADER) ??
      (typeof root?.apiVersion === "string" ? root.apiVersion : null),
  };
}

/**
 * Maps a non-OK verification response onto a typed error.
 *
 * Everything here is read LENIENTLY on purpose. An error response is not
 * evidence: every branch throws, so nothing can be believed by being
 * well-formed. Demanding a parseable object or complete strict metadata first
 * turned an upstream proxy's 502 HTML page into `malformed_evidence` — which
 * `isPermanentAuthorityError` classifies as deterministic, so the product gate
 * told the seller a confirmed payment "requires operator intervention" when a
 * single retry would have succeeded. A deterministic verdict may only come from
 * a backend that actually stated one.
 */
function throwFulfillmentHttpError(response: Response, body: unknown): never {
  const root = plainRecord(body);
  const nestedError = plainRecord(root?.error);
  const code =
    typeof nestedError?.code === "string"
      ? nestedError.code
      : typeof root?.code === "string"
        ? root.code
        : typeof root?.error === "string"
          ? root.error
          : null;
  const message =
    (typeof nestedError?.message === "string" && nestedError.message) ||
    (typeof root?.message === "string" && root.message) ||
    (typeof root?.error === "string" && root.error) ||
    `GenesisPay fulfillment verification failed with HTTP ${response.status}.`;
  const metadata = metadataFromResponse(response, body);

  if (code === "unsupported_api_version") {
    throw new GenesisPayVersionError(code, message, metadata);
  }
  if (code === "unsupported_evidence_version") {
    throw new GenesisPayVersionError(code, message, metadata);
  }
  if (code === "ambiguous_locator") {
    throw new GenesisPayAmbiguousLocatorError(message, metadata);
  }
  if (code === "contract_mismatch") {
    const mismatches = Array.isArray(root?.mismatches)
      ? root.mismatches.filter((value): value is string => typeof value === "string")
      : [];
    throw new GenesisPayContractMismatchError(message, mismatches, metadata);
  }
  if (
    code === "malformed_evidence" ||
    code === "inconsistent_evidence" ||
    code === "historical_evidence_unavailable" ||
    code === "unsupported_payment_channel"
  ) {
    throw new GenesisPayEvidenceError(code, message, metadata);
  }
  if (response.status === 422) {
    const issues = Array.isArray(root?.issues)
      ? root.issues.flatMap((entry): GenesisPayValidationIssue[] => {
          const issue = plainRecord(entry);
          return typeof issue?.message === "string"
            ? [{ path: typeof issue.path === "string" ? issue.path : "", message: issue.message }]
            : [];
        })
      : [];
    throw new GenesisPayValidationError(message, issues, metadata);
  }
  if (response.status === 429) {
    throw new GenesisPayRateLimitError(
      message,
      parseRetryAfterSeconds(response.headers.get("retry-after")),
      metadata,
    );
  }
  throw new GenesisPayConfigError(message, metadata);
}

function parseMoney(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): bigint {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 19 ||
    !CANONICAL_MONEY_PATTERN.test(value)
  ) {
    malformed(`${path} must be a canonical decimal string of at most 19 digits`, metadata);
  }
  const parsed = BigInt(value);
  if (parsed > POSTGRES_BIGINT_MAX) {
    malformed(`${path} exceeds the signed PostgreSQL bigint maximum`, metadata);
  }
  return parsed;
}

function requirePaymentChannel(
  value: unknown,
  metadata: GenesisPayResponseMetadata,
): PaymentChannel {
  if (value === "unknown") {
    throw new GenesisPayEvidenceError(
      "unsupported_payment_channel",
      'paymentChannel "unknown" cannot authorize fulfillment.',
      metadata,
    );
  }
  return requireOneOf(
    value,
    ["checkout", "x402", "bank_transfer"] as const,
    "evidence.paymentChannel",
    metadata,
  );
}

function requireCanonicalUrl(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): string {
  if (typeof value !== "string") malformed(`${path} must be a string`, metadata);
  let canonical: string;
  try {
    canonical = canonicalAuthorityUrl(value);
  } catch {
    malformed(`${path} is not a valid authority URL`, metadata);
  }
  if (canonical !== value) inconsistent(`${path} is not canonically serialized`, metadata);
  return canonical;
}

function canonicalAuthorityUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("unsafe authority URL");
  }
  return url.href;
}

function requireString(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): string {
  if (typeof value !== "string" || value.length === 0) {
    malformed(`${path} must be a non-empty string`, metadata);
  }
  return value;
}

function requireNullableString(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): string | null {
  if (value === null) return null;
  return requireString(value, path, metadata);
}

function requireAddress(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): EvmAddress {
  if (typeof value !== "string" || !EVM_ADDRESS_PATTERN.test(value)) {
    malformed(`${path} must be a 20-byte 0x address`, metadata);
  }
  return value as EvmAddress;
}

function requireTransactionHash(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): EvmAddress {
  if (typeof value !== "string" || !TRANSACTION_HASH_PATTERN.test(value)) {
    malformed(`${path} must be a 32-byte transaction hash`, metadata);
  }
  return value as EvmAddress;
}

function requireTimestamp(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): string {
  const timestamp = requireString(value, path, metadata);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    malformed(`${path} must be a canonical UTC ISO timestamp`, metadata);
  }
  return timestamp;
}

function requireNull(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): void {
  if (value !== null) malformed(`${path} must be null`, metadata);
}

function requireRecord(
  value: unknown,
  path: string,
  metadata: GenesisPayResponseMetadata,
): Record<string, unknown> {
  const record = plainRecord(value);
  if (!record) malformed(`${path} must be an object`, metadata);
  return record;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  metadata: GenesisPayResponseMetadata,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    malformed(`${path} must be one of ${allowed.join(", ")}`, metadata);
  }
  return value as T;
}

function requireExact(
  value: unknown,
  expected: string,
  path: string,
  metadata: GenesisPayResponseMetadata,
  errorCode: "malformed_evidence" | "inconsistent_evidence" = "malformed_evidence",
): void {
  if (value !== expected) {
    if (errorCode === "inconsistent_evidence") {
      inconsistent(`${path} must be ${expected}`, metadata);
    }
    malformed(`${path} must be ${expected}`, metadata);
  }
}

function malformed(message: string, metadata: GenesisPayResponseMetadata): never {
  throw new GenesisPayEvidenceError("malformed_evidence", message, metadata);
}

function inconsistent(message: string, metadata: GenesisPayResponseMetadata): never {
  throw new GenesisPayEvidenceError("inconsistent_evidence", message, metadata);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function readJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Headers can arrive before the connection fails. An unreadable stream is
    // a transport failure, not a completed malformed authority statement.
    throw new GenesisPayConfigError(
      `Failed to read GenesisPay fulfillment verification: ${describeError(error)}`,
      metadataFromResponse(response, null),
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}
