// @genesis-tech/peerpay-agent — client SDK for the PeerPay Agent API.

export { PeerPayAgent, type PeerPayAgentConfig } from "./client.js";

export { AgentPaymentResult } from "./payment-result.js";

export {
  PeerPayApiError,
  PeerPayApprovalRejectedError,
  PeerPayApprovalTimeoutError,
  PeerPayAuthError,
  PeerPayPaymentFailedError,
  PeerPayPaymentRejectedError,
  PeerPayPolicyBlockedError,
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
