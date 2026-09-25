import {
  GENESISPAY_SETTLEMENT_PREPARE_HEADER,
  GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  buildPaymentRequiredPayload,
  decodePaymentSignatureHeader,
  decodeSettlementPrepareParamsHeader,
  encodePaymentRequiredHeader,
  encodeSettlementResponseHeader,
  validatePaymentSignatureAgainstRequirement,
} from "@genesis-tech/genesispay-protocol";
import type {
  EvmAddress,
  PaymentAccept,
  PaymentRequiredPayload,
  PaymentSignaturePayload,
  SettlementResponsePayload,
} from "@genesis-tech/genesispay-protocol";
import { getAddress, isAddress } from "viem";

import { resolvePaymentGateNetwork } from "./networks.js";
import type { PaymentGateNetwork } from "./networks.js";
import { parseUsdcAmountToMinorUnits } from "./usdc-amount.js";

export type PaymentGateConfig = {
  /** Human-readable decimal USDC amount, e.g. "0.10". */
  amountUsdc: string;
  /** Wallet that receives the USDC payment. */
  payTo: string;
  /** Shown to payers in the PAYMENT-REQUIRED payload. */
  description?: string;
  /** Defaults to "base-sepolia". */
  network?: PaymentGateNetwork;
  /**
   * Canonical resource URL advertised in PAYMENT-REQUIRED. Defaults to the
   * incoming request URL (origin + pathname, query stripped).
   */
  resource?: string;
  /** MIME type of the paid resource. Defaults to "application/json". */
  mimeType?: string;
  /** Payment authorization validity window advertised to payers. */
  maxTimeoutSeconds?: number;
  /**
   * EIP-712 domain (`name`/`version`) of the settlement asset contract,
   * advertised as the x402 `extra` field so generic clients sign with the
   * exact domain the contract's DOMAIN_SEPARATOR() uses (e.g. Base mainnet
   * USDC is { name: "USD Coin", version: "2" }). Omitted by default —
   * clients then fall back to the standard "USDC"/"2" domain.
   */
  eip712Domain?: { name: string; version: string };
};

/** Context handed to the settlement hook once a payment passed structural checks. */
export type SettlementContext = {
  request: Request;
  /** The raw PAYMENT-SIGNATURE header value, ready to forward to a facilitator. */
  paymentSignatureHeader: string;
  /** The decoded, structurally validated payment payload. */
  payment: PaymentSignaturePayload;
  /** The payment requirement this request must satisfy. */
  requirement: PaymentAccept;
  /** Persisted authority prepared before the payer signed. */
  planId?: string;
};

export type PreparedSettlement = {
  settlementPlan: {
    planId: string;
    sellerAuthorization: {
      from: EvmAddress;
      to: EvmAddress;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
    feeAuthorization: null;
  };
};

export type PreparedAuthorizationRequest = {
  sellerNonce: `0x${string}`;
  feeNonce: `0x${string}` | null;
  validBefore: string;
};

export type SettlementVerification =
  | { ok: true; settlement: SettlementResponsePayload }
  | {
      ok: false;
      errorReason: string;
      settlement?: SettlementResponsePayload;
      /** Signed authority may already be accepted or broadcast; never issue a fresh 402. */
      outcomeUnknown?: true;
    };

export type VerifySettlement = (
  context: SettlementContext,
) => Promise<SettlementVerification>;

export type PlanAwareVerifySettlement = VerifySettlement & {
  prepare?: (input: {
    payer: EvmAddress;
    idempotencyKey: string | null;
    requirement: PaymentAccept;
    authority?: PreparedAuthorizationRequest;
  }) => Promise<PreparedSettlement>;
};

export type WrapOptions = {
  verifySettlement: VerifySettlement;
};

type WrappableHandler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

export type PaymentGate = {
  /**
   * Wraps a Web-standard (Request) => Response handler. Works with Next.js
   * route handlers, Hono (`(c) => gated(c.req.raw)`), and Bun.serve.
   */
  wrap<Args extends unknown[]>(
    handler: WrappableHandler<Args>,
    options: WrapOptions,
  ): (request: Request, ...args: Args) => Promise<Response>;
  /** Builds the PAYMENT-REQUIRED requirement for a given resource URL. */
  requirementFor(resource: string): PaymentAccept;
};

export function createPaymentGate(config: PaymentGateConfig): PaymentGate {
  const network = resolvePaymentGateNetwork(config.network ?? "base-sepolia");
  const amountUsdcMinor = parseUsdcAmountToMinorUnits(config.amountUsdc);
  const payTo = normalizePayToAddress(config.payTo);
  const description = config.description ?? "Payment required";

  function buildPayload(resource: string): PaymentRequiredPayload {
    return buildPaymentRequiredPayload({
      amount: config.amountUsdc.trim(),
      amountUsdcMinor,
      asset: "USDC",
      assetAddress: network.usdcAddress,
      chainId: network.chainId,
      network: network.network,
      destination: payTo,
      description,
      resource,
      mimeType: config.mimeType,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra: config.eip712Domain,
    });
  }

  function resolveResource(request: Request): string {
    if (config.resource) {
      return config.resource;
    }

    const url = new URL(request.url);
    return `${url.origin}${url.pathname}`;
  }

  return {
    requirementFor(resource: string): PaymentAccept {
      return buildPayload(resource).accepts[0];
    },

    wrap<Args extends unknown[]>(
      handler: WrappableHandler<Args>,
      options: WrapOptions,
    ) {
      if (typeof options?.verifySettlement !== "function") {
        throw new Error(
          "gate.wrap requires a verifySettlement hook — use genesisPaySettlement({ facilitatorBaseUrl, apiKey }) or provide your own.",
        );
      }

      return async (request: Request, ...args: Args): Promise<Response> => {
        const planAwareVerifier =
          options.verifySettlement as PlanAwareVerifySettlement;
        const payload = buildPayload(resolveResource(request));
        const paymentSignatureHeader = request.headers.get(
          PAYMENT_SIGNATURE_HEADER,
        );

        if (
          !paymentSignatureHeader?.trim() &&
          request.headers.get(GENESISPAY_SETTLEMENT_PREPARE_HEADER) === "1"
        ) {
          if (!planAwareVerifier.prepare) {
            return new Response(
              JSON.stringify({
                error: "This gate does not support settlement preparation.",
                code: "settlement_plan_required",
              }),
              { status: 426, headers: { "Content-Type": "application/json" } },
            );
          }
          const paramsHeader = request.headers.get(
            GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
          );
          const prepareParams =
            paramsHeader === null
              ? await readLegacyPrepareBody(request)
              : readPrepareParamsHeader(paramsHeader);
          if (!prepareParams.ok) return prepareParams.response;
          const { payer, idempotencyKey, authority } = prepareParams;
          try {
            const prepared = await planAwareVerifier.prepare({
              payer,
              idempotencyKey,
              requirement: payload.accepts[0],
              ...(authority ? { authority } : {}),
            });
            return Response.json(prepared, {
              status: 201,
              headers: { "Cache-Control": "no-store" },
            });
          } catch (error) {
            return new Response(
              JSON.stringify({ error: describeError(error), code: "settlement_prepare_failed" }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        if (!paymentSignatureHeader?.trim()) {
          return paymentRequiredResponse(
            payload,
            undefined,
            undefined,
            planAwareVerifier.prepare ? request.url : undefined,
          );
        }

        let payment: PaymentSignaturePayload;
        try {
          payment = decodePaymentSignatureHeader(paymentSignatureHeader);
        } catch (error) {
          return paymentRequiredResponse(payload, describeError(error));
        }

        const planId = request.headers.get("GENESISPAY-Settlement-Plan");
        if (
          planAwareVerifier.prepare &&
          !planId &&
          !hasHistoricalSettlementTransaction(payment)
        ) {
          return new Response(
            JSON.stringify({
              error: "Prepare a versioned settlement plan before signing.",
              code: "settlement_plan_required",
            }),
            { status: 426, headers: { "Content-Type": "application/json" } },
          );
        }

        let requirement = payload.accepts[0];
        const mismatch = validatePaymentSignatureAgainstRequirement(
          payment,
          requirement,
        );
        if (mismatch) {
          const transactionHash = getHistoricalSettlementTransaction(payment);
          const preparedReconciliationRequirement =
            transactionHash && planId && planAwareVerifier.prepare
              ? paymentRequirementForPreparedReconciliation(
                  payment,
                  requirement,
                )
              : null;
          if (preparedReconciliationRequirement) {
            // Only a plan-aware verifier may receive this payer-carried
            // snapshot: its prepare capability is the SDK contract that says
            // the downstream facilitator will revalidate it against immutable
            // server-side authority. A custom verifier without that capability
            // must never be handed payer-selected amount/destination fields.
            requirement = preparedReconciliationRequirement;
          } else if (transactionHash) {
            return settlementOutcomeUnknownResponse({
              ok: false,
              outcomeUnknown: true,
              errorReason:
                `${mismatch} The payer transaction may already be on-chain; do not initiate another payment.`,
              settlement: {
                success: false,
                transaction: transactionHash,
                network: requirement.network,
                amount: requirement.maxAmountRequired,
                errorReason: mismatch,
                extensions: {
                  authorizationVerified: false,
                  settlementVerified: false,
                },
              },
            });
          } else {
            return paymentRequiredResponse(payload, mismatch);
          }
        }

        let verification: SettlementVerification;
        try {
          verification = await options.verifySettlement({
            request,
            paymentSignatureHeader,
            payment,
            requirement,
            ...(planId ? { planId } : {}),
          });
        } catch (error) {
          const transactionHash = getHistoricalSettlementTransaction(payment);
          if (!transactionHash) throw error;
          const errorReason =
            "The settlement verifier failed after the payer transaction was supplied. Do not initiate another payment; retry reconciliation.";
          return settlementOutcomeUnknownResponse({
            ok: false,
            outcomeUnknown: true,
            errorReason,
            settlement: payerBroadcastOutcomeUnknownSettlement({
              transactionHash,
              requirement,
              errorReason,
            }),
          });
        }

        if (!verification.ok) {
          const transactionHash = getHistoricalSettlementTransaction(payment);
          if (verification.outcomeUnknown || transactionHash) {
            return settlementOutcomeUnknownResponse(
              transactionHash
                ? {
                    ...verification,
                    outcomeUnknown: true,
                    settlement: payerBroadcastOutcomeUnknownSettlement({
                      transactionHash,
                      requirement,
                      errorReason: verification.errorReason,
                      settlement: verification.settlement,
                    }),
                  }
                : verification,
            );
          }
          return paymentRequiredResponse(
            payload,
            verification.errorReason,
            verification.settlement,
          );
        }

        const response = await handler(request, ...args);
        return withSettlementHeader(response, verification.settlement);
      };
    },
  };
}

function settlementOutcomeUnknownResponse(
  verification: Extract<SettlementVerification, { ok: false }>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Retry-After": "1",
  });
  if (verification.settlement) {
    headers.set(
      PAYMENT_RESPONSE_HEADER,
      encodeSettlementResponseHeader(verification.settlement),
    );
  }
  return new Response(JSON.stringify({
    code: "settlement_outcome_unknown",
    error: verification.errorReason,
  }), { status: 503, headers });
}

type PrepareParamsResult =
  | {
      ok: true;
      payer: EvmAddress;
      idempotencyKey: string | null;
      authority: PreparedAuthorizationRequest | null;
    }
  | { ok: false; response: Response };

function invalidPrepareRequest(error: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error, code: "invalid_request" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

/**
 * Legacy preparation: the request BODY is the plan parameters. Kept unchanged
 * for clients that predate `GENESISPAY-Settlement-Prepare-Params`.
 */
async function readLegacyPrepareBody(request: Request): Promise<PrepareParamsResult> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const payer = readPreparePayer(body);
  if (!payer) return invalidPrepareRequest("A valid payer is required.");
  const idempotencyKey =
    typeof body === "object" &&
    body !== null &&
    "idempotencyKey" in body &&
    typeof body.idempotencyKey === "string"
      ? body.idempotencyKey
      : null;
  const authority = readPrepareAuthority(body);
  if (typeof body === "object" && body !== null && "authority" in body && !authority) {
    return invalidPrepareRequest("Prepared authority is invalid.");
  }
  return { ok: true, payer, idempotencyKey, authority };
}

/**
 * Header preparation (ADR-0083): the plan parameters travel in
 * `GENESISPAY-Settlement-Prepare-Params`, and the body is the purchase body.
 * This gate prices by configuration and binds no request fingerprint, so the
 * body stays opaque here and is never read; the resource URL alone scopes the
 * requirement. A present but malformed header is refused, never read as a body.
 */
function readPrepareParamsHeader(paramsHeader: string): PrepareParamsResult {
  const params = decodeSettlementPrepareParamsHeader(paramsHeader);
  if (!params) return invalidPrepareRequest("Invalid settlement preparation parameters.");
  return {
    ok: true,
    payer: params.payer,
    idempotencyKey: params.idempotencyKey,
    authority: params.authority ?? null,
  };
}

function readPrepareAuthority(body: unknown): PreparedAuthorizationRequest | null {
  if (typeof body !== "object" || body === null || !("authority" in body)) {
    return null;
  }
  const authority = body.authority;
  if (
    typeof authority !== "object" ||
    authority === null ||
    !("sellerNonce" in authority) ||
    typeof authority.sellerNonce !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(authority.sellerNonce) ||
    !("feeNonce" in authority) ||
    (authority.feeNonce !== null &&
      (typeof authority.feeNonce !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(authority.feeNonce))) ||
    !("validBefore" in authority) ||
    typeof authority.validBefore !== "string" ||
    !/^\d+$/.test(authority.validBefore)
  ) {
    return null;
  }
  return authority as PreparedAuthorizationRequest;
}

function hasHistoricalSettlementTransaction(
  payment: PaymentSignaturePayload,
): boolean {
  return getHistoricalSettlementTransaction(payment) !== null;
}

function getHistoricalSettlementTransaction(
  payment: PaymentSignaturePayload,
): `0x${string}` | null {
  const extensions = payment.extensions;
  if (!extensions) {
    return null;
  }
  for (const key of ["txHash", "transaction", "transactionHash"] as const) {
    const value = extensions[key];
    if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
      return value as `0x${string}`;
    }
  }
  return null;
}

function payerBroadcastOutcomeUnknownSettlement(input: {
  transactionHash: `0x${string}`;
  requirement: PaymentAccept;
  errorReason: string;
  settlement?: SettlementResponsePayload;
}): SettlementResponsePayload {
  return {
    ...input.settlement,
    success: false,
    transaction: input.transactionHash,
    network: input.settlement?.network ?? input.requirement.network,
    amount:
      input.settlement?.amount ?? input.requirement.maxAmountRequired,
    errorReason: input.settlement?.errorReason ?? input.errorReason,
    extensions: {
      ...input.settlement?.extensions,
      settlementVerified: false,
    },
  };
}

function paymentRequirementForPreparedReconciliation(
  payment: PaymentSignaturePayload,
  fallback: PaymentAccept,
): PaymentAccept | null {
  const accepted = payment.accepted;
  const destination = accepted.payTo ?? accepted.destination;
  const resource = payment.resource?.url;
  if (
    !accepted.chainId ||
    !accepted.assetAddress ||
    !destination ||
    !resource
  ) {
    return null;
  }
  return {
    ...fallback,
    network: accepted.network,
    chainId: accepted.chainId,
    assetAddress: accepted.assetAddress,
    asset: accepted.asset ?? fallback.asset,
    amount: accepted.amount,
    maxAmountRequired: accepted.amount,
    destination,
    payTo: destination,
    resource,
  };
}

function paymentRequiredResponse(
  payload: PaymentRequiredPayload,
  errorReason?: string,
  settlement?: SettlementResponsePayload,
  prepareUrl?: string,
): Response {
  const body: PaymentRequiredPayload = errorReason
    ? { ...payload, error: errorReason }
    : payload;

  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(body),
  });

  if (settlement) {
    headers.set(PAYMENT_RESPONSE_HEADER, encodeSettlementResponseHeader(settlement));
  }
  if (prepareUrl) {
    headers.set("GENESISPAY-Settlement-Prepare", prepareUrl);
    headers.set("GENESISPAY-Settlement-Version", "1");
  }

  return new Response(JSON.stringify(body), { status: 402, headers });
}

function readPreparePayer(value: unknown): EvmAddress | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("payer" in value) ||
    typeof value.payer !== "string" ||
    !isAddress(value.payer)
  ) {
    return null;
  }
  return getAddress(value.payer);
}

function withSettlementHeader(
  response: Response,
  settlement: SettlementResponsePayload,
): Response {
  const headers = new Headers(response.headers);
  headers.set(PAYMENT_RESPONSE_HEADER, encodeSettlementResponseHeader(settlement));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizePayToAddress(payTo: string): EvmAddress {
  if (typeof payTo !== "string" || !isAddress(payTo.trim())) {
    throw new Error(
      `Invalid payTo address "${String(payTo)}": expected an EVM address like 0x1234....`,
    );
  }

  return getAddress(payTo.trim());
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Malformed PAYMENT-SIGNATURE header.";
}
