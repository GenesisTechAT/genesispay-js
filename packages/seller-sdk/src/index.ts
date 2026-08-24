// @genesis-tech/genesispay-seller — framework-agnostic x402 payment gate.

export {
  GenesisPay,
  type GenesisPayKeyMode,
  type GenesisPayClientOptions,
  type SellerConfig,
  type CheckoutAmountInput,
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

// The merchant's catalogue. A product's payable instance is one canonical
// reusable checkout link, minted idempotently with `products.createPaymentLink`.
export {
  type Product,
  type ProductCreateInput,
  type ProductPaymentLink,
  type ProductDelivery,
  type ProductGate,
  type ProductGatePurchase,
  type ProductsResource,
} from "./products.js";

export { type EntitlementsResource, type VerifiedEntitlement } from "./entitlements.js";

export {
  type Customer,
  type CustomerCreateInput,
  type CustomerUpdateInput,
  type CustomersResource,
} from "./customers.js";

export {
  type Invoice,
  type InvoiceStatus,
  type InvoiceLineInput,
  type InvoiceDraftInput,
  type InvoiceEmailDelivery,
  type InvoicesResource,
} from "./invoices.js";

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
  GenesisPayConfigError,
  GenesisPayNetworkSafetyError,
  GenesisPayNotFoundError,
  GenesisPayValidationError,
  GenesisPayRateLimitError,
  type GenesisPayValidationIssue,
} from "./errors.js";

export {
  constructEvent,
  isKnownGenesisPayEventType,
  GENESISPAY_EVENT_TYPES,
  GenesisPaySignatureVerificationError,
  type GenesisPayEvent,
  type GenesisPayAnyEvent,
  type GenesisPayUnknownEvent,
  type GenesisPayEventType,
  type GenesisPayPaymentEvent,
  type GenesisPayMandateEvent,
  type GenesisPayAgentPaymentEvent,
  type GenesisPayPaymentEventData,
  type GenesisPayMandateEventData,
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
  genesisPaySettlement,
  DEFAULT_FACILITATOR_BASE_URL,
  type GenesisPaySettlementOptions,
} from "./genesispay-settlement.js";

export {
  resolvePaymentGateNetwork,
  type PaymentGateNetwork,
  type PaymentGateNetworkConfig,
} from "./networks.js";

export { parseUsdcAmountToMinorUnits } from "./usdc-amount.js";

// Checkout return parameters: the query-parameter names GenesisPay appends to a
// merchant's `returnUrl`, plus the typed hint parser that reads them back. The
// hint is a UI convenience, not proof of payment — verify with
// `checkout.retrieve(hint.linkId)` before acting on it.
export {
  CHECKOUT_RETURN_LINK_ID_PARAM,
  CHECKOUT_RETURN_STATUS_PARAM,
  parseCheckoutReturnHint,
  type CheckoutReturnHint,
} from "./checkout-return.js";

export {
  createMandateGate,
  MANDATE_HEADER,
  type MandateChargeOutcome,
  type MandateGate,
  type MandateGateOptions,
} from "./mandate-gate.js";
