import type { z } from "zod";

import {
  PeerPayApiError,
  PeerPayApprovalRejectedError,
  PeerPayApprovalTimeoutError,
  PeerPayAuthError,
  PeerPayPaymentFailedError,
  PeerPayPaymentRejectedError,
  PeerPayPolicyBlockedError,
} from "./errors.js";
import { AgentPaymentResult } from "./payment-result.js";
import {
  accountResponseSchema,
  apiErrorBodySchema,
  discoveryResponseSchema,
  failedPayResponseSchema,
  paymentStatusResponseSchema,
  pendingApprovalPayResponseSchema,
  settledPayResponseSchema,
} from "./schemas.js";
import type {
  AgentAccountInfo,
  AgentPaymentRecord,
  DiscoveredService,
  DiscoverOptions,
  PayOptions,
  WaitForApprovalOptions,
} from "./types.js";

export type PeerPayAgentConfig = {
  /** Agent API key ("pp_ag_..."). Defaults to env PEERPAY_AGENT_KEY. */
  apiKey?: string;
  /** PeerPay base URL, e.g. "https://peerpay.example". Defaults to env PEERPAY_BASE_URL. */
  baseUrl?: string;
  /** Override for testing; defaults to global fetch. */
  fetchFn?: typeof fetch;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class PeerPayAgent {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: PeerPayAgentConfig = {}) {
    const apiKey = config.apiKey?.trim() || readEnv("PEERPAY_AGENT_KEY");
    if (!apiKey) {
      throw new Error(
        "PeerPayAgent requires an agent API key (pp_ag_...): pass { apiKey } or set PEERPAY_AGENT_KEY.",
      );
    }

    const baseUrl = config.baseUrl?.trim() || readEnv("PEERPAY_BASE_URL");
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      throw new Error(
        "PeerPayAgent requires the PeerPay base URL (e.g. https://peerpay.example): pass { baseUrl } or set PEERPAY_BASE_URL.",
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Pays for an x402-gated URL through the PeerPay Agent API.
   *
   * Returns a settled result (with `body()`/`json()` accessors) when the
   * account's spending policy auto-approves the payment. When human approval
   * is required, returns a `pending_approval` result carrying the approval
   * URL — unless `waitForApproval` is set, in which case the client polls the
   * payment and executes it once approved.
   */
  async pay(url: string, options: PayOptions = {}): Promise<AgentPaymentResult> {
    const { status, body } = await this.request("POST", "/api/v1/agent/pay", {
      url,
      ...(options.maxAmountUsdc !== undefined && {
        maxAmountUsdc: String(options.maxAmountUsdc),
      }),
      ...(options.maxAmount !== undefined && {
        maxAmount: String(options.maxAmount),
      }),
      ...(options.asset !== undefined && { asset: options.asset }),
      ...(options.description !== undefined && { description: options.description }),
    });

    if (status === 200) {
      return this.settledResult(body);
    }

    if (status === 202) {
      const parsed = parseWith(pendingApprovalPayResponseSchema, body);
      const pendingResult = new AgentPaymentResult({
        paymentId: parsed.paymentId,
        status: "pending_approval",
        payment: parsed.payment,
        approvalUrl: parsed.approvalUrl ?? null,
      });

      if (!options.waitForApproval) {
        return pendingResult;
      }

      return this.waitForSettlement(
        parsed.paymentId,
        pendingResult.approvalUrl,
        normalizeWaitOptions(options.waitForApproval),
      );
    }

    throw this.errorForResponse(status, body);
  }

  /** Fetches the current state of an agent payment. */
  async paymentStatus(paymentId: string): Promise<AgentPaymentRecord> {
    const { status, body } = await this.request(
      "GET",
      `/api/v1/agent/payments/${encodeURIComponent(paymentId)}`,
    );

    if (status === 200) {
      return parseWith(paymentStatusResponseSchema, body).payment;
    }

    throw this.errorForResponse(status, body);
  }

  /**
   * Executes a payment that a human already approved on the dashboard.
   * Idempotent; returns a settled result on success.
   */
  async executePayment(paymentId: string): Promise<AgentPaymentResult> {
    const { status, body } = await this.request(
      "POST",
      `/api/v1/agent/payments/${encodeURIComponent(paymentId)}/execute`,
    );

    if (status === 200) {
      return this.settledResult(body);
    }

    throw this.errorForResponse(status, body);
  }

  /**
   * Searches the public PeerPay discovery directory for x402-payable
   * services (no auth required). Pass a result's `resourceUrl` to `pay()`.
   */
  async discover(
    query: string,
    options: DiscoverOptions = {},
  ): Promise<DiscoveredService[]> {
    const params = new URLSearchParams();
    const trimmedQuery = query.trim();

    if (trimmedQuery) {
      params.set("q", trimmedQuery);
    }

    if (options.category?.trim()) {
      params.set("category", options.category.trim());
    }

    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }

    const queryString = params.toString();
    const { status, body } = await this.request(
      "GET",
      `/api/v1/discovery${queryString ? `?${queryString}` : ""}`,
    );

    if (status === 200) {
      return parseWith(discoveryResponseSchema, body).listings;
    }

    throw this.errorForResponse(status, body);
  }

  /** Fetches the agent account snapshot (balance, policy, spend totals). */
  async account(): Promise<AgentAccountInfo> {
    const { status, body } = await this.request("GET", "/api/v1/agent/account");

    if (status === 200) {
      return parseWith(accountResponseSchema, body);
    }

    throw this.errorForResponse(status, body);
  }

  private async waitForSettlement(
    paymentId: string,
    approvalUrl: string | null,
    wait: Required<WaitForApprovalOptions>,
  ): Promise<AgentPaymentResult> {
    const deadline = Date.now() + wait.timeoutMs;

    for (;;) {
      const payment = await this.paymentStatus(paymentId);

      switch (payment.status) {
        case "settled":
          return new AgentPaymentResult({
            paymentId: payment.id,
            status: "settled",
            payment,
            txHash: payment.txHash,
          });
        case "approved": {
          try {
            return await this.executePayment(paymentId);
          } catch (error) {
            // Another executor (e.g. the dashboard approval flow) claimed the
            // payment; keep polling until it resolves.
            if (error instanceof PeerPayApiError && error.status === 409) {
              break;
            }
            throw error;
          }
        }
        case "denied":
        case "expired":
          throw new PeerPayApprovalRejectedError(payment);
        case "failed":
          throw new PeerPayPaymentFailedError(
            payment.failureReason ??
              `Payment ${payment.id} failed while executing.`,
            { status: 502, payment },
          );
        case "pending_approval":
        case "executing":
          break;
      }

      if (Date.now() + wait.pollIntervalMs > deadline) {
        throw new PeerPayApprovalTimeoutError(payment, approvalUrl);
      }

      await sleep(wait.pollIntervalMs);
    }
  }

  private settledResult(body: unknown): AgentPaymentResult {
    const parsed = parseWith(settledPayResponseSchema, body);

    return new AgentPaymentResult({
      paymentId: parsed.paymentId,
      status: "settled",
      payment: parsed.payment,
      txHash: parsed.txHash,
      response: parsed.response ?? null,
    });
  }

  private errorForResponse(status: number, body: unknown): Error {
    const failed = failedPayResponseSchema.safeParse(body);
    if (failed.success) {
      return new PeerPayPaymentFailedError(
        `Payment ${failed.data.paymentId} failed: ${failed.data.error}`,
        { status, payment: failed.data.payment },
      );
    }

    const parsedError = apiErrorBodySchema.safeParse(body);
    const message = parsedError.success
      ? parsedError.data.error
      : `PeerPay Agent API request failed with status ${status}.`;
    const code = parsedError.success ? (parsedError.data.code ?? null) : null;

    if (status === 401) {
      return new PeerPayAuthError(
        `${message} Check the agent API key (pp_ag_...) in PEERPAY_AGENT_KEY.`,
      );
    }

    if (status === 403) {
      return new PeerPayPolicyBlockedError(
        `${message} The account's spending policy blocked this payment — the account owner must update the allowlist on the PeerPay dashboard.`,
      );
    }

    if (status === 402 || status === 422) {
      return new PeerPayPaymentRejectedError(
        code === "amount_exceeds_max"
          ? `${message} Raise maxAmountUsdc or ask the account owner to adjust the spending policy.`
          : message,
        { status, code },
      );
    }

    return new PeerPayApiError(message, { status, code });
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new PeerPayApiError(
        `Failed to reach PeerPay at ${this.baseUrl}: ${describeError(error)}`,
        { status: 0, code: "network_error" },
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = undefined;
    }

    return { status: response.status, body: parsedBody };
  }
}

function normalizeWaitOptions(
  waitForApproval: boolean | WaitForApprovalOptions,
): Required<WaitForApprovalOptions> {
  const options = typeof waitForApproval === "boolean" ? {} : waitForApproval;

  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  };
}

function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new PeerPayApiError(
      `Unexpected PeerPay Agent API response shape: ${parsed.error.issues[0]?.message ?? "invalid payload"}.`,
      { status: 0, code: "invalid_response" },
    );
  }

  return parsed.data;
}

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }

  return process.env[name]?.trim() || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
