// @genesis-tech/genesispay-agent — client SDK for the GenesisPay Agent API.

export { GenesisPayAgent, type GenesisPayAgentConfig } from "./client.js";

export { AgentPaymentResult } from "./payment-result.js";

export { PURCHASE_BODY_MAX_BYTES } from "./purchase-request.js";

export {
  GenesisPayApiError,
  GenesisPayApprovalRejectedError,
  GenesisPayApprovalTimeoutError,
  GenesisPayAuthError,
  GenesisPayDuplicatePaymentError,
  GenesisPayIdempotencyConflictError,
  GenesisPayOutcomeWaitTimeoutError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
  GenesisPayPolicyBlockedError,
  GenesisPayUnresolvedPaymentError,
} from "./errors.js";

export type {
  AgentAccountInfo,
  AgentHttpResponseCapture,
  AgentPaymentRecord,
  AgentPaymentStatus,
  AgentSpendingPolicy,
  DiscoveredService,
  DiscoveredShop,
  DiscoveredShopRef,
  DiscoverOptions,
  PaymentAsset,
  PayOptions,
  PurchaseContentType,
  PurchaseMethod,
  ShopsOptions,
  WaitForApprovalOptions,
  WaitForOutcomeOptions,
} from "./types.js";
