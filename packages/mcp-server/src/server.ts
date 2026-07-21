import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PeerPayAgent } from "@genesis-tech/peerpay-agent";
import {
  PeerPayApiError,
  PeerPayApprovalRejectedError,
  PeerPayApprovalTimeoutError,
} from "@genesis-tech/peerpay-agent";
import type { AgentPaymentResult } from "@genesis-tech/peerpay-agent";
import { z } from "zod";

/** The subset of the PeerPay agent client the MCP tools rely on. */
export type PeerPayAgentLike = Pick<
  PeerPayAgent,
  "pay" | "paymentStatus" | "account" | "discover"
>;

export type CreatePeerPayMcpServerOptions = {
  agent: PeerPayAgentLike;
};

const MAX_INLINE_BODY_CHARS = 50_000;

const APPROVAL_GUIDANCE =
  "This payment requires HUMAN APPROVAL before it executes. Show the " +
  "approvalUrl to the user and ask them to approve or deny it on the PeerPay " +
  "dashboard. Do NOT retry peerpay_pay for the same resource — that creates " +
  "duplicate payment requests. Check progress with peerpay_payment_status.";

export function createPeerPayMcpServer(
  options: CreatePeerPayMcpServerOptions,
): McpServer {
  const { agent } = options;

  const server = new McpServer({
    name: "peerpay",
    version: "0.1.0",
  });

  server.registerTool(
    "peerpay_pay",
    {
      title: "Pay for an x402-gated URL",
      description:
        "Pays for an HTTP 402 (x402) payment-gated URL using the PeerPay agent " +
        "wallet (USDC on Base) and returns the paid resource's response. " +
        "IMPORTANT: payments can require human approval depending on the " +
        "account's spending policy. When the result status is " +
        "'pending_approval', surface the approvalUrl to the user so they can " +
        "approve it on the PeerPay dashboard — do not retry the payment " +
        "blindly; use peerpay_payment_status to check for a decision.",
      inputSchema: {
        url: z.string().describe("The x402 payment-gated URL to pay for."),
        maxAmountUsdc: z
          .string()
          .optional()
          .describe(
            'Optional spending guard: refuse to pay more than this decimal USDC amount, e.g. "0.50".',
          ),
        asset: z
          .enum(["USDC", "EURC"])
          .optional()
          .describe(
            'Optional settlement asset; "USDC" is the default. Pass "EURC" ' +
              "only when the resource is priced in EURC and the account has " +
              "an EURC budget.",
          ),
      },
    },
    async ({ url, maxAmountUsdc, asset }) => {
      try {
        const result = await agent.pay(url, { maxAmountUsdc, asset });
        return jsonResult(describePayResult(result));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "peerpay_discover",
    {
      title: "Discover x402-payable services",
      description:
        "Searches the PeerPay discovery directory for services that can be " +
        "paid over HTTP 402 (x402) with USDC — APIs, bookings, and payment " +
        "links. Use this FIRST when the user asks for something purchasable " +
        "(e.g. 'book me a flight'): search with a short keyword query, pick " +
        "the best match, then pay for its resourceUrl with peerpay_pay. " +
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
              ? "Pick the best match and pay for its resourceUrl with peerpay_pay."
              : "No services matched. Try a shorter or different keyword query.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "peerpay_payment_status",
    {
      title: "Check a PeerPay payment's status",
      description:
        "Fetches the current status of a PeerPay agent payment (statuses: " +
        "pending_approval, approved, denied, executing, settled, failed, " +
        "expired). Use this to check whether a human has approved a " +
        "pending_approval payment instead of retrying peerpay_pay. If it is " +
        "still pending_approval, remind the user to decide on the PeerPay " +
        "dashboard approval page.",
      inputSchema: {
        paymentId: z
          .string()
          .describe("The paymentId returned by peerpay_pay."),
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
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "peerpay_account",
    {
      title: "Show the PeerPay agent account",
      description:
        "Returns the PeerPay agent account snapshot: wallet address, chain, " +
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

function errorResult(error: unknown) {
  const details: Record<string, unknown> = {
    error: error instanceof Error ? error.message : "Unknown error.",
  };

  if (error instanceof PeerPayApiError) {
    details.code = error.code;
    details.httpStatus = error.status;
  }

  if (error instanceof PeerPayApprovalTimeoutError) {
    details.paymentId = error.payment.id;
    details.approvalUrl = error.approvalUrl;
    details.instructions = APPROVAL_GUIDANCE;
  }

  if (error instanceof PeerPayApprovalRejectedError) {
    details.paymentId = error.payment.id;
    details.paymentStatus = error.payment.status;
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    isError: true,
  };
}
