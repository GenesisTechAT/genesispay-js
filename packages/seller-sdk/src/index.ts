// @genesis-tech/peerpay-seller — framework-agnostic x402 payment gate.

export {
  PeerPay,
  type PeerPayKeyMode,
  type PeerPayClientOptions,
  type SellerConfig,
  type CheckoutCreateInput,
  type CheckoutLink,
  type CheckoutSession,
  type CheckoutAttempt,
  type CheckoutAttemptStatus,
  type SimulatePaymentOptions,
  type GateConfig,
  type ResolvingGate,
} from "./client.js";

// Recurring billing. `plans` are the reusable templates a merchant creates once
// (each carries the hosted `checkoutUrl`); `mandates` are the per-payer spending
// authorizations. There is deliberately no `mandates.activate` — activation
// needs the payer's signature, not the seller key. See mandates.ts.
export {
  type SubscriptionPlan,
  type SubscriptionPlanStatus,
  type PlanCreateInput,
  type PlansResource,
} from "./plans.js";

export {
  type Mandate,
  type MandateKind,
  type MandateStatus,
  type MandateCreateInput,
  type MandateCreateResult,
  type MandateCharge,
  type MandateChargeInput,
  type MandateChargeStatus,
  type MandateListOptions,
  type MandateListPage,
  type PermitTypedData,
  type MandatesResource,
} from "./mandates.js";

// Every SDK method throws from this set: 404 → NotFound, 422 (and 400 when the
// body carries structured `issues`) → Validation, 429 → RateLimit (with
// `retryAfterSeconds`), anything else → Config.
export {
  PeerPayConfigError,
  PeerPayNetworkSafetyError,
  PeerPayNotFoundError,
  PeerPayValidationError,
  PeerPayRateLimitError,
  type PeerPayValidationIssue,
} from "./errors.js";

export {
  constructEvent,
  isKnownPeerPayEventType,
  PEERPAY_EVENT_TYPES,
  PeerPaySignatureVerificationError,
  type PeerPayEvent,
  type PeerPayAnyEvent,
  type PeerPayUnknownEvent,
  type PeerPayEventType,
  type PeerPayPaymentEvent,
  type PeerPayMandateEvent,
  type PeerPayAgentPaymentEvent,
  type PeerPayPaymentEventData,
  type PeerPayMandateEventData,
  type ConstructEventOptions,
} from "./webhooks.js";

export {
  createPaymentGate,
  type PaymentGate,
  type PaymentGateConfig,
  type SettlementContext,
  type SettlementVerification,
  type VerifySettlement,
  type WrapOptions,
} from "./payment-gate.js";

export {
  peerPaySettlement,
  DEFAULT_FACILITATOR_BASE_URL,
  type PeerPaySettlementOptions,
} from "./peerpay-settlement.js";

export {
  resolvePaymentGateNetwork,
  type PaymentGateNetwork,
  type PaymentGateNetworkConfig,
} from "./networks.js";

export { parseUsdcAmountToMinorUnits } from "./usdc-amount.js";

export {
  createMandateGate,
  MANDATE_HEADER,
  type MandateChargeOutcome,
  type MandateGate,
  type MandateGateOptions,
} from "./mandate-gate.js";
