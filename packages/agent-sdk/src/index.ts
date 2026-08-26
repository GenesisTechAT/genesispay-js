// @genesis-tech/genesispay-agent — client SDK for the GenesisPay Agent API.

export { GenesisPayAgent, type GenesisPayAgentConfig } from "./client.js";

export { AgentPaymentResult } from "./payment-result.js";

export {
  GenesisPayApiError,
  GenesisPayApprovalRejectedError,
  GenesisPayApprovalTimeoutError,
  GenesisPayAuthError,
  GenesisPayDuplicatePaymentError,
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
  DiscoverOptions,
  PaymentAsset,
  PayOptions,
  WaitForApprovalOptions,
} from "./types.js";
