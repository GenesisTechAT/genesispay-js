import type { AgentPaymentRecord } from "./types.js";

/**
 * Base class for **every** error this client raises, so
 * `catch (e) { if (e instanceof GenesisPayApiError) … }` is exhaustive.
 *
 * That was not always true: the two approval outcomes extended `Error`
 * directly, so a consumer writing exactly that check silently rethrew the most
 * common results of `pay({ waitForApproval })`. If you branch on error type,
 * branch on `code` — it is set for every subclass.
 *
 * `status` is the HTTP status when the error came from a response, and `0` when
 * it was raised client-side (timeouts, unrecognised states) and no response
 * carries the meaning.
 */
export class GenesisPayApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message);
    this.name = "GenesisPayApiError";
    this.status = options.status;
    this.code = options.code ?? null;
  }
}

/** 401: the agent API key is missing, malformed, or revoked. */
export class GenesisPayAuthError extends GenesisPayApiError {
  constructor(message: string) {
    super(message, { status: 401, code: "unauthorized" });
    this.name = "GenesisPayAuthError";
  }
}

/** 403: the account's spending policy hard-blocked the payment (allowlist). */
export class GenesisPayPolicyBlockedError extends GenesisPayApiError {
  constructor(message: string) {
    super(message, { status: 403, code: "policy_blocked" });
    this.name = "GenesisPayPolicyBlockedError";
  }
}

/**
 * The payment request was rejected **before any money moved** — a bad URL, an
 * unreachable target, a resource that turned out to be free, a requirement we
 * cannot pay, or an amount over the caller's own ceiling.
 *
 * The status can be 4xx or 5xx (`target_unreachable` is a 502 because the
 * failure is the seller's endpoint; `agent_busy` is a 503 because another
 * payment for the same agent was in flight), so branch on this class rather
 * than on the status. Nothing was signed, so a fresh attempt is safe — and for
 * `agent_busy`, retrying after a moment is exactly the right move.
 */
export class GenesisPayPaymentRejectedError extends GenesisPayApiError {
  constructor(message: string, options: { status: number; code?: string | null }) {
    // Defaulted, not forwarded-as-null: the base class promises every subclass
    // sets a `code`, and this was the one that could break the promise — a
    // 402/422 whose body did not parse (a proxy rewrote it) left `code: null`
    // and a consumer branching on codes fell through. Free to fix now, an
    // observable behaviour change once published.
    super(message, {
      status: options.status,
      code: options.code ?? "payment_rejected",
    });
    this.name = "GenesisPayPaymentRejectedError";
  }
}

/** The payment executed but failed to settle (5xx from GenesisPay). */
export class GenesisPayPaymentFailedError extends GenesisPayApiError {
  readonly payment: AgentPaymentRecord | null;

  constructor(
    message: string,
    options: { status: number; payment?: AgentPaymentRecord | null },
  ) {
    super(message, { status: options.status, code: "payment_failed" });
    this.name = "GenesisPayPaymentFailedError";
    this.payment = options.payment ?? null;
  }
}

/**
 * **The one class to catch if you retry payments:** whether money moved is
 * unknown.
 *
 * Every path that cannot rule out a charge throws this or a subclass — a server
 * `unresolved` envelope, a timeout while the payment was executing, and a
 * dropped connection on `pay()`/`executePayment()`, which is the most likely of
 * the three in production because the request is held open while the server
 * signs and calls the resource.
 *
 * Deliberately NOT a `GenesisPayPaymentFailedError`: the two call for opposite
 * behaviour. A failed payment never moved money and is safe to retry; this one
 * may have. Retry it **only** with the same `idempotencyKey` — a fresh key is a
 * second purchase.
 *
 * `payment` is null when the failure happened before any response came back, so
 * there is no payment record to report. `paymentId` may still be known.
 */
export class GenesisPayPaymentOutcomeUnknownError extends GenesisPayApiError {
  readonly payment: AgentPaymentRecord | null;
  readonly paymentId: string | null;
  /** The key to reuse on a retry, when the caller supplied one. */
  readonly idempotencyKey: string | null;

  constructor(
    message: string,
    options: {
      status?: number;
      payment?: AgentPaymentRecord | null;
      paymentId?: string | null;
      idempotencyKey?: string | null;
    } = {},
  ) {
    super(message, {
      status: options.status ?? 0,
      code: "payment_outcome_unknown",
    });
    this.name = "GenesisPayPaymentOutcomeUnknownError";
    this.payment = options.payment ?? null;
    this.paymentId = options.paymentId ?? options.payment?.id ?? null;
    this.idempotencyKey = options.idempotencyKey ?? null;
  }
}

/**
 * The server confirmed it: the authorization was delivered to the resource and
 * its outcome is unknown.
 *
 * The subclass exists so a caller can tell "the server told us it is unresolved
 * and here is the row" from "we never heard back at all" — but both are
 * `GenesisPayPaymentOutcomeUnknownError`, and code that decides whether to retry
 * should branch on the parent.
 */
export class GenesisPayUnresolvedPaymentError extends GenesisPayPaymentOutcomeUnknownError {
  declare readonly payment: AgentPaymentRecord;

  constructor(
    message: string,
    options: { payment: AgentPaymentRecord; idempotencyKey?: string | null },
  ) {
    super(message, {
      status: 502,
      payment: options.payment,
      idempotencyKey: options.idempotencyKey ?? null,
    });
    this.name = "GenesisPayUnresolvedPaymentError";
  }
}

/**
 * A payment for this `idempotencyKey` already exists, so this request did not
 * create a second one — which is the mechanism working, not a fault.
 *
 * `paymentId` names the original so the caller can read it with
 * `paymentStatus()` instead of minting a new key, which would be a second debit.
 */
export class GenesisPayDuplicatePaymentError extends GenesisPayApiError {
  readonly paymentId: string | null;
  readonly payment: AgentPaymentRecord | null;

  constructor(
    message: string,
    options: {
      paymentId?: string | null;
      payment?: AgentPaymentRecord | null;
    } = {},
  ) {
    super(message, { status: 409, code: "payment_already_requested" });
    this.name = "GenesisPayDuplicatePaymentError";
    this.paymentId = options.paymentId ?? options.payment?.id ?? null;
    this.payment = options.payment ?? null;
  }
}

/**
 * The human decision (approve/deny) did not arrive within the wait window.
 *
 * Only ever thrown for a payment still sitting at `pending_approval`, where
 * "nothing has moved, the approval URL is still live" is true. A payment that
 * reached `executing` has passed the caps and may already have signed, so it
 * gets `GenesisPayPaymentOutcomeUnknownError` instead — saying "still pending"
 * there would read as *no money moved*, which is the one thing we do not know.
 */
export class GenesisPayApprovalTimeoutError extends GenesisPayApiError {
  readonly payment: AgentPaymentRecord;
  readonly approvalUrl: string | null;

  constructor(payment: AgentPaymentRecord, approvalUrl: string | null) {
    super(
      `Timed out waiting for human approval of payment ${payment.id}. ` +
        "The payment is still pending — surface the approval URL to the user " +
        "and check again later with paymentStatus().",
      { status: 0, code: "approval_timeout" },
    );
    this.name = "GenesisPayApprovalTimeoutError";
    this.payment = payment;
    this.approvalUrl = approvalUrl;
  }
}

/** The payment was denied or its approval window expired. */
export class GenesisPayApprovalRejectedError extends GenesisPayApiError {
  readonly payment: AgentPaymentRecord;

  constructor(payment: AgentPaymentRecord) {
    super(
      payment.status === "denied"
        ? `Payment ${payment.id} was denied by the account owner.`
        : `Payment ${payment.id} expired before it was approved.`,
      { status: 0, code: "approval_rejected" },
    );
    this.name = "GenesisPayApprovalRejectedError";
    this.payment = payment;
  }
}
