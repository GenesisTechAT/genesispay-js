import type { AgentPaymentRecord } from "./types.js";

/** Base class for all errors raised by the PeerPay Agent API client. */
export class PeerPayApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message);
    this.name = "PeerPayApiError";
    this.status = options.status;
    this.code = options.code ?? null;
  }
}

/** 401: the agent API key is missing, malformed, or revoked. */
export class PeerPayAuthError extends PeerPayApiError {
  constructor(message: string) {
    super(message, { status: 401, code: "unauthorized" });
    this.name = "PeerPayAuthError";
  }
}

/** 403: the account's spending policy hard-blocked the payment (allowlist). */
export class PeerPayPolicyBlockedError extends PeerPayApiError {
  constructor(message: string) {
    super(message, { status: 403, code: "policy_blocked" });
    this.name = "PeerPayPolicyBlockedError";
  }
}

/**
 * 402/422: the payment request was rejected before any money moved —
 * e.g. `amount_exceeds_max`, `payment_not_required`,
 * `unsupported_payment_requirement`, `blocked_url`.
 */
export class PeerPayPaymentRejectedError extends PeerPayApiError {
  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message, options);
    this.name = "PeerPayPaymentRejectedError";
  }
}

/** The payment executed but failed to settle (5xx from PeerPay). */
export class PeerPayPaymentFailedError extends PeerPayApiError {
  readonly payment: AgentPaymentRecord | null;

  constructor(
    message: string,
    options: { status: number; payment?: AgentPaymentRecord | null },
  ) {
    super(message, { status: options.status, code: "payment_failed" });
    this.name = "PeerPayPaymentFailedError";
    this.payment = options.payment ?? null;
  }
}

/** The human decision (approve/deny) did not arrive within the wait window. */
export class PeerPayApprovalTimeoutError extends Error {
  readonly payment: AgentPaymentRecord;
  readonly approvalUrl: string | null;

  constructor(payment: AgentPaymentRecord, approvalUrl: string | null) {
    super(
      `Timed out waiting for human approval of payment ${payment.id}. ` +
        "The payment is still pending — surface the approval URL to the user " +
        "and check again later with paymentStatus().",
    );
    this.name = "PeerPayApprovalTimeoutError";
    this.payment = payment;
    this.approvalUrl = approvalUrl;
  }
}

/** The payment was denied or its approval window expired. */
export class PeerPayApprovalRejectedError extends Error {
  readonly payment: AgentPaymentRecord;

  constructor(payment: AgentPaymentRecord) {
    super(
      payment.status === "denied"
        ? `Payment ${payment.id} was denied by the account owner.`
        : `Payment ${payment.id} expired before it was approved.`,
    );
    this.name = "PeerPayApprovalRejectedError";
    this.payment = payment;
  }
}
