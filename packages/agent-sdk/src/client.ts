import type { z } from "zod";

import {
  GenesisPayApiError,
  GenesisPayApprovalRejectedError,
  GenesisPayApprovalTimeoutError,
  GenesisPayAuthError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
  GenesisPayPolicyBlockedError,
  GenesisPayDuplicatePaymentError,
  GenesisPayUnresolvedPaymentError,
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
  duplicatePayResponseSchema,
  unresolvedPayResponseSchema,
} from "./schemas.js";
import type {
  AgentAccountInfo,
  AgentPaymentRecord,
  DiscoveredService,
  DiscoverOptions,
  PayOptions,
  WaitForApprovalOptions,
} from "./types.js";

export type GenesisPayAgentConfig = {
  /** Agent API key ("gp_ag_..."). Defaults to env GENESISPAY_AGENT_KEY. */
  apiKey?: string;
  /** GenesisPay base URL, e.g. "https://genesispay.example". Defaults to env GENESISPAY_BASE_URL. */
  baseUrl?: string;
  /** Override for testing; defaults to global fetch. */
  fetchFn?: typeof fetch;
};

/**
 * Server rejection codes that are only ever emitted BEFORE a payment row is
 * inserted, so a response carrying one is proof nothing was signed — even when
 * its HTTP status is a 5xx.
 *
 * Mirrors `AgentPayRejectionCode` in the engine. Kept as a literal set rather
 * than imported because `packages/*` never import from `src/` (CLAUDE.md §3.2);
 * a code that disappears server-side simply stops matching, which fails toward
 * "unknown" rather than toward a false "nothing happened".
 */
const PRE_SIGNING_REJECTION_CODES = new Set([
  "invalid_url",
  "blocked_url",
  "target_unreachable",
  "payment_not_required",
  "unsupported_payment_requirement",
  "amount_exceeds_max",
  // 503: another payment for the same agent held the spend-cap section past its
  // lock timeout. The transaction rolled back, so no row and no signature — the
  // one thing that must not happen here is telling the caller it may have been
  // charged, because contention is reachable on an honest burst.
  "agent_busy",
]);

const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class GenesisPayAgent {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: GenesisPayAgentConfig = {}) {
    const apiKey = config.apiKey?.trim() || readEnv("GENESISPAY_AGENT_KEY");
    if (!apiKey) {
      throw new Error(
        "GenesisPayAgent requires an agent API key (gp_ag_...): pass { apiKey } or set GENESISPAY_AGENT_KEY.",
      );
    }

    const baseUrl = config.baseUrl?.trim() || readEnv("GENESISPAY_BASE_URL");
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      throw new Error(
        "GenesisPayAgent requires the GenesisPay base URL (e.g. https://genesispay.example): pass { baseUrl } or set GENESISPAY_BASE_URL.",
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Pays for an x402-gated URL through the GenesisPay Agent API.
   *
   * Returns a settled result (with `body()`/`json()` accessors) when the
   * account's spending policy auto-approves the payment. When human approval
   * is required, returns a `pending_approval` result carrying the approval
   * URL — unless `waitForApproval` is set, in which case the client polls the
   * payment and executes it once approved.
   */
  async pay(url: string, options: PayOptions = {}): Promise<AgentPaymentResult> {
    const idempotencyKey = options.idempotencyKey ?? null;
    const { status, body } = await this.request(
      "POST",
      "/api/v1/agent/pay",
      {
        url,
        ...(options.maxAmountUsdc !== undefined && {
          maxAmountUsdc: String(options.maxAmountUsdc),
        }),
        ...(options.maxAmount !== undefined && {
          maxAmount: String(options.maxAmount),
        }),
        ...(options.asset !== undefined && { asset: options.asset }),
        ...(options.description !== undefined && {
          description: options.description,
        }),
        ...(options.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      },
      { mayHaveCharged: true, idempotencyKey },
    );

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
        idempotencyKey,
      );
    }

    throw this.errorForResponse(status, body, {
      mayHaveCharged: true,
      idempotencyKey,
    });
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
  async executePayment(
    paymentId: string,
    options: { idempotencyKey?: string | null } = {},
  ): Promise<AgentPaymentResult> {
    // Both threaded through: this is the likeliest unknown-outcome moment in the
    // whole flow — the request is held open while the server signs and calls the
    // resource — and the error it raises tells the caller to "check with
    // paymentStatus() and reuse the same idempotencyKey". Raising it with both
    // fields null made that instruction impossible to follow, and the caller of
    // `pay()` never had the payment id to begin with.
    const money = {
      mayHaveCharged: true as const,
      idempotencyKey: options.idempotencyKey ?? null,
      paymentId,
    };
    const { status, body } = await this.request(
      "POST",
      `/api/v1/agent/payments/${encodeURIComponent(paymentId)}/execute`,
      undefined,
      money,
    );

    if (status === 200) {
      return this.settledResult(body);
    }

    throw this.errorForResponse(status, body, money);
  }

  /**
   * Searches the public GenesisPay discovery directory for x402-payable
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
    idempotencyKey: string | null,
  ): Promise<AgentPaymentResult> {
    const deadline = Date.now() + wait.timeoutMs;
    // What the last successful poll saw. Once a payment has left
    // `pending_approval` a signed authorization may exist, so a poll that then
    // fails to reach us is an unknown outcome — not the "nothing was at stake"
    // network error a read call would otherwise report.
    let lastSeenStatus: string = "pending_approval";

    for (;;) {
      let payment: AgentPaymentRecord;
      try {
        payment = await this.paymentStatus(paymentId);
      } catch (error) {
        if (
          error instanceof GenesisPayPaymentOutcomeUnknownError ||
          lastSeenStatus === "pending_approval"
        ) {
          throw error;
        }

        // The mirror of the transport case on `pay()`: the payment had already
        // moved past approval, so the resource may be holding an authorization
        // while we lost the ability to watch it. Carries the id, which a bare
        // network error did not — leaving the caller nothing to look up.
        throw new GenesisPayPaymentOutcomeUnknownError(
          `Lost track of payment ${paymentId} while it was being executed (last seen "${lastSeenStatus}"): ${describeError(error)}. ` +
            "Whether it was charged is unknown — check paymentStatus() and, if " +
            "you retry, reuse the same idempotencyKey.",
          { paymentId },
        );
      }

      lastSeenStatus = payment.status;

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
            return await this.executePayment(paymentId, { idempotencyKey });
          } catch (error) {
            // Another executor (e.g. the dashboard approval flow) claimed the
            // payment; keep polling until it resolves.
            if (error instanceof GenesisPayApiError && error.status === 409) {
              break;
            }
            throw error;
          }
        }
        case "denied":
        case "expired":
          throw new GenesisPayApprovalRejectedError(payment);
        case "failed":
          throw new GenesisPayPaymentFailedError(
            payment.failureReason ??
              `Payment ${payment.id} failed while executing.`,
            { status: 502, payment },
          );
        case "unresolved":
          // A resting state, not a step towards one — polling it would end in an
          // approval timeout telling the caller to go approve a payment already
          // handed to the resource. Its own error class because "may have been
          // charged" and "definitely was not" call for opposite retry decisions.
          throw new GenesisPayUnresolvedPaymentError(
            `Payment ${payment.id} was delivered to the resource but its outcome is unknown${
              payment.failureReason ? ` (${payment.failureReason})` : ""
            }. It may have been charged — retry only with the same idempotencyKey.`,
            { payment },
          );
        case "pending_approval":
        case "executing":
          break;
        default:
          // A status this SDK version predates. Unresolved, not failed: "I do
          // not recognise this state" is the definition of "may have been
          // charged", and `GenesisPayPaymentFailedError` documents the opposite —
          // so throwing that would tell every already-published client that the
          // first future status the server adds is safe to re-pay.
          throw new GenesisPayUnresolvedPaymentError(
            `Payment ${payment.id} is in a state this SDK does not recognise ("${payment.status}"), so whether it was charged is unknown. Upgrade @genesis-tech/genesispay-agent; retry only with the same idempotencyKey.`,
            { payment },
          );
      }

      if (Date.now() + wait.pollIntervalMs > deadline) {
        // Which timeout depends on what we timed out ON. `pending_approval`
        // genuinely means nothing moved and the approval URL is still live.
        // `executing` means the server already cleared the payment and may have
        // handed a signed authorization to the resource — reporting that as
        // "still pending, go approve it" reads as *no money moved*, which is
        // the one claim we cannot make.
        throw payment.status === "pending_approval"
          ? new GenesisPayApprovalTimeoutError(payment, approvalUrl)
          : new GenesisPayPaymentOutcomeUnknownError(
              `Timed out while payment ${payment.id} was still being executed (status "${payment.status}"). ` +
                "Whether it was charged is unknown — check paymentStatus() and, " +
                "if you retry, reuse the same idempotencyKey.",
              { payment },
            );
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

  private errorForResponse(
    status: number,
    body: unknown,
    money?: {
      mayHaveCharged: true;
      idempotencyKey: string | null;
      paymentId?: string | null;
    },
  ): Error {
    const parsedErrorFirst = apiErrorBodySchema.safeParse(body);

    // Checked BEFORE the outcome envelopes. A 409 names the ORIGINAL payment,
    // whose own status may be `failed` — and that body satisfies
    // `failedPayResponseSchema`, so parsing shapes in the other order reported
    // "your payment failed" for a duplicate that was never attempted, and the
    // documented `instanceof GenesisPayDuplicatePaymentError` recovery never fired.
    if (
      status === 409 &&
      parsedErrorFirst.success &&
      parsedErrorFirst.data.code === "payment_already_requested"
    ) {
      const duplicate = duplicatePayResponseSchema.safeParse(body);
      const original = duplicate.success ? duplicate.data : null;
      // A payment that failed BEFORE anything was signed moved no money, so a
      // fresh key is safe there and nowhere else.
      const nothingWasSigned = original?.paymentStatus === "failed";

      return new GenesisPayDuplicatePaymentError(
        `${parsedErrorFirst.data.error} ${
          nothingWasSigned
            ? "The original attempt failed before anything was signed, so retrying with a NEW idempotencyKey is safe."
            : "Read the original with paymentStatus(); retrying with a new idempotencyKey would pay again."
        }`,
        {
          paymentId: original?.paymentId ?? null,
          payment: original?.payment ?? null,
        },
      );
    }

    const unresolved = unresolvedPayResponseSchema.safeParse(body);
    if (unresolved.success) {
      return new GenesisPayUnresolvedPaymentError(
        `Payment ${unresolved.data.paymentId} was delivered to the resource but its outcome is unknown (${unresolved.data.error}). It may have been charged — retry only with the same idempotencyKey.`,
        { payment: unresolved.data.payment },
      );
    }

    const failed = failedPayResponseSchema.safeParse(body);
    if (failed.success) {
      return new GenesisPayPaymentFailedError(
        `Payment ${failed.data.paymentId} failed: ${failed.data.error}`,
        { status, payment: failed.data.payment },
      );
    }

    const parsedError = apiErrorBodySchema.safeParse(body);
    const message = parsedError.success
      ? parsedError.data.error
      : `GenesisPay Agent API request failed with status ${status}.`;
    const code = parsedError.success ? (parsedError.data.code ?? null) : null;

    if (status === 401) {
      return new GenesisPayAuthError(
        `${message} Check the agent API key (gp_ag_...) in GENESISPAY_AGENT_KEY.`,
      );
    }

    if (status === 403) {
      // The server's own message names the actual cause — a revoked delegation,
      // a revoked key, a paused account, or an allowlist miss. Appending "the
      // owner must update the allowlist" told the caller the wrong remedy for
      // three of those four, and overwrote a correct explanation with a guess.
      return new GenesisPayPolicyBlockedError(
        `${message} Only the account owner can change this, on the GenesisPay dashboard.`,
      );
    }

    if (status === 402 || status === 422) {
      return new GenesisPayPaymentRejectedError(
        code === "amount_exceeds_max"
          ? `${message} Raise maxAmountUsdc or ask the account owner to adjust the spending policy.`
          : message,
        { status, code },
      );
    }

    // A 5xx on a money path with no envelope we recognise — an HTML 502 from a
    // proxy, a gateway timeout, a body we could not parse. The server may have
    // signed and delivered before it broke, so "request failed" is a claim we
    // cannot make. Read endpoints keep the plain error: nothing was at stake.
    //
    // EXCEPT the codes the server only ever emits BEFORE a payment row exists.
    // `target_unreachable` is a 502 that means the seller's own endpoint did not
    // answer our 402 probe — no row, no signature, nothing to be unsure about —
    // and it is the single most common transient failure in the whole flow.
    // Reporting a flaky seller as "you may have been charged", with a null
    // paymentId to investigate and an instruction not to retry, is a false
    // alarm on the one signal that has to stay trustworthy.
    //
    // An allowlist, not "any code we recognise": `withApiErrorBoundary` answers
    // `500 internal_error` from anywhere in the handler, including after
    // signing, and that one is genuinely unknown.
    const isPreSigningRejection =
      code !== null && PRE_SIGNING_REJECTION_CODES.has(code);

    // The class that says what this is: rejected before any money moved. Two of
    // the six (`target_unreachable` 502, `invalid_url` 400) previously fell out
    // as a bare `GenesisPayApiError` while their four siblings from the same server
    // union came back typed, so a consumer branching on
    // `GenesisPayPaymentRejectedError` missed the most common failure in the flow.
    if (isPreSigningRejection) {
      return new GenesisPayPaymentRejectedError(
        code === "amount_exceeds_max"
          ? `${message} Raise maxAmountUsdc or ask the account owner to adjust the spending policy.`
          : message,
        { status, code },
      );
    }

    if (money && status >= 500) {
      return new GenesisPayPaymentOutcomeUnknownError(
        `${message} The payment may already have been charged — check with paymentStatus() and, if you retry, reuse the same idempotencyKey.`,
        {
          status,
          idempotencyKey: money.idempotencyKey,
          paymentId: money.paymentId ?? null,
        },
      );
    }

    return new GenesisPayApiError(message, { status, code });
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    /**
     * Set on the two calls that can emit a payment authorization. A lost
     * connection to a read endpoint is just a network error; a lost connection
     * to `pay` or `execute` is the single most likely unknown-outcome in
     * production, because the request is held open while the server signs and
     * calls the resource. Reporting that as `network_error` told an integrator
     * "the call did not go through" and their retry bought the thing twice.
     */
    money?: {
      mayHaveCharged: true;
      idempotencyKey: string | null;
      paymentId?: string | null;
    },
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
      if (money) {
        throw new GenesisPayPaymentOutcomeUnknownError(
          `Lost the connection to GenesisPay at ${this.baseUrl} while the payment was in flight: ${describeError(error)}. ` +
            "It may already have been charged — check with paymentStatus() and, " +
            "if you retry, reuse the same idempotencyKey.",
          {
            idempotencyKey: money.idempotencyKey,
            paymentId: money.paymentId ?? null,
          },
        );
      }

      throw new GenesisPayApiError(
        `Failed to reach GenesisPay at ${this.baseUrl}: ${describeError(error)}`,
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
    throw new GenesisPayApiError(
      `Unexpected GenesisPay Agent API response shape: ${parsed.error.issues[0]?.message ?? "invalid payload"}.`,
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
