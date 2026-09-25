import { parseSettlementResponsePayload } from "@genesis-tech/genesispay-protocol";
import type { SettlementResponsePayload } from "@genesis-tech/genesispay-protocol";

import type {
  SettlementContext,
  SettlementVerification,
  PlanAwareVerifySettlement,
  PreparedSettlement,
} from "./payment-gate.js";

/**
 * Default GenesisPay app base URL — the public "development" facilitator. Used
 * when `facilitatorBaseUrl` is omitted so integrators don't have to configure a
 * URL in dev. Set `facilitatorBaseUrl` explicitly for production.
 *
 * The custom domain rather than the Railway-generated hostname: the generated
 * form encodes the service name and breaks when the service is renamed.
 */
export const DEFAULT_FACILITATOR_BASE_URL = "https://dev.genesispay.finance";

export type GenesisPaySettlementOptions = {
  /**
   * Base URL of the GenesisPay app, e.g. "https://genesispay.example". Defaults to
   * the public development facilitator (DEFAULT_FACILITATOR_BASE_URL) when
   * omitted; set it explicitly in production.
   */
  facilitatorBaseUrl?: string;
  /** GenesisPay seller API key ("gp_sk_..."). */
  apiKey: string;
  /** Override for testing; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Maximum time for preparation, a signed settlement request and any async polling. Defaults to 120 seconds. */
  settlementPollTimeoutMs?: number;
};

/**
 * Built-in settlement hook that forwards the PAYMENT-SIGNATURE payload to the
 * GenesisPay facilitator (`POST /api/v1/facilitator/settle`). GenesisPay broadcasts
 * the EIP-3009 authorization on-chain (or verifies a payer-provided txHash)
 * and verifies the USDC transfer before reporting success.
 */
export function genesisPaySettlement(
  options: GenesisPaySettlementOptions,
): PlanAwareVerifySettlement {
  const settleUrl = buildSettleUrl(
    options.facilitatorBaseUrl?.trim() || DEFAULT_FACILITATOR_BASE_URL,
  );
  const apiKey = options.apiKey?.trim();

  if (!apiKey) {
    throw new Error(
      "genesisPaySettlement requires a GenesisPay seller API key (gp_sk_...).",
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const settlementPollTimeoutMs = options.settlementPollTimeoutMs ?? 120_000;
  if (!Number.isFinite(settlementPollTimeoutMs) || settlementPollTimeoutMs <= 0) {
    throw new Error("settlementPollTimeoutMs must be greater than zero.");
  }

  const verify: PlanAwareVerifySettlement = async (
    context: SettlementContext,
  ): Promise<SettlementVerification> => {
    const { requirement } = context;
    const settlementDeadline = Date.now() + settlementPollTimeoutMs;
    const payerBroadcastHash = readHistoricalSettlementTransaction(
      context.payment,
    );

    let response: Response;
    let body: unknown;
    try {
      ({ response, body } = await requestBeforeDeadline(
        async (signal) => {
          const settlementResponse = await fetchFn(settleUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              ...(context.planId ? { planId: context.planId } : {}),
              paymentSignature: context.paymentSignatureHeader,
              requirement: {
                resource: requirement.resource,
                network: requirement.network,
                chainId: requirement.chainId,
                assetAddress: requirement.assetAddress,
                amountUsdcMinor: requirement.maxAmountRequired,
                payTo: requirement.payTo,
                description: requirement.description || undefined,
                maxTimeoutSeconds: requirement.maxTimeoutSeconds,
              },
            }),
            signal,
          });
          return {
            response: settlementResponse,
            body: await readJsonBody(settlementResponse),
          };
        },
        settlementDeadline,
      ));
    } catch (error) {
      const errorReason =
        `Failed to reach the GenesisPay facilitator: ${describeError(error)}`;
      return {
        ok: false,
        outcomeUnknown: true,
        errorReason,
        ...(payerBroadcastHash
          ? {
              settlement: payerBroadcastOutcomeUnknownSettlement({
                transactionHash: payerBroadcastHash,
                requirement,
                errorReason,
              }),
            }
          : {}),
      };
    }

    const settlement = tryParseSettlement(body);

    if (response.status === 200 && settlement?.success) {
      if (
        isExactVerifiedSynchronousSettlement(
          settlement,
          context,
          payerBroadcastHash,
        )
      ) {
        return { ok: true, settlement };
      }
      const errorReason =
        "GenesisPay facilitator returned success without exact verified settlement evidence.";
      const transactionHash = payerBroadcastHash ??
        (isTransactionHash(settlement.transaction) ? settlement.transaction : null);
      return {
        ok: false,
        outcomeUnknown: true,
        errorReason,
        ...(transactionHash
          ? {
              settlement: payerBroadcastOutcomeUnknownSettlement({
                transactionHash,
                requirement,
                errorReason,
              }),
            }
          : {}),
      };
    }
    if (response.status === 202) {
      const acceptance = parseSettlementAcceptance(
        body,
        settleUrl,
        context.planId,
      );
      if (!acceptance) {
        const errorReason =
          "GenesisPay facilitator returned an invalid async settlement acceptance.";
        return {
          ok: false,
          outcomeUnknown: true,
          errorReason,
          ...(payerBroadcastHash
            ? {
                settlement: payerBroadcastOutcomeUnknownSettlement({
                  transactionHash: payerBroadcastHash,
                  requirement,
                  errorReason,
                }),
              }
            : {}),
        };
      }
      const outcome = await pollSettlementStatus({
        acceptance,
        apiKey,
        fetchFn,
        timeoutDeadline: settlementDeadline,
      });
      if (!outcome.ok) {
        const transactionHash = outcome.txHash ?? payerBroadcastHash;
        if (!transactionHash) return outcome;
        return {
          ...outcome,
          outcomeUnknown: true,
          settlement: {
            success: false,
            transaction: transactionHash,
            network: requirement.network,
            amount: requirement.maxAmountRequired,
            errorReason: outcome.errorReason,
            extensions: {
              // A hash learned from the authenticated status endpoint has
              // server-verified authorization ownership. A payer-carried hash
              // is still indispensable reconciliation evidence, but remains
              // explicitly unverified until the server adopts it (MR-202).
              authorizationVerified: Boolean(outcome.txHash),
              settlementVerified: false,
              asyncSettlement: true,
            },
          },
        };
      }
      const payer = readPayer(context.payment);
      const confirmed: SettlementResponsePayload = {
        success: true,
        transaction: outcome.txHash,
        network: requirement.network,
        amount: requirement.maxAmountRequired,
        ...(payer ? { payer } : {}),
        extensions: {
          authorizationVerified: true,
          settlementVerified: true,
          asyncSettlement: true,
        },
      };
      return { ok: true, settlement: confirmed };
    }

    const errorReason =
      settlement?.errorReason ??
      readErrorMessage(body) ??
      `GenesisPay facilitator settlement failed with status ${response.status}.`;
    const outcomeSettlement = settlement ??
      (payerBroadcastHash
        ? payerBroadcastOutcomeUnknownSettlement({
            transactionHash: payerBroadcastHash,
            requirement,
            errorReason,
          })
        : undefined);
    return {
      ok: false,
      ...(response.status >= 500 ||
      response.ok ||
      Boolean(settlement?.transaction) ||
      payerBroadcastHash
        ? { outcomeUnknown: true as const }
        : {}),
      errorReason,
      ...(outcomeSettlement ? { settlement: outcomeSettlement } : {}),
    };
  };

  verify.prepare = async ({ payer, idempotencyKey, requirement, authority }) => {
    const prepareUrl = settleUrl.replace(
      /\/settle$/,
      "/settlement-plans",
    );
    const { response, body } = await requestBeforeDeadline(
      async (signal) => {
        const preparationResponse = await fetchFn(prepareUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            idempotencyKey:
              idempotencyKey ?? globalThis.crypto.randomUUID(),
            payer,
            ...(authority ? { authority } : {}),
            requirement: {
              resource: requirement.resource,
              network: requirement.network,
              chainId: requirement.chainId,
              assetAddress: requirement.assetAddress,
              amountUsdcMinor: requirement.maxAmountRequired,
              payTo: requirement.payTo,
              description: requirement.description || undefined,
              maxTimeoutSeconds: requirement.maxTimeoutSeconds,
            },
          }),
          signal,
        });
        return {
          response: preparationResponse,
          body: await readJsonBody(preparationResponse),
        };
      },
      Date.now() + settlementPollTimeoutMs,
    );
    if (!response.ok) {
      throw new Error(
        readErrorMessage(body) ??
          `GenesisPay facilitator preparation failed with status ${response.status}.`,
      );
    }
    return parsePreparedSettlement(body);
  };

  return verify;
}

function readHistoricalSettlementTransaction(
  payment: SettlementContext["payment"],
): `0x${string}` | null {
  for (const key of ["txHash", "transaction", "transactionHash"] as const) {
    const value = payment.extensions?.[key];
    if (isTransactionHash(value)) {
      return value as `0x${string}`;
    }
  }
  return null;
}

function isExactVerifiedSynchronousSettlement(
  settlement: SettlementResponsePayload,
  context: SettlementContext,
  expectedTransactionHash: `0x${string}` | null,
): boolean {
  if (
    !isTransactionHash(settlement.transaction) ||
    (expectedTransactionHash !== null &&
      settlement.transaction.toLowerCase() !== expectedTransactionHash.toLowerCase()) ||
    settlement.network !== context.requirement.network ||
    settlement.amount !== context.requirement.maxAmountRequired ||
    settlement.extensions?.authorizationVerified !== true ||
    settlement.extensions?.settlementVerified !== true
  ) {
    return false;
  }
  const payer = readPayer(context.payment);
  return !payer || settlement.payer?.toLowerCase() === payer.toLowerCase();
}

function isTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function payerBroadcastOutcomeUnknownSettlement(input: {
  transactionHash: `0x${string}`;
  requirement: SettlementContext["requirement"];
  errorReason: string;
}): SettlementResponsePayload {
  return {
    success: false,
    transaction: input.transactionHash,
    network: input.requirement.network,
    amount: input.requirement.maxAmountRequired,
    errorReason: input.errorReason,
    extensions: {
      authorizationVerified: false,
      settlementVerified: false,
    },
  };
}

type SettlementAcceptance = {
  planId: string;
  statusUrl: string;
  expiresAtMs: number;
  pollAfterMs: number;
};

function parseSettlementAcceptance(
  body: unknown,
  settleUrl: string,
  expectedPlanId: string | undefined,
): SettlementAcceptance | null {
  if (
    !expectedPlanId ||
    typeof body !== "object" ||
    body === null ||
    !("version" in body) ||
    body.version !== 1 ||
    !("planId" in body) ||
    body.planId !== expectedPlanId ||
    !("state" in body) ||
    body.state !== "queued" ||
    !("statusUrl" in body) ||
    typeof body.statusUrl !== "string" ||
    !("expiresAt" in body) ||
    typeof body.expiresAt !== "string" ||
    !("pollAfterMs" in body) ||
    typeof body.pollAfterMs !== "number"
  ) {
    return null;
  }
  try {
    const statusUrl = new URL(body.statusUrl);
    const expectedStatusUrl = new URL(settleUrl);
    expectedStatusUrl.pathname = expectedStatusUrl.pathname.replace(
      /\/settle$/,
      `/settlements/${encodeURIComponent(expectedPlanId)}`,
    );
    if (statusUrl.href !== expectedStatusUrl.href) return null;
    const expiresAtMs = Date.parse(body.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return null;
    return {
      planId: expectedPlanId,
      statusUrl: statusUrl.href,
      expiresAtMs,
      pollAfterMs: Math.min(Math.max(Math.floor(body.pollAfterMs), 100), 2_000),
    };
  } catch {
    return null;
  }
}

async function pollSettlementStatus(input: {
  acceptance: SettlementAcceptance;
  apiKey: string;
  fetchFn: typeof fetch;
  timeoutDeadline: number;
}): Promise<
  | { ok: true; txHash: `0x${string}` }
  | {
      ok: false;
      errorReason: string;
      txHash?: `0x${string}`;
      outcomeUnknown?: true;
    }
> {
  const timeoutDeadline = input.timeoutDeadline;
  let submittedTxHash: `0x${string}` | null = null;
  const outcomeUnknown = (errorReason: string) => ({
    ok: false as const,
    outcomeUnknown: true as const,
    ...(submittedTxHash ? { txHash: submittedTxHash } : {}),
    errorReason,
  });
  let deadline = Math.min(input.acceptance.expiresAtMs, timeoutDeadline);
  // An idempotent replay can return an acceptance whose issuance window has
  // already elapsed even though its durable status is submitted or settled.
  // Poll that status once, then keep polling only inside the applicable bound.
  let firstPoll = true;
  while (firstPoll || Date.now() < deadline) {
    const replayRead = firstPoll;
    firstPoll = false;
    let response: Response;
    let body: unknown;
    try {
      ({ response, body } = await requestBeforeDeadline(
        async (signal) => {
          const statusResponse = await input.fetchFn(
            input.acceptance.statusUrl,
            {
              headers: { Authorization: `Bearer ${input.apiKey}` },
              cache: "no-store",
              signal,
            },
          );
          return {
            response: statusResponse,
            body: await readJsonBody(statusResponse),
          };
        },
        replayRead && deadline <= Date.now() ? timeoutDeadline : deadline,
      ));
    } catch (error) {
      return outcomeUnknown(
        `Failed to poll GenesisPay settlement: ${describeError(error)}`,
      );
    }
    if (!response.ok) {
      return outcomeUnknown(
          readErrorMessage(body) ??
          `GenesisPay settlement status failed with status ${response.status}.`,
      );
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("state" in body) ||
      !("version" in body) ||
      body.version !== 1 ||
      !("planId" in body) ||
      body.planId !== input.acceptance.planId
    ) {
      return outcomeUnknown(
        "GenesisPay returned settlement status for an invalid plan contract.",
      );
    }
    if (
      body.state === "settled" &&
      "txHash" in body &&
      typeof body.txHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(body.txHash) &&
      "sellerTransferVerified" in body &&
      body.sellerTransferVerified === true
    ) {
      return { ok: true, txHash: body.txHash as `0x${string}` };
    }
    if (body.state === "failed" || body.state === "expired") {
      if (submittedTxHash) {
        return outcomeUnknown(
          `GenesisPay reported ${body.state} after transaction ${submittedTxHash} was submitted. Do not initiate another payment; continue reconciliation with the same plan.`,
        );
      }
      return {
        ok: false,
        errorReason: `GenesisPay async settlement ${body.state}.`,
      };
    }
    if (body.state !== "queued" && body.state !== "submitted") {
      return outcomeUnknown("GenesisPay returned an invalid settlement state.");
    }
    if (body.state === "submitted") {
      if (
        "txHash" in body &&
        typeof body.txHash === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(body.txHash)
      ) {
        const candidate = body.txHash as `0x${string}`;
        if (
          submittedTxHash &&
          submittedTxHash.toLowerCase() !== candidate.toLowerCase()
        ) {
          return outcomeUnknown(
            "GenesisPay returned conflicting submitted transaction evidence. Do not initiate another payment; continue reconciliation with the same plan.",
          );
        }
        submittedTxHash = candidate;
        // Queue expiry ends untouched work, but an observed transaction must
        // continue reconciliation for the caller's full polling budget.
        deadline = timeoutDeadline;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(input.acceptance.pollAfterMs, remainingMs));
  }
  return outcomeUnknown(
    submittedTxHash
      ? `GenesisPay transaction ${submittedTxHash} is submitted but still pending. Do not initiate another payment; continue reconciliation with the same plan.`
      : "GenesisPay async settlement is still pending.",
  );
}

function readPayer(payment: unknown): `0x${string}` | null {
  if (typeof payment !== "object" || payment === null || !("payload" in payment)) {
    return null;
  }
  const payload = payment.payload;
  if (typeof payload !== "object" || payload === null || !("authorization" in payload)) {
    return null;
  }
  const authorization = payload.authorization;
  if (
    typeof authorization !== "object" ||
    authorization === null ||
    !("from" in authorization) ||
    typeof authorization.from !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(authorization.from)
  ) {
    return null;
  }
  return authorization.from as `0x${string}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestBeforeDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error("settlement polling deadline exceeded");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("settlement polling deadline exceeded"));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parsePreparedSettlement(body: unknown): PreparedSettlement {
  if (
    typeof body !== "object" ||
    body === null ||
    !("planId" in body) ||
    typeof body.planId !== "string" ||
    !("authorization" in body) ||
    typeof body.authorization !== "object" ||
    body.authorization === null
  ) {
    throw new Error("GenesisPay facilitator returned an invalid settlement plan.");
  }
  const authorization = body.authorization as Record<string, unknown>;
  const required = ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const;
  if (required.some((field) => typeof authorization[field] !== "string")) {
    throw new Error("GenesisPay facilitator returned an invalid authorization.");
  }
  return {
    settlementPlan: {
      planId: body.planId,
      sellerAuthorization: authorization as PreparedSettlement["settlementPlan"]["sellerAuthorization"],
      feeAuthorization: null,
    },
  };
}

function buildSettleUrl(facilitatorBaseUrl: string): string {
  const trimmed = facilitatorBaseUrl?.trim().replace(/\/+$/, "");

  if (!trimmed || !/^https?:\/\//.test(trimmed)) {
    throw new Error(
      `Invalid facilitatorBaseUrl "${String(facilitatorBaseUrl)}": expected an http(s) URL like "https://genesispay.example".`,
    );
  }

  return `${trimmed}/api/v1/facilitator/settle`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function tryParseSettlement(body: unknown): SettlementResponsePayload | undefined {
  try {
    return parseSettlementResponsePayload(body);
  } catch {
    return undefined;
  }
}

function readErrorMessage(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }

  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
