import type { AgentHttpResponseCapture, AgentPaymentRecord } from "./types.js";

type PaymentResultInit = {
  idempotencyKey?: string | null;
  replayed?: boolean;
  paymentId: string;
  status: "settled" | "pending_approval";
  payment: AgentPaymentRecord;
  txHash?: string | null;
  approvalUrl?: string | null;
  response?: AgentHttpResponseCapture | null;
  requestMethod?: string | null;
  bodySha256?: string | null;
};

/**
 * Result of a pay/execute call. When `status` is `"settled"`, the paid
 * resource's response is available via `bytes()`, `body()`, and `json()`
 * (when it was captured in the same call).
 */
export class AgentPaymentResult {
  readonly idempotencyKey: string | null;
  readonly replayed: boolean;
  readonly paymentId: string;
  readonly status: "settled" | "pending_approval";
  readonly payment: AgentPaymentRecord;
  readonly txHash: string | null;
  /** Dashboard URL where a human can approve the payment (pending only). */
  readonly approvalUrl: string | null;
  /** Captured resource response; null when it was not captured. */
  readonly response: AgentHttpResponseCapture | null;
  /**
   * The purchase method the server confirmed (`"GET"`/`"POST"`); null when the
   * server predates the echo or the result came from a status poll.
   */
  readonly requestMethod: string | null;
  /** Hex SHA-256 of the POST body the server confirmed; null for GET. */
  readonly bodySha256: string | null;

  constructor(init: PaymentResultInit) {
    this.idempotencyKey = init.idempotencyKey ?? null;
    this.replayed = init.replayed ?? false;
    this.paymentId = init.paymentId;
    this.status = init.status;
    this.payment = init.payment;
    this.txHash = init.txHash ?? null;
    this.approvalUrl = init.approvalUrl ?? null;
    this.response = init.response ?? null;
    this.requestMethod = init.requestMethod ?? null;
    this.bodySha256 = init.bodySha256 ?? null;
  }

  get settled(): boolean {
    return this.status === "settled";
  }

  get pendingApproval(): boolean {
    return this.status === "pending_approval";
  }

  /** Raw bytes of the paid resource response. */
  bytes(): Uint8Array {
    const capture = this.requireCapture();
    const binary = atob(capture.bodyBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  /** The paid resource response body decoded as UTF-8 text. */
  body(): string {
    return new TextDecoder().decode(this.bytes());
  }

  /** The paid resource response body parsed as JSON. */
  json<T = unknown>(): T {
    return JSON.parse(this.body()) as T;
  }

  private requireCapture(): AgentHttpResponseCapture {
    if (this.status !== "settled") {
      throw new Error(
        `Payment ${this.paymentId} is ${this.payment.status}, not settled — ` +
          "there is no resource response to read yet.",
      );
    }

    if (!this.response) {
      throw new Error(
        `Payment ${this.paymentId} settled, but the resource response was not ` +
          "captured in this call (it may have been executed via the dashboard). " +
          "Recover delivery with the seller using the original payment identity; do not create another payment.",
      );
    }

    return this.response;
  }
}
