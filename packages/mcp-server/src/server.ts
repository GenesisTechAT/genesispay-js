import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GenesisPayAgent } from "@genesis-tech/genesispay-agent";
import {
  GenesisPayApiError,
  GenesisPayApprovalRejectedError,
  GenesisPayApprovalTimeoutError,
  GenesisPayDuplicatePaymentError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
} from "@genesis-tech/genesispay-agent";
import type { AgentPaymentResult } from "@genesis-tech/genesispay-agent";
import { z } from "zod";

/** The subset of the GenesisPay agent client the MCP tools rely on. */
export type GenesisPayAgentLike = Pick<
  GenesisPayAgent,
  "pay" | "paymentStatus" | "account" | "discover"
>;

export type CreateGenesisPayMcpServerOptions = {
  agent: GenesisPayAgentLike;
};

const MAX_INLINE_BODY_CHARS = 50_000;

const APPROVAL_GUIDANCE =
  "This payment requires HUMAN APPROVAL before it executes. Show the " +
  "approvalUrl to the user and ask them to approve or deny it on the GenesisPay " +
  "dashboard. Do NOT retry genesispay_pay for the same resource — that creates " +
  "duplicate payment requests. Check progress with genesispay_payment_status.";

const APPROVED_GUIDANCE =
  "This payment was approved and GenesisPay is executing it now. Do NOT call " +
  "genesispay_pay again — poll genesispay_payment_status until it reports settled.";

const UNRESOLVED_GUIDANCE =
  "This payment was sent to the seller and the seller never confirmed it. The " +
  "buyer MAY ALREADY HAVE BEEN CHARGED. Do NOT buy this item again: tell the " +
  "user what happened and let them check with the seller. If you must " +
  "re-attempt the same purchase, you MUST pass the original idempotencyKey — " +
  "any other key pays a second time.";

export function createGenesisPayMcpServer(
  options: CreateGenesisPayMcpServerOptions,
): McpServer {
  const { agent } = options;

  const server = new McpServer({
    name: "genesispay",
    version: "0.1.0",
  });

  server.registerTool(
    "genesispay_pay",
    {
      title: "Pay for an x402-gated URL",
      description:
        "Pays for an HTTP 402 (x402) payment-gated URL using the GenesisPay agent " +
        "wallet (USDC on Base) and returns the paid resource's response. " +
        "IMPORTANT: payments can require human approval depending on the " +
        "account's spending policy. When the result status is " +
        "'pending_approval', surface the approvalUrl to the user so they can " +
        "approve it on the GenesisPay dashboard — do not retry the payment " +
        "blindly; use genesispay_payment_status to check for a decision.",
      inputSchema: {
        url: z.string().describe("The x402 payment-gated URL to pay for."),
        maxAmountUsdc: z
          .string()
          .optional()
          .describe(
            'Optional spending guard: refuse to pay more than this decimal USDC amount, e.g. "0.50".',
          ),
        // USDC only for v1. The engine already fails closed for an asset the
        // account has no policy row for, and `genesispay_account` reports the USDC
        // balance specifically — so offering EURC here would let a model check
        // a budget it is not about to spend, pay in another asset, and be
        // refused at signing with no way to see why.
        asset: z
          .literal("USDC")
          .optional()
          .describe(
            'Settlement asset. USDC on Base is the only asset agent payments ' +
              "support today, so this can be omitted.",
          ),
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Identifies this purchase. If you retry a call that failed without " +
              "telling you whether the payment went through, pass the SAME key " +
              "as the first attempt — that is what stops the payer being " +
              "charged twice. One is generated per call when you omit it, " +
              "which makes each call a separate purchase.",
          ),
      },
    },
    async ({ url, maxAmountUsdc, asset, idempotencyKey }) => {
      // A model retrying a failed tool call is the normal case, not the
      // exception, and without a key that retry signs a fresh EIP-3009 nonce the
      // token contract cannot recognise as a duplicate. The generated default is
      // only useful if the model can REUSE it, so the effective key is returned
      // on both the success and the failure path — a default it never sees is
      // exactly as good as no default at all.
      const effectiveKey = idempotencyKey ?? randomUUID();

      try {
        const result = await agent.pay(url, {
          maxAmountUsdc,
          asset,
          idempotencyKey: effectiveKey,
        });
        return jsonResult({
          ...describePayResult(result),
          idempotencyKey: effectiveKey,
        });
      } catch (error) {
        return errorResult(error, effectiveKey);
      }
    },
  );

  server.registerTool(
    "genesispay_discover",
    {
      title: "Discover x402-payable services",
      description:
        "Searches the GenesisPay discovery directory for services that can be " +
        "paid over HTTP 402 (x402) with USDC — APIs, bookings, and payment " +
        "links. Use this FIRST when the user asks for something purchasable " +
        "(e.g. 'book me a flight'): search with a short keyword query, pick " +
        "the best match, then pay for its resourceUrl with genesispay_pay. " +
        "Results include the title, description, price in USDC, and the " +
        "payable resourceUrl.",
      inputSchema: {
        query: z
          .string()
          .describe(
            'Short keyword search, e.g. "flight", "vps", "weather api".',
          ),
        category: z
          .string()
          .optional()
          .describe('Optional category filter, e.g. "flights".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 20, max 50)."),
      },
    },
    async ({ query, category, limit }) => {
      try {
        const listings = await agent.discover(query, { category, limit });
        return jsonResult({
          query,
          count: listings.length,
          listings,
          instructions:
            listings.length > 0
              ? "Pick the best match and pay for its resourceUrl with genesispay_pay."
              : "No services matched. Try a shorter or different keyword query.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "genesispay_payment_status",
    {
      title: "Check a GenesisPay payment's status",
      description:
        "Fetches the current status of a GenesisPay agent payment (statuses: " +
        "pending_approval, approved, denied, executing, settled, failed, " +
        "expired, unresolved). Use this to check whether a human has approved a " +
        "pending_approval payment instead of retrying genesispay_pay. If it is " +
        "still pending_approval, remind the user to decide on the GenesisPay " +
        "dashboard approval page. `unresolved` means the payment was sent to " +
        "the seller and they never confirmed it — the buyer MAY already have " +
        "been charged, so do not buy the item again.",
      inputSchema: {
        paymentId: z
          .string()
          .describe("The paymentId returned by genesispay_pay."),
      },
    },
    async ({ paymentId }) => {
      try {
        const payment = await agent.paymentStatus(paymentId);
        return jsonResult({
          payment,
          ...(payment.status === "pending_approval"
            ? { instructions: APPROVAL_GUIDANCE }
            : {}),
          ...(payment.status === "unresolved"
            ? { instructions: UNRESOLVED_GUIDANCE }
            : {}),
          // Without this a model that polls into `approved` has nothing telling
          // it what that means, and "approved" reads like "it went through".
          ...(payment.status === "approved" || payment.status === "executing"
            ? { instructions: APPROVED_GUIDANCE }
            : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "genesispay_account",
    {
      title: "Show the GenesisPay agent account",
      description:
        "Returns the GenesisPay agent account snapshot: wallet address, chain, " +
        "USDC balance, spending policy (per-payment/daily/monthly caps, " +
        "allowlist), and spend totals. Amounts are USDC minor units (6 " +
        "decimals) as strings. Useful before paying to see whether a payment " +
        "will need human approval.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await agent.account());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

function describePayResult(result: AgentPaymentResult): Record<string, unknown> {
  if (result.pendingApproval) {
    return {
      status: "pending_approval",
      paymentId: result.paymentId,
      approvalUrl: result.approvalUrl,
      amountUsdc: formatUsdcMinor(result.payment.amountUsdcMinor),
      resourceUrl: result.payment.resourceUrl,
      instructions: APPROVAL_GUIDANCE,
    };
  }

  return {
    status: "settled",
    paymentId: result.paymentId,
    txHash: result.txHash,
    amountUsdc: formatUsdcMinor(result.payment.amountUsdcMinor),
    resourceUrl: result.payment.resourceUrl,
    resource: describeCapturedResource(result),
  };
}

function describeCapturedResource(
  result: AgentPaymentResult,
): Record<string, unknown> | null {
  if (!result.response) {
    return null;
  }

  const { status, mimeType } = result.response;

  if (!isTextLikeMimeType(mimeType)) {
    return {
      status,
      mimeType,
      note: "Binary response body omitted.",
    };
  }

  const body = result.body();
  return {
    status,
    mimeType,
    body:
      body.length > MAX_INLINE_BODY_CHARS
        ? `${body.slice(0, MAX_INLINE_BODY_CHARS)}… [truncated]`
        : body,
  };
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml")
  );
}

function formatUsdcMinor(amountUsdcMinor: string): string {
  const amount = BigInt(amountUsdcMinor);
  const whole = amount / 1_000_000n;
  const fractional = amount % 1_000_000n;

  if (fractional === 0n) {
    return whole.toString();
  }

  return `${whole}.${fractional.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: unknown, idempotencyKey?: string) {
  const details: Record<string, unknown> = {
    error: error instanceof Error ? error.message : "Unknown error.",
  };

  if (idempotencyKey) {
    details.idempotencyKey = idempotencyKey;
  }

  // Withheld only where the server has TOLD us nothing was created: a 4xx
  // rejection or hard block. There, "retry with the same key" sends the model
  // round a loop that can never succeed and reads as though a retry were the
  // remedy, when the remedy is to tell the user.
  //
  // Everything else keeps the guidance, including an error this layer cannot
  // classify at all — an unrecognised throw is not evidence that nothing
  // happened, and the conservative advice is the one that cannot double-charge.
  // Three ways to know nothing is out there to be charged: the server answered
  // 4xx, the SDK typed it as a pre-signing rejection (which can be a 502 —
  // `target_unreachable` is the seller's endpoint failing, not ours), or the
  // payment is `failed`, which by MR-306 means no authorization was ever
  // emitted. In all three the same key can only ever 409, so telling the model
  // to reuse it sends it round a loop and contradicts what the SDK computed.
  const serverSaysNothingWasCreated =
    error instanceof GenesisPayPaymentRejectedError ||
    error instanceof GenesisPayPaymentFailedError ||
    (error instanceof GenesisPayApiError &&
      error.status >= 400 &&
      error.status < 500);

  if (idempotencyKey && !serverSaysNothingWasCreated) {
    details.retryGuidance =
      "If you retry this purchase, pass this same idempotencyKey. Retrying with a different key (or none) pays a second time.";
  }

  // BEFORE the generic retryGuidance can mislead, and before the other
  // branches: whenever a charge cannot be ruled out, the model must be told to
  // stop rather than to retry. This branch was missing entirely, so the pay
  // path handed the model the generic "pass this same idempotencyKey" line —
  // which reads as an invitation to retry — while the strong "do NOT buy this
  // again" instruction only ever fired on genesispay_payment_status.
  if (error instanceof GenesisPayPaymentOutcomeUnknownError) {
    details.paymentId = error.paymentId;
    details.paymentStatus = error.payment?.status ?? null;
    details.outcome = "unknown";
    details.instructions = UNRESOLVED_GUIDANCE;

    if (error.idempotencyKey ?? idempotencyKey) {
      details.idempotencyKey = error.idempotencyKey ?? idempotencyKey;
    }

    // Replaces, never accompanies, the generic guidance above.
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayDuplicatePaymentError) {
    // Not a failure: the payment exists and this call did not create a second.
    details.paymentId = error.paymentId;
    details.paymentStatus = error.payment?.status ?? null;

    // The original's status decides the advice, and getting this wrong wedges
    // the agent. A `failed` original never signed anything (MR-306), so the way
    // forward is a NEW key — the SDK computes exactly that and said so, and
    // overwriting it unconditionally with "read its status instead of retrying"
    // left the model with a key that 409s forever and no route to the purchase.
    details.retryGuidance =
      error.payment?.status === "failed"
        ? "The earlier attempt with this idempotencyKey was refused before anything was signed, so nothing was charged. To buy this now, retry with a NEW idempotencyKey."
        : "This purchase was already requested and was NOT paid for twice. Read its status instead of retrying.";
  }

  if (error instanceof GenesisPayApiError) {
    details.code = error.code;
    details.httpStatus = error.status;
  }

  if (error instanceof GenesisPayApprovalTimeoutError) {
    details.paymentId = error.payment.id;
    details.approvalUrl = error.approvalUrl;
    details.instructions = APPROVAL_GUIDANCE;
    // APPROVAL_GUIDANCE says "do NOT retry genesispay_pay for the same resource",
    // and the generic guidance says "retry with this same key". One payload
    // must not carry both; the specific instruction wins.
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayApprovalRejectedError) {
    details.paymentId = error.payment.id;
    details.paymentStatus = error.payment.status;
    // Denied or expired: a human said no, or the window closed. No key makes
    // that a purchase, and suggesting a retry invites routing around a denial.
    delete details.retryGuidance;
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    isError: true,
  };
}
