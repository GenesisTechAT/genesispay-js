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

export const MANDATE_HEADER = "GENESISPAY-MANDATE";

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
  | { ok: false; status: number; code?: string; error: string };

export type MandateGate = {
  /** Charges the mandate once. Exposed for custom flows. */
  charge: (mandateId: string, resourceUrl?: string) => Promise<MandateChargeOutcome>;
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

  const fetchFn = options.fetchFn ?? fetch;

  async function charge(
    mandateId: string,
    resourceUrl?: string,
  ): Promise<MandateChargeOutcome> {
    let response: Response;
    try {
      response = await fetchFn(
        `${baseUrl}/api/v1/mandates/${encodeURIComponent(mandateId)}/charge`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
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
      return {
        ok: false,
        status: response.status,
        code: typeof record.code === "string" ? record.code : undefined,
        error:
          typeof record.error === "string"
            ? record.error
            : `GenesisPay rejected the mandate charge (${response.status}).`,
      };
    }

    const chargeRecord = (record.charge ?? {}) as Record<string, unknown>;

    return {
      ok: true,
      charge: {
        id: String(chargeRecord.id ?? ""),
        amountMinor: String(chargeRecord.amountMinor ?? ""),
        txHash: String(chargeRecord.txHash ?? ""),
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

      const outcome = await charge(mandateId, request.url);

      if (!outcome.ok) {
        return jsonResponse(
          { error: outcome.error, code: outcome.code },
          outcome.status === 403 || outcome.status === 404 ? outcome.status : 402,
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
