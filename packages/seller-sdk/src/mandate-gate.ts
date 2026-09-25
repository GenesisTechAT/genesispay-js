/**
 * Mandate gate — the signature-free metered path for humans and subscriptions.
 *
 * Instead of demanding a fresh signed payment per request (the x402 gate), the
 * caller presents a standing payment mandate id via the `GENESISPAY-MANDATE`
 * header. The gate debits the mandate through GenesisPay
 * (`POST /api/v1/mandates/:id/charge`) — a non-custodial on-chain pull from
 * the payer's wallet directly to yours — and only runs your handler once the
 * charge settled. Combine with `createPaymentGate` to accept both per-call
 * x402 payments and mandate-metered calls on one endpoint.
 */

import { parseUsdcAmountToMinorUnits } from "./usdc-amount.js";

export const MANDATE_HEADER = "GENESISPAY-MANDATE";
const MANDATE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;

function validIdempotencyKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  return key &&
    key.toLowerCase() !== "undefined" &&
    MANDATE_IDEMPOTENCY_KEY.test(key)
    ? key
    : null;
}

export type MandateGateOptions = {
  /** Decimal charge per request, e.g. "0.08". */
  amount: string;
  /** Base URL of the GenesisPay app (your GENESISPAY_BASE_URL). */
  baseUrl: string;
  /** GenesisPay seller API key ("gp_sk_..."). */
  apiKey: string;
  /** Description attached to each charge (shows up in activity/usage). */
  description?: string;
  /** Override for testing; defaults to global fetch. */
  fetchFn?: typeof fetch;
};

export type MandateChargeOutcome =
  | {
      ok: true;
      charge: { id: string; amountMinor: string; txHash: string };
    }
  | {
      ok: false;
      status: number;
      code?: string;
      error: string;
      charge?: { id: string; amountMinor: string; txHash: string | null };
    };

export type MandateGate = {
  /** Charges the mandate once. Exposed for custom flows. */
  charge: (
    mandateId: string,
    resourceUrl: string | undefined,
    idempotencyKey: string,
  ) => Promise<MandateChargeOutcome>;
  /**
   * Wraps a fetch-style handler: requests carrying a valid `GENESISPAY-MANDATE`
   * header are charged and passed through; requests without one get a 402
   * JSON body explaining how to attach a mandate.
   */
  wrap: (
    handler: (request: Request) => Response | Promise<Response>,
  ) => (request: Request) => Promise<Response>;
};

export function createMandateGate(options: MandateGateOptions): MandateGate {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error("createMandateGate requires a GenesisPay seller API key (gp_sk_...).");
  }

  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("createMandateGate requires the GenesisPay base URL.");
  }

  if (!/^\d+(\.\d{1,6})?$/.test(options.amount)) {
    throw new Error(
      "createMandateGate requires a decimal amount with up to 6 decimals, e.g. \"0.08\".",
    );
  }

  const expectedAmountMinor = parseUsdcAmountToMinorUnits(
    options.amount,
  ).toString();
  const fetchFn = options.fetchFn ?? fetch;

  async function charge(
    mandateId: string,
    resourceUrl?: string,
    idempotencyKey?: string,
  ): Promise<MandateChargeOutcome> {
    const stableKey = validIdempotencyKey(idempotencyKey);
    if (!stableKey) {
      return {
        ok: false,
        status: 400,
        code: "invalid_idempotency_key",
        error: "Idempotency-Key is required for mandate charges and must be reused after an outcome-unknown response.",
      };
    }
    let response: Response;
    try {
      response = await fetchFn(
        `${baseUrl}/api/v1/mandates/${encodeURIComponent(mandateId)}/charge`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": stableKey,
          },
          body: JSON.stringify({
            amount: options.amount,
            resourceUrl,
            description: options.description,
          }),
        },
      );
    } catch (error) {
      return {
        ok: false,
        status: 503,
        error: `GenesisPay is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body; fall through with a generic message.
    }

    const record = (body ?? {}) as Record<string, unknown>;

    if (!response.ok) {
      const chargeRecord = (record.charge ?? null) as Record<string, unknown> | null;
      return {
        ok: false,
        status: response.status,
        code: typeof record.code === "string" ? record.code : undefined,
        error:
          typeof record.error === "string"
            ? record.error
            : `GenesisPay rejected the mandate charge (${response.status}).`,
        ...(chargeRecord && typeof chargeRecord.id === "string"
          ? {
              charge: {
                id: chargeRecord.id,
                amountMinor: String(chargeRecord.amountMinor ?? ""),
                txHash:
                  typeof chargeRecord.txHash === "string"
                    ? chargeRecord.txHash
                    : null,
              },
            }
          : {}),
      };
    }

    const chargeRecord =
      record.charge &&
      typeof record.charge === "object" &&
      !Array.isArray(record.charge)
        ? (record.charge as Record<string, unknown>)
        : null;
    const chargeId =
      typeof chargeRecord?.id === "string" ? chargeRecord.id : "";
    const amountMinor =
      typeof chargeRecord?.amountMinor === "string"
        ? chargeRecord.amountMinor
        : "";
    const txHash =
      typeof chargeRecord?.txHash === "string" ? chargeRecord.txHash : "";

    if (
      chargeRecord?.status !== "settled" ||
      chargeId.trim().length === 0 ||
      amountMinor !== expectedAmountMinor ||
      !TRANSACTION_HASH.test(txHash)
    ) {
      return {
        ok: false,
        status: 503,
        code: "charge_response_unverified",
        error:
          "GenesisPay did not return a verified settled mandate charge. Do not retry with a new Idempotency-Key.",
        ...(chargeId.trim().length > 0
          ? {
              charge: {
                id: chargeId,
                amountMinor,
                txHash: TRANSACTION_HASH.test(txHash) ? txHash : null,
              },
            }
          : {}),
      };
    }

    return {
      ok: true,
      charge: {
        id: chargeId,
        amountMinor,
        txHash,
      },
    };
  }

  function wrap(handler: (request: Request) => Response | Promise<Response>) {
    return async (request: Request): Promise<Response> => {
      const mandateId = request.headers.get(MANDATE_HEADER)?.trim();

      if (!mandateId) {
        return jsonResponse(
          {
            error: "Payment required.",
            howToPay: `Attach an active GenesisPay mandate id via the ${MANDATE_HEADER} header, or pay per call via x402.`,
            amount: options.amount,
          },
          402,
        );
      }

      const idempotencyKey = validIdempotencyKey(
        request.headers.get("Idempotency-Key"),
      );
      if (!idempotencyKey) {
        return jsonResponse(
          {
            error:
              "Idempotency-Key is required for a mandate-metered request and must be reused after a timeout.",
            code: "invalid_idempotency_key",
          },
          400,
        );
      }

      const outcome = await charge(mandateId, request.url, idempotencyKey);

      if (!outcome.ok) {
        return jsonResponse(
          {
            error: outcome.error,
            code: outcome.code,
            ...(outcome.charge ? { charge: outcome.charge } : {}),
          },
          outcome.status,
        );
      }

      const response = await handler(request);
      const headers = new Headers(response.headers);
      headers.set("GENESISPAY-MANDATE-CHARGE", outcome.charge.id);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
  }

  return { charge, wrap };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
