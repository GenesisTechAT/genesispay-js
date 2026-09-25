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
  GenesisPayIdempotencyConflictError,
  GenesisPayOutcomeWaitTimeoutError,
  GenesisPayUnresolvedPaymentError,
} from "./errors.js";
import { AgentPaymentResult } from "./payment-result.js";
import { preparePurchaseRequest, purchaseEchoMismatch } from "./purchase-request.js";
import {
  accountResponseSchema,
  apiErrorBodySchema,
  discoveredShopSchema,
  discoveryResponseSchema,
  failedPayResponseSchema,
  paymentStatusResponseSchema,
  shopsResponseSchema,
  strictAgentPayResponseSchema,
  trendingProductSchema,
  trendingResponseSchema,
  settledPayResponseSchema,
  duplicatePayResponseSchema,
  unresolvedPayResponseSchema,
} from "./schemas.js";
import type {
  AgentAccountInfo,
  AgentHttpResponseCapture,
  AgentPaymentRecord,
  DiscoveredService,
  DiscoveredShop,
  DiscoverOptions,
  PayOptions,
  ShopsOptions,
  TrendingOptions,
  TrendingProduct,
  WaitForApprovalOptions,
  WaitForOutcomeOptions,
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

const DEFAULT_OUTCOME_TIMEOUT_MS = 30_000;
const DEFAULT_OUTCOME_POLL_INTERVAL_MS = 2_000;
// The server makes an on-demand chain check for an unresolved row at most once
// per 10 s, so polling faster than that past the first few reads buys nothing.
const MAX_OUTCOME_POLL_INTERVAL_MS = 10_000;

/** Statuses `waitForOutcome` waits through: accepted, not yet confirmed. */
const OUTCOME_PENDING_STATUSES = new Set(["unresolved", "approved", "executing"]);

/** What a status poll cannot see, carried over from the pay envelope. */
type OutcomeContext = {
  paymentId: string;
  payment: AgentPaymentRecord;
  replayed: boolean;
  response: AgentHttpResponseCapture | null;
  requestMethod: string | null;
  bodySha256: string | null;
};

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
   *
   * `method: "POST"` with `body` buys a body-priced API with that exact body;
   * the result is trusted only when the server echoes the method and the
   * body's SHA-256. `waitForOutcome` waits, bounded and read-only, for a payment
   * the server accepted but has not confirmed yet.
   */
  async pay(url: string, options: PayOptions): Promise<AgentPaymentResult> {
    const idempotencyKey = typeof options?.idempotencyKey === "string" ? options.idempotencyKey.trim() : "";
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new GenesisPayPaymentRejectedError("Save a nonblank idempotencyKey of at most 200 characters before calling pay().", {
        status: 0, code: "idempotency_key_required",
      });
    }
    try {
      return await this.paySavedRequest(url, options, idempotencyKey);
    } catch (error) {
      if (error instanceof GenesisPayApiError) error.idempotencyKey = idempotencyKey;
      throw error;
    }
  }

  private async paySavedRequest(url: string, options: PayOptions, idempotencyKey: string): Promise<AgentPaymentResult> {
    // Both refuse locally, before anything is sent.
    const purchase = await preparePurchaseRequest(options);
    const outcomeWait = normalizeOutcomeWait(options.waitForOutcome);

    const { status, body } = await this.request("POST", "/api/v2/agent/pay", {
      url, idempotencyKey,
      ...(options.maxAmountUsdc !== undefined && { maxAmountUsdc: String(options.maxAmountUsdc) }),
      ...(options.maxAmount !== undefined && { maxAmount: String(options.maxAmount) }),
      ...(options.asset !== undefined && { asset: options.asset }),
      ...(options.description !== undefined && { description: options.description }),
      // A GET sends none of these, so its wire shape — and its fingerprint on
      // the server (MR-307) — is exactly the pre-body contract. The body string
      // goes in as-is; JSON.stringify escapes it and the server's parse returns
      // the identical string, which is what it hashes and re-sends.
      ...(purchase.method === "POST" && {
        method: purchase.method, contentType: purchase.contentType, body: purchase.body,
      }),
    }, { mayHaveCharged: true, idempotencyKey });

    if (status !== 200 && status !== 202) throw this.errorForResponse(status, body, { mayHaveCharged: true, idempotencyKey });
    const parsed = strictAgentPayResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.idempotencyKey !== idempotencyKey) {
      throw new GenesisPayPaymentOutcomeUnknownError("The server did not return a consistent v2 payment response. Retry only with the same key.", {
        status, idempotencyKey,
      });
    }
    const value = parsed.data;
    // Checked before ANY status is believed, including `failed`: an envelope
    // for a different request says nothing about the one this caller made.
    const mismatch = purchaseEchoMismatch(value, purchase);
    if (mismatch) {
      throw new GenesisPayPaymentOutcomeUnknownError(
        `GenesisPay did not confirm the purchase request this client sent: ${mismatch}. ` +
          "A GenesisPay deployment that predates POST purchases drops the method and body and buys the URL with GET, " +
          `so payment ${value.paymentId} (status "${value.status}") may be for a different request and may already have been charged. ` +
          "Check it with paymentStatus(); retry only with the same idempotencyKey, never a new one, and buy with a body only once the deployment confirms POST purchases.",
        { status, payment: value.payment, idempotencyKey },
      );
    }
    if (value.status === "settled") return new AgentPaymentResult({ ...value, status: "settled" });
    if (value.status === "pending_approval") {
      const result = new AgentPaymentResult({ ...value, status: "pending_approval" });
      if (!options.waitForApproval) return result;
      return this.waitForSettlement(value.paymentId, value.approvalUrl,
        normalizeWaitOptions(options.waitForApproval), idempotencyKey);
    }
    if (value.status === "failed") throw new GenesisPayPaymentFailedError(value.payment.failureReason ?? "The original payment failed.", {
      status, payment: value.payment,
    });
    if (value.status === "denied" || value.status === "expired") throw new GenesisPayApprovalRejectedError(value.payment);
    if (outcomeWait && OUTCOME_PENDING_STATUSES.has(value.status)) {
      return this.waitForOutcome({
        paymentId: value.paymentId, payment: value.payment, replayed: value.replayed, response: value.response,
        requestMethod: value.requestMethod ?? null, bodySha256: value.bodySha256 ?? null,
      }, outcomeWait, idempotencyKey);
    }
    if (value.status === "unresolved") throw new GenesisPayUnresolvedPaymentError(
      "The original payment outcome is unresolved. Keep the original key and poll paymentStatus().", { payment: value.payment, idempotencyKey });
    // Approved/executing and future states are not a new authority to execute or sign.
    throw new GenesisPayPaymentOutcomeUnknownError("The original payment is still processing. Poll paymentStatus(); do not create another purchase.", {
      status, payment: value.payment, idempotencyKey,
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
      return this.settledResult(body, money.idempotencyKey);
    }

    if (status === 202) {
      const retained = paymentStatusResponseSchema.safeParse(body);
      throw new GenesisPayPaymentOutcomeUnknownError(
        "Payment confirmation is pending. Poll paymentStatus(); do not create a new purchase.",
        { status, paymentId, idempotencyKey: money.idempotencyKey,
          payment: retained.success && retained.data.payment.id === paymentId ? retained.data.payment : null },
      );
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

  /**
   * Searches the public GenesisPay shop directory (no auth required). A shop's
   * `storefrontUrl` is for humans; to buy, find its products with `discover()`
   * and pass a listing's `resourceUrl` to `pay()`.
   *
   * Entries are parsed one by one and a malformed entry is dropped, so a field
   * the server adds or reshapes later cannot fail the whole search.
   */
  async shops(query = "", options: ShopsOptions = {}): Promise<DiscoveredShop[]> {
    const params = new URLSearchParams();
    const trimmedQuery = query.trim();

    if (trimmedQuery) {
      params.set("q", trimmedQuery);
    }

    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }

    const queryString = params.toString();
    const { status, body } = await this.request(
      "GET",
      `/api/v1/discovery/shops${queryString ? `?${queryString}` : ""}`,
    );

    if (status === 200) {
      return parseWith(shopsResponseSchema, body).shops.flatMap((entry) => {
        const shop = discoveredShopSchema.safeParse(entry);
        return shop.success ? [shop.data] : [];
      });
    }

    throw this.errorForResponse(status, body);
  }

  /**
   * What is trending on GenesisPay right now (no auth required): listed
   * products ranked by distinct buyers of paid orders in the last 7 days, then
   * newest listed. Each
   * product's `signal` says which basis ranked it. Pass a product's
   * `resourceUrl` to `pay()`.
   *
   * Entries are parsed one by one and a malformed entry is dropped, so a field
   * the server adds or reshapes later cannot fail the whole read.
   */
  async trending(options: TrendingOptions = {}): Promise<TrendingProduct[]> {
    const params = new URLSearchParams();

    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }

    const queryString = params.toString();
    const { status, body } = await this.request(
      "GET",
      `/api/v1/discovery/trending${queryString ? `?${queryString}` : ""}`,
    );

    if (status === 200) {
      return parseWith(trendingResponseSchema, body).products.flatMap((entry) => {
        const product = trendingProductSchema.safeParse(entry);
        return product.success ? [product.data] : [];
      });
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

  /**
   * The bounded, read-only wait behind `pay({ waitForOutcome })`.
   *
   * Only `paymentStatus()` is called. An `approved` row is being executed by
   * the server (MR-503) — calling `executePayment()` here would race that
   * execution — so it is waited through like `executing` and `unresolved`.
   * Running out of budget is `GenesisPayOutcomeWaitTimeoutError`, never
   * `GenesisPayPaymentFailedError`: not confirmed yet is not failed (MR-306).
   */
  private async waitForOutcome(
    context: OutcomeContext,
    wait: Required<WaitForOutcomeOptions>,
    idempotencyKey: string,
  ): Promise<AgentPaymentResult> {
    const startedAt = Date.now();
    const deadline = startedAt + wait.timeoutMs;
    let lastSeen = context.payment;
    let delay = wait.pollIntervalMs;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
        throw new GenesisPayOutcomeWaitTimeoutError(
          `Payment ${lastSeen.id} is not confirmed yet after waiting ${waitedSeconds} s (status "${lastSeen.status}"). ` +
            "It may already have been charged and may still settle — keep polling paymentStatus() with this paymentId " +
            "and never buy it again with a new idempotencyKey.",
          { payment: lastSeen, idempotencyKey, waitedMs: Date.now() - startedAt },
        );
      }
      // The last sleep is cut to the deadline, so the final poll lands on it.
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, MAX_OUTCOME_POLL_INTERVAL_MS);

      let payment: AgentPaymentRecord;
      try {
        payment = await this.paymentStatus(context.paymentId);
      } catch (error) {
        // A dropped poll or a 5xx/429 is a blip in watching, not news about the
        // payment: keep waiting within the budget.
        if (isTransientReadError(error)) continue;
        throw new GenesisPayPaymentOutcomeUnknownError(
          `Lost track of payment ${context.paymentId} while waiting for its outcome (last seen "${lastSeen.status}"): ${describeError(error)}. ` +
            "It may already have been charged — check paymentStatus() and retry only with the same idempotencyKey.",
          { payment: lastSeen, idempotencyKey },
        );
      }
      lastSeen = payment;

      switch (payment.status) {
        case "settled":
          return new AgentPaymentResult({
            paymentId: payment.id,
            status: "settled",
            payment,
            txHash: payment.txHash,
            // Whatever the resource answered with its acceptance (null on a
            // replay); a status poll never fetches the resource again.
            response: context.response,
            replayed: context.replayed,
            requestMethod: context.requestMethod,
            bodySha256: context.bodySha256,
            idempotencyKey,
          });
        case "failed":
          throw new GenesisPayPaymentFailedError(
            payment.failureReason ?? `Payment ${payment.id} failed.`,
            { status: 0, payment },
          );
        case "denied":
        case "expired":
          throw new GenesisPayApprovalRejectedError(payment);
        case "unresolved":
        case "approved":
        case "executing":
        case "pending_approval":
          break;
        default:
          // Same reasoning as in waitForSettlement: an unknown state may be charged.
          throw new GenesisPayUnresolvedPaymentError(
            `Payment ${payment.id} is in a state this SDK does not recognise ("${payment.status}"), so whether it was charged is unknown. Upgrade @genesis-tech/genesispay-agent; retry only with the same idempotencyKey.`,
            { payment, idempotencyKey },
          );
      }
    }
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
            idempotencyKey,
          });
        case "approved": {
          try {
            return await this.executePayment(paymentId, { idempotencyKey });
          } catch (error) {
            // Another executor (e.g. the dashboard approval flow) claimed the
            // payment; keep polling until it resolves.
            if (error instanceof GenesisPayApiError && (error.status === 409 || error.status === 202)) {
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

  private settledResult(body: unknown, idempotencyKey: string | null = null): AgentPaymentResult {
    const parsed = parseWith(settledPayResponseSchema, body);

    return new AgentPaymentResult({
      paymentId: parsed.paymentId,
      status: "settled",
      payment: parsed.payment,
      txHash: parsed.txHash,
      response: parsed.response ?? null,
      idempotencyKey,
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
    if (status === 409 && parsedErrorFirst.success && parsedErrorFirst.data.code === "idempotency_conflict") {
      const original = paymentStatusResponseSchema.safeParse(body);
      return new GenesisPayIdempotencyConflictError(parsedErrorFirst.data.error, {
        payment: original.success ? original.data.payment : null,
      });
    }

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
        { payment: unresolved.data.payment, idempotencyKey: money?.idempotencyKey },
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

/** `undefined`/`false` is off. Invalid numbers are refused before anything is sent. */
function normalizeOutcomeWait(
  waitForOutcome: boolean | WaitForOutcomeOptions | undefined,
): Required<WaitForOutcomeOptions> | null {
  if (!waitForOutcome) return null;
  const options = waitForOutcome === true ? {} : waitForOutcome;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_OUTCOME_POLL_INTERVAL_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new GenesisPayPaymentRejectedError(
      "waitForOutcome needs a finite timeoutMs >= 0 and a finite pollIntervalMs > 0.",
      { status: 0, code: "invalid_request" },
    );
  }

  return { timeoutMs, pollIntervalMs };
}

/** A status read that failed for a reason unrelated to the payment itself. */
function isTransientReadError(error: unknown): boolean {
  return (
    error instanceof GenesisPayApiError &&
    !(error instanceof GenesisPayAuthError) &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  );
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
