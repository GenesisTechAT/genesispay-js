// @genesis-tech/genesispay-agent — client SDK for the GenesisPay Agent API.

export { GenesisPayAgent, type GenesisPayAgentConfig } from "./client.js";

export { AgentPaymentResult } from "./payment-result.js";

export { PURCHASE_BODY_MAX_BYTES } from "./purchase-request.js";
export { prepareReviewInputSchema, publishReviewInputSchema, withdrawReviewInputSchema,
  publicReviewsRequestSchema, reviewSummarySchema,
  type PrepareReviewInput, type PublishReviewInput, type PreparedReview, type PublishedReview,
  type PublicReviewPage, type ReviewSummary } from "./reviews.js";

export {
  serviceContractSchema, serviceContractRefSchema, serviceListingIdSchema,
  SERVICE_CONTRACT_MAX_BYTES,
  type ServiceContract, type ServiceContractRef, type ServiceInputSchema,
} from "./service-contract.js";

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
  AgentBuyerFeeStatus,
  AgentHttpResponseCapture,
  AgentPaymentRecord,
  AgentStoredResult,
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
  TrendingOptions,
  TrendingProduct,
  WaitForApprovalOptions,
  WaitForOutcomeOptions,
} from "./types.js";

export {
  externalServiceIdSchema, externalServiceQuerySchema, externalServiceSchema, externalServicePageSchema,
  externalServiceBuyerFeeSchema, externalServiceIncludeSchema, externalServiceDiscoveryOptionsSchema,
  externalServiceDescribeOptionsSchema,
  type ExternalService, type ExternalServiceQuery, type ExternalServiceBuyerFee, type ExternalServiceInclude,
  type ExternalServiceDiscoveryOptions, type ExternalServiceDescribeOptions,
} from "./external-service.js";

export { reviewOpportunitySchema, purchaseReviewsRequestSchema, reviewTargetSchema,
  preparedPurchaseReviewResponseSchema, publishedPurchaseReviewResponseSchema,
  type ReviewOpportunity, type PurchaseReviewTarget, type PreparedPurchaseReview, type PublishedPurchaseReview } from "./purchase-reviews.js";
