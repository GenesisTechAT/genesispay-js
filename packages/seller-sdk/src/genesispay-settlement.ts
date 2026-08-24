import { parseSettlementResponsePayload } from "@genesis-tech/genesispay-protocol";
import type { SettlementResponsePayload } from "@genesis-tech/genesispay-protocol";

import type {
  SettlementContext,
  SettlementVerification,
  VerifySettlement,
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
};

/**
 * Built-in settlement hook that forwards the PAYMENT-SIGNATURE payload to the
 * GenesisPay facilitator (`POST /api/v1/facilitator/settle`). GenesisPay broadcasts
 * the EIP-3009 authorization on-chain (or verifies a payer-provided txHash)
 * and verifies the USDC transfer before reporting success.
 */
export function genesisPaySettlement(
  options: GenesisPaySettlementOptions,
): VerifySettlement {
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

  return async (context: SettlementContext): Promise<SettlementVerification> => {
    const { requirement } = context;

    let response: Response;
    try {
      response = await fetchFn(settleUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          paymentSignature: context.paymentSignatureHeader,
          requirement: {
            resource: requirement.resource,
            network: requirement.network,
            chainId: requirement.chainId,
            assetAddress: requirement.assetAddress,
            amountUsdcMinor: requirement.maxAmountRequired,
            payTo: requirement.payTo,
            description: requirement.description || undefined,
          },
        }),
      });
    } catch (error) {
      return {
        ok: false,
        errorReason: `Failed to reach the GenesisPay facilitator: ${describeError(error)}`,
      };
    }

    const body = await readJsonBody(response);
    const settlement = tryParseSettlement(body);

    if (response.ok && settlement?.success) {
      return { ok: true, settlement };
    }

    return {
      ok: false,
      errorReason:
        settlement?.errorReason ??
        readErrorMessage(body) ??
        `GenesisPay facilitator settlement failed with status ${response.status}.`,
      ...(settlement ? { settlement } : {}),
    };
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
