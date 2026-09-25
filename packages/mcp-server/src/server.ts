import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GenesisPayAgent } from "@genesis-tech/genesispay-agent";
import {
  GenesisPayApiError,
  GenesisPayApprovalRejectedError,
  GenesisPayApprovalTimeoutError,
  GenesisPayDuplicatePaymentError,
  GenesisPayIdempotencyConflictError,
  GenesisPayOutcomeWaitTimeoutError,
  GenesisPayPaymentFailedError,
  GenesisPayPaymentOutcomeUnknownError,
  GenesisPayPaymentRejectedError,
  GenesisPayPolicyBlockedError,
} from "@genesis-tech/genesispay-agent";
import type {
  AgentPaymentResult,
  DiscoveredService,
  WaitForOutcomeOptions,
} from "@genesis-tech/genesispay-agent";
import { z } from "zod";

import { GENESISPAY_MCP_VERSION } from "./version.js";

/**
 * The subset of the GenesisPay agent client the MCP tools rely on. `shops` is
 * optional so an agent-like object written against 1.0 still type-checks; the
 * `genesispay_shops` tool answers with an error when it is missing.
 */
export type GenesisPayAgentLike = Pick<
  GenesisPayAgent,
  "pay" | "paymentStatus" | "account" | "discover"
> &
  Partial<Pick<GenesisPayAgent, "shops">>;

export type CreateGenesisPayMcpServerOptions = {
  agent: GenesisPayAgentLike;
};

const MAX_INLINE_BODY_CHARS = 50_000;

/**
 * How long `genesispay_pay` waits, read-only, for a payment GenesisPay accepted
 * but has not confirmed. The wait starts after the pay response arrives.
 *
 * Time budget, against the MCP client's default 60 s request timeout: a typical
 * pay call returns within ~15 s (probe, preparation, signed request, and the
 * server's own 12 s follow-up wait for a queued link), so 15 s + 25 s stays
 * inside 60 s. The pay call itself is NOT bounded client-side, deliberately: the
 * engine allows a slow seller up to 60 s for the signed request, and aborting
 * our side would not stop the server — it would only turn a probable success
 * into an unknown outcome without a paymentId. When a slow seller pushes the
 * total past the client's timeout, the client cancels; that is safe, because
 * the saved key and terms replay the original payment (ADR-0076), which is what
 * the tool description tells the model to do after a timeout.
 */
const PAY_OUTCOME_WAIT: WaitForOutcomeOptions = {
  timeoutMs: 25_000,
  pollIntervalMs: 2_000,
};

// MR-306: accepted but unconfirmed is not failed. The model must neither
// report a failure nor "fix" it with a second purchase under a new key.
const NOT_CONFIRMED_GUIDANCE =
  "This payment is not confirmed yet. GenesisPay accepted it and is still " +
  "waiting for its on-chain confirmation, so the buyer MAY ALREADY HAVE BEEN " +
  "CHARGED. Tell the user it is still being confirmed and poll " +
  "genesispay_payment_status with this paymentId until it reports settled or " +
  "another final status (failed, denied or expired). " +
  "Never buy this item again with a new idempotencyKey — that pays a second " +
  "time; only the same key and terms may be retried.";

const SETTLEMENT_ACCEPTANCE_NOTE =
  "HTTP 202: the seller accepted the payment for settlement and delivered no " +
  "content with it. The payment is settled; recover any content from the " +
  "seller using paymentId.";

const APPROVAL_GUIDANCE =
  "This payment requires HUMAN APPROVAL before it executes. Tell the user the " +
  "amount, resourceUrl and paymentId and ask them to approve or deny that entry " +
  "at approvalUrl. Approving executes it on the server; you never pay it " +
  "yourself. Poll genesispay_payment_status with this paymentId. Calling " +
  "genesispay_pay again with this same key and terms only returns this " +
  "payment; a NEW key requests a second payment — never do that for this purchase.";

const APPROVED_GUIDANCE =
  "This payment was approved and is being executed by GenesisPay now. Do NOT " +
  "call genesispay_pay again — poll genesispay_payment_status until it reports " +
  "a final status (settled, unresolved or failed).";

// MR-502: an allowlist miss (or a paused account) is a hard block, not an
// approval request. The model must not read it as "ask again" or as a reason
// to route the same purchase through another key or endpoint.
const POLICY_BLOCKED_GUIDANCE =
  "The account owner's spending policy blocks this payment. This is not an " +
  "approval request; no retry, key change or other endpoint for the same " +
  "purchase can succeed. Stop and tell the user; only the owner can change " +
  "the policy on the GenesisPay dashboard.";

const SETTLED_REPLAY_GUIDANCE =
  "Already paid earlier; nothing was charged again and the content is not " +
  "re-delivered. Recover it from the seller using paymentId.";

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
    version: GENESISPAY_MCP_VERSION,
  });

  server.registerTool(
    "genesispay_pay",
    {
      title: "Pay for an x402-gated URL",
      description:
        "Pays for an HTTP 402 (x402) payment-gated URL with the GenesisPay agent " +
        "wallet (USDC on Base) and returns the paid response. BEFORE calling, " +
        "choose ONE idempotencyKey for this purchase, formatted " +
        "<purpose>-<yyyymmdd>-<6 random chars>, and write it together with url, " +
        "maxAmountUsdc, asset and description into your reply to the user. Every retry " +
        "of this purchase — after an error, a timeout or a lost response — MUST " +
        "reuse exactly that key and those terms; a new key is a new purchase and " +
        "can charge twice. Use a new key only for a genuinely new purchase, or " +
        "after this purchase was reported 'failed'. When a listing says " +
        "method: POST, pass method \"POST\" and the exact JSON body the API " +
        "expects; the body is part of the purchase, so send it byte-identical " +
        "on every retry — a different or reformatted body with the same key " +
        "ends in 'idempotency_conflict'. 'pending_approval': show " +
        "approvalUrl, amount, resourceUrl and paymentId, then poll " +
        "genesispay_payment_status. 'policy_blocked': stop and tell the user. " +
        "'not_confirmed_yet': the payment may already have been charged — poll " +
        "genesispay_payment_status and never buy again with a new key. " +
        "'unresolved': the buyer MAY already have been charged — do not buy again.",
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
        description: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Short human-readable purpose shown to the owner on the approval " +
              "page. Part of the purchase identity: reuse it unchanged on every " +
              "retry with the same idempotencyKey.",
          ),
        idempotencyKey: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            "Identifies this purchase. If you retry a call that failed without " +
              "telling you whether the payment went through, pass the SAME key " +
              "as the first attempt — that is what stops the payer being " +
              "charged twice. Generate and persist the purchase key before calling this tool; " +
              "the same saved purchase must always reuse it.",
          ),
        method: z
          .enum(["GET", "POST"])
          .optional()
          .describe(
            'HTTP method of the purchase. Default "GET". Use "POST" when the ' +
              "discovery listing says method: POST, together with body.",
          ),
        // Not trimmed or otherwise touched: these are the bytes the seller
        // hashes and the purchase identity is bound to (MR-307).
        body: z
          .string()
          .optional()
          .describe(
            "Only with method POST: the exact JSON text to send as the request " +
              "body, e.g. '{\"horizon\":\"7d\"}' (at most 256 KiB). It is part of " +
              "the purchase identity: on every retry with the same " +
              "idempotencyKey pass it byte-identical — same spacing, same key " +
              "order. Never put secrets or personal data in it; it is stored " +
              "with the payment.",
          ),
        contentType: z
          .literal("application/json")
          .optional()
          .describe(
            'Only with method POST. "application/json" is the only supported ' +
              "value and the default, so this can be omitted.",
          ),
      },
    },
    async ({ url, maxAmountUsdc, asset, description, idempotencyKey, method, body, contentType }) => {
      // The caller records the purchase key before dispatch; this tool never invents a hidden identity.
      const effectiveKey = idempotencyKey;

      try {
        const result = await agent.pay(url, {
          maxAmountUsdc,
          asset,
          description,
          idempotencyKey: effectiveKey,
          method,
          body,
          contentType,
          // Read-only: the SDK polls the status and never executes (MR-503).
          waitForOutcome: PAY_OUTCOME_WAIT,
        });
        return jsonResult({
          ...describePayResult(result),
          replayed: result.replayed,
          idempotencyKey: effectiveKey,
        });
      } catch (error) {
        if (error instanceof GenesisPayOutcomeWaitTimeoutError) {
          // Not an error result: the purchase is in progress, and an isError
          // payload reads to a model like something to fix by buying again.
          return jsonResult(describeNotConfirmed(error, effectiveKey));
        }
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
        "Buy only listings whose asset is USDC or absent, and pass their " +
        "priceUsdc as maxAmountUsdc; that ceiling guards USDC listings only. " +
        "A listing in any other asset is marked notPayable: do not call " +
        "genesispay_pay for it, tell the user instead. Results include the " +
        "title, description, price, the payable resourceUrl and, when the " +
        "directory knows them, the purchase method, the settlement asset and " +
        "the shop the listing belongs to. A listing with method POST is bought " +
        "with genesispay_pay method \"POST\" and the exact JSON body the API expects.",
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
          listings: listings.map(describeListing),
          // The listed price is a ceiling to pass, not the price paid: the
          // resource's own 402 challenge stays the price authority. The engine
          // applies maxAmount only when the payment asset equals the asset
          // filter (USDC here — the only asset this tool can select), so the
          // ceiling guards USDC listings and nothing else (MR-102/MR-501).
          instructions:
            listings.length > 0
              ? "Pick the best match among listings whose asset is USDC or absent and pay " +
                "for its resourceUrl with genesispay_pay, passing its priceUsdc as " +
                "maxAmountUsdc — that ceiling guards USDC listings only. Do not call " +
                "genesispay_pay for a listing marked notPayable (another asset); tell the " +
                "user instead. If the listing says method: POST, also pass method \"POST\" " +
                "and the exact JSON body the API expects."
              : "No services matched. Try a shorter or different keyword query.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "genesispay_shops",
    {
      title: "Find shops in the GenesisPay directory",
      description:
        "Searches the GenesisPay discovery directory for shops. Read-only; it " +
        "moves no money. Returns each shop's id, name, description, " +
        "storefrontUrl, category and productCount. storefrontUrl is the shop's " +
        "page for humans, not a payable URL: to buy, find the shop's products " +
        "with genesispay_discover (listings name their shop) and pay a " +
        "listing's resourceUrl with genesispay_pay.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional keyword search, e.g. "coffee", "travel".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results, 1 to 50."),
      },
    },
    async ({ query, limit }) => {
      if (!agent.shops) {
        return errorResult(
          new Error(
            "This GenesisPay agent client cannot search shops; upgrade @genesis-tech/genesispay-agent to 1.1.0 or later.",
          ),
        );
      }

      try {
        const shops = await agent.shops(query ?? "", { limit });
        return jsonResult({
          query: query ?? null,
          count: shops.length,
          shops,
          instructions:
            shops.length > 0
              ? "To buy from a shop, search its products with genesispay_discover and pay a listing's resourceUrl with genesispay_pay. storefrontUrl is for humans, not for paying."
              : "No shops matched. Try a shorter or different keyword, or search products directly with genesispay_discover.",
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

  const resource = describeCapturedResource(result);

  return {
    status: "settled",
    paymentId: result.paymentId,
    txHash: result.txHash,
    amountUsdc: formatUsdcMinor(result.payment.amountUsdcMinor),
    resourceUrl: result.payment.resourceUrl,
    // The purchase request the server confirmed; absent on a server that
    // predates the echo (then it was a GET — the SDK refuses a POST without it).
    ...(result.requestMethod ? { requestMethod: result.requestMethod } : {}),
    ...(result.bodySha256 ? { bodySha256: result.bodySha256 } : {}),
    resource,
    // A replay returns the retained payment, never a second resource fetch
    // (ADR-0076). Without this a model reads `resource: null` as "the purchase
    // delivered nothing" and buys again under a new key.
    ...(result.replayed && resource === null
      ? { instructions: SETTLED_REPLAY_GUIDANCE }
      : {}),
  };
}

function describeCapturedResource(
  result: AgentPaymentResult,
): Record<string, unknown> | null {
  if (!result.response) {
    return null;
  }

  const { status, mimeType } = result.response;

  // A queued hosted link answers the paid request 202 with a settlement
  // acceptance; after the server's follow-up settles it, that capture is what
  // the result carries. Its `state: "queued"` must not read as "not done yet".
  const acceptance = status === 202 ? { note: SETTLEMENT_ACCEPTANCE_NOTE } : {};

  if (!isTextLikeMimeType(mimeType)) {
    return {
      status,
      mimeType,
      note: "Binary response body omitted.",
      ...acceptance,
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
    ...acceptance,
  };
}

/**
 * The `genesispay_pay` answer after the bounded wait ran out (MR-306). Built
 * from the payment row, not from the SDK's error message, so the text the model
 * reads is exactly the guidance and never calls the payment failed.
 */
function describeNotConfirmed(
  error: GenesisPayOutcomeWaitTimeoutError,
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    status: error.payment.status,
    outcome: "not_confirmed_yet",
    paymentId: error.payment.id,
    amountUsdc: formatUsdcMinor(error.payment.amountUsdcMinor),
    resourceUrl: error.payment.resourceUrl,
    idempotencyKey: error.idempotencyKey ?? idempotencyKey,
    instructions: NOT_CONFIRMED_GUIDANCE,
  };
}

/**
 * A listing as the model sees it: the additive fields only when the server sent
 * them. A non-USDC listing is kept (the user may want to know it exists) but
 * marked `notPayable`: this server can only select USDC, and the engine applies
 * the `maxAmountUsdc` ceiling only to a payment in the filtered asset, so paying
 * such a listing here would be either refused or unguarded.
 */
function describeListing(listing: DiscoveredService): Record<string, unknown> {
  const payableAsset = listing.asset === undefined || listing.asset === "USDC";
  return {
    ...(payableAsset
      ? {}
      : {
          notPayable: true,
          note: `Settles in ${listing.asset}, not USDC. Do not call genesispay_pay for this listing; tell the user it cannot be bought with this agent wallet.`,
        }),
    ...(listing.id !== undefined ? { id: listing.id } : {}),
    title: listing.title,
    description: listing.description,
    priceUsdc: listing.priceUsdc,
    kind: listing.kind,
    resourceUrl: listing.resourceUrl,
    category: listing.category,
    ...(listing.method !== undefined ? { method: listing.method } : {}),
    ...(listing.asset !== undefined ? { asset: listing.asset } : {}),
    ...(listing.shop ? { shop: listing.shop } : {}),
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
    // A row the server reports as `approved`/`executing` is still in flight on
    // the server, not a lost authorization: the model's move is to poll, and
    // "may already have been charged" would be premature. Anything else —
    // `unresolved`, or no readable row at all — keeps the MR-306 warning.
    const status = error.payment?.status;
    details.instructions =
      status === "approved" || status === "executing"
        ? APPROVED_GUIDANCE
        : UNRESOLVED_GUIDANCE;

    if (error.idempotencyKey ?? idempotencyKey) {
      details.idempotencyKey = error.idempotencyKey ?? idempotencyKey;
    }

    // Replaces, never accompanies, the generic guidance above.
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayIdempotencyConflictError) {
    details.paymentId = error.paymentId;
    details.paymentStatus = error.payment?.status ?? null;
    details.instructions = "This saved key belongs to different or historical request terms. Read the original payment with genesispay_payment_status. Do not change the key to bypass this conflict.";
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
        ? "The earlier attempt with this idempotencyKey was never charged and can no longer be. To buy this now, retry with a NEW idempotencyKey. " +
          "A fresh attempt needs the user's go-ahead and a NEW idempotencyKey recorded before the call."
        : "This purchase was already requested and was NOT paid for twice. Read its status instead of retrying.";
  }

  if (error instanceof GenesisPayPolicyBlockedError) {
    // MR-502: a hard block, not an approval request. Nothing was created
    // (the 4xx branch above already withheld retry guidance); this says what
    // to do instead, so the model stops rather than probing for a way round.
    details.instructions = POLICY_BLOCKED_GUIDANCE;
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayApiError) {
    details.code = error.code;
    details.httpStatus = error.status;
  }

  if (error instanceof GenesisPayApprovalTimeoutError) {
    details.paymentId = error.payment.id;
    details.approvalUrl = error.approvalUrl;
    details.instructions = APPROVAL_GUIDANCE;
    // APPROVAL_GUIDANCE forbids a new key for this purchase and says a same-key
    // call only returns this payment, while the generic guidance says "retry
    // with this same key". One payload
    // must not carry both; the specific instruction wins.
    delete details.retryGuidance;
  }

  if (error instanceof GenesisPayPaymentFailedError) {
    details.paymentId = error.payment?.id ?? null;
    details.paymentStatus = error.payment?.status ?? null;
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
