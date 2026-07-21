import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  buildPaymentRequiredPayload,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodeSettlementResponseHeader,
  validatePaymentSignatureAgainstRequirement,
} from "@genesis-tech/peerpay-protocol";
import type {
  EvmAddress,
  PaymentAccept,
  PaymentRequiredPayload,
  PaymentSignaturePayload,
  SettlementResponsePayload,
} from "@genesis-tech/peerpay-protocol";
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
};

export type SettlementVerification =
  | { ok: true; settlement: SettlementResponsePayload }
  | { ok: false; errorReason: string; settlement?: SettlementResponsePayload };

export type VerifySettlement = (
  context: SettlementContext,
) => Promise<SettlementVerification>;

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
          "gate.wrap requires a verifySettlement hook — use peerPaySettlement({ facilitatorBaseUrl, apiKey }) or provide your own.",
        );
      }

      return async (request: Request, ...args: Args): Promise<Response> => {
        const payload = buildPayload(resolveResource(request));
        const paymentSignatureHeader = request.headers.get(
          PAYMENT_SIGNATURE_HEADER,
        );

        if (!paymentSignatureHeader?.trim()) {
          return paymentRequiredResponse(payload);
        }

        let payment: PaymentSignaturePayload;
        try {
          payment = decodePaymentSignatureHeader(paymentSignatureHeader);
        } catch (error) {
          return paymentRequiredResponse(payload, describeError(error));
        }

        const requirement = payload.accepts[0];
        const mismatch = validatePaymentSignatureAgainstRequirement(
          payment,
          requirement,
        );
        if (mismatch) {
          return paymentRequiredResponse(payload, mismatch);
        }

        const verification = await options.verifySettlement({
          request,
          paymentSignatureHeader,
          payment,
          requirement,
        });

        if (!verification.ok) {
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

function paymentRequiredResponse(
  payload: PaymentRequiredPayload,
  errorReason?: string,
  settlement?: SettlementResponsePayload,
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

  return new Response(JSON.stringify(body), { status: 402, headers });
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
