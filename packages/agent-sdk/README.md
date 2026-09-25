# @genesis-tech/genesispay-agent

Client SDK for the GenesisPay Agent API: pay for x402-gated URLs from an agent
wallet with spending policies, human approvals, and full audit trail handled
by GenesisPay.

## Install

Setup requires a GenesisPay deployment that serves `/api/v2/agent/pay` and
agent SDK version 1.0 or later. POST purchases (`method: "POST"` with a
`body`, below) additionally need a deployment that confirms them: its v2
answer echoes `requestMethod` and `bodySha256`. Against an older deployment
the SDK refuses to trust a POST result and throws an unknown-outcome error
instead (see [the echo check](#paying-a-body-priced-api-post)).

```bash
npm install @genesis-tech/genesispay-agent@1.2.0
```

## Quick start

```ts
import { GenesisPayAgent } from "@genesis-tech/genesispay-agent";

const agent = new GenesisPayAgent({
  apiKey: process.env.GENESISPAY_AGENT_KEY, // gp_ag_... (default: env GENESISPAY_AGENT_KEY)
  baseUrl: "https://your-genesispay-instance.example", // default: env GENESISPAY_BASE_URL
});

// Save this purchase key in your durable job/order record BEFORE the first call.
const result = await agent.pay("https://api.example.com/premium", {
  idempotencyKey: "saved-order-42",
  maxAmountUsdc: "0.50",
});

if (result.settled) {
  console.log(result.txHash);
  if (result.response) console.log(result.json()); // capture is null on replay
} else {
  // The account's spending policy requires a human decision.
  console.log("Approve at:", result.approvalUrl);
}
```

## Waiting for human approval

Payments above the account's caps go to `pending_approval`. Pass
`waitForApproval` and the client transparently polls
`GET /api/v1/agent/payments/:id` and calls
`POST /api/v1/agent/payments/:id/execute` once a human approves:

```ts
// Save this purchase key in your durable job/order record BEFORE the first call.
const result = await agent.pay("https://api.example.com/premium", {
  idempotencyKey: "saved-order-42",
  maxAmountUsdc: "5.00",
  waitForApproval: { timeoutMs: 10 * 60_000, pollIntervalMs: 5_000 },
});
```

- Approved → the payment executes and you get a settled result.
- Denied or expired → `GenesisPayApprovalRejectedError`.
- No decision within `timeoutMs` → `GenesisPayApprovalTimeoutError` (the payment
  stays pending; surface `error.approvalUrl` to the user and check again later
  with `paymentStatus()`).

## Paying a body-priced API (POST)

Some x402 APIs price or admit a request by its body — a forecast tiered by
`horizon`, a search priced by result count. Buy those with `method: "POST"`
and the **exact JSON text** of the body:

```ts
// Serialize once and save the string with the key: it is part of the purchase.
const body = JSON.stringify({ horizon: "7d", city: "Zurich" });
await saveOrder({ idempotencyKey: "forecast-20260924-k7f2qa", body });

const result = await agent.pay("https://api.example.com/v1/forecast", {
  idempotencyKey: "forecast-20260924-k7f2qa",
  maxAmountUsdc: "0.05", // e.g. the discovery listing's priceUsdc
  method: "POST",
  body, // contentType defaults to (and only supports) "application/json"
});
console.log(result.requestMethod, result.bodySha256); // "POST", hex SHA-256 of the body
```

- **The body is part of the purchase identity.** GenesisPay sends it
  byte-for-byte — to the seller's 402 probe, the settlement preparation and the
  signed request — and never re-serializes it. A retry with the same key must
  pass the identical string; a different or merely reformatted body (other
  spacing, other key order) is a different purchase and ends in
  `GenesisPayIdempotencyConflictError`. There is deliberately no `json:` helper:
  serializing for you would make the bytes depend on this SDK's version.
- **Validated before sending.** At most 256 KiB of UTF-8
  (`PURCHASE_BODY_MAX_BYTES`), well-formed Unicode, valid JSON, and only with
  `method: "POST"`. Anything else throws `GenesisPayPaymentRejectedError`
  (`request_body_invalid`, `request_body_too_large`, `unsupported_content_type`)
  and nothing is sent.
- **Do not put secrets or personal data in the body.** It is stored with the
  payment so an approved payment can be executed later with the same bytes; the
  approver sees its size and SHA-256, not its content.
- **The echo check.** A GenesisPay deployment that predates POST purchases
  silently drops `method` and `body` and buys the URL with **GET**. The SDK
  therefore trusts a POST result only when the response echoes
  `requestMethod: "POST"` and a `bodySha256` equal to the hash it computed
  locally (WebCrypto). Otherwise it throws `GenesisPayPaymentOutcomeUnknownError`
  with the `paymentId` and your key — a payment may have been made for a
  different request and may already have been charged. Check it with
  `paymentStatus()`, never retry under a new key, and buy with a body only once
  the deployment confirms POST purchases.

A discovery listing tells you which method to use: `listing.method === "POST"`
means pass `method: "POST"` and the body the API documents.

## Waiting for an unconfirmed outcome

A payment can be accepted before it is confirmed: a hosted GenesisPay link with
the settlement queue answers `202`, and the server records the payment
`unresolved` until the chain confirms it (the server already waits up to 12 s
before answering). Without options, `pay()` throws at once for `unresolved`
(`GenesisPayUnresolvedPaymentError`) and for `approved`/`executing`
(`GenesisPayPaymentOutcomeUnknownError`). Pass `waitForOutcome` to wait,
bounded, instead:

```ts
const result = await agent.pay("https://genesispay.example/pay/abc123", {
  idempotencyKey: "saved-order-43",
  maxAmountUsdc: "1.00",
  waitForOutcome: { timeoutMs: 30_000, pollIntervalMs: 2_000 }, // or `true` for these defaults
});
```

- The client only reads `paymentStatus()`; the delay doubles from
  `pollIntervalMs` up to 10 s and the last poll lands on the deadline. It never
  calls `executePayment()` — an `approved` payment is being executed by the
  server — and never signs or re-sends anything.
- `settled` → a settled result. For a queued hosted link, `response` is the
  captured `202` settlement acceptance, not a content body.
- `failed` → `GenesisPayPaymentFailedError`; `denied`/`expired` →
  `GenesisPayApprovalRejectedError`; a status this SDK does not know →
  `GenesisPayUnresolvedPaymentError`.
- Budget exhausted → `GenesisPayOutcomeWaitTimeoutError`, a subclass of
  `GenesisPayPaymentOutcomeUnknownError` carrying `payment`, `paymentId`,
  `idempotencyKey` and `waitedMs`. **Not confirmed yet is not failed:** the
  payment may already have been charged and may still settle. Keep polling
  `paymentStatus(error.paymentId)`; never buy again with a new key.
- `waitForApproval` is unchanged and independent: it is the option that
  executes an approved payment, and it still stops at `unresolved`.

## API

| Method | Description |
| --- | --- |
| `pay(url, options)` | Strict v2 payment. Required: saved `idempotencyKey`; optional: `maxAmount`, `maxAmountUsdc`, `asset`, `description`, `method`, `body`, `contentType`, `waitForApproval`, `waitForOutcome`. |
| `discover(query, options?)` | Search the public GenesisPay discovery directory for x402-payable services. Options: `category`, `limit` (default 20, max 50). Returns `DiscoveredService[]`; pass a result's `resourceUrl` to `pay()` and, for a listing whose `asset` is USDC or absent, its `priceUsdc` as `maxAmountUsdc` (the resource's 402 stays the price authority; the ceiling guards USDC payments only, so do not buy a listing in another asset with this SDK). Newer servers add `id`, `method` (`"POST"` → pay with `method`/`body`), `asset` and `shop` (`{ id, name, storefrontUrl }` or null); a malformed additive field reads as absent. |
| `shops(query?, options?)` | Search the public shop directory (`GET /api/v1/discovery/shops`). Option: `limit`. Returns `DiscoveredShop[]` (`id`, `name`, `description`, `storefrontUrl`, `category`, `productCount`); `storefrontUrl` is for humans — buy a shop's products via `discover()`. Malformed entries are dropped. |
| `trending(options?)` | What is trending right now (`GET /api/v1/discovery/trending`, no auth). Option: `limit` (default 10, max 20). Returns `TrendingProduct[]` (`rank`, `id`, `title`, `description`, `asset`, `priceMinor` — integer minor units as a string, `priceUsdc`, `method`, `resourceUrl`, `category`, `shop`, `signal`: `"sales"` when ranked by distinct buyers of paid orders in the last 7 days (coarse bands, at least 3), `"new"` when ranked by listing date). No count is ever exposed; the sales signal may be up to 60 s old, listing and eligibility are always current. Pass a USDC product's `resourceUrl` to `pay()` with its `priceUsdc` as `maxAmountUsdc`. Malformed entries are dropped. |
| `paymentStatus(paymentId)` | Fetch the current payment record (status, txHash, failureReason, ...). |
| `executePayment(paymentId)` | Execute an already-approved payment (idempotent). |
| `account()` | Account snapshot: wallet, USDC balance, spending policy, spend totals. |

`pay`/`executePayment` resolve to an `AgentPaymentResult`:

- `status` — `"settled"` or `"pending_approval"`.
- `txHash`, `payment` (full record), `approvalUrl` (pending only).
- `idempotencyKey` and `replayed` preserve purchase identity.
- `requestMethod` / `bodySha256` — the purchase request the server confirmed
  (`null` when an older server sent no echo for a GET, and on results that did
  not come from a pay envelope).
- `response` is explicitly null on replay or whenever the original capture is unavailable.
- `bytes()` / `body()` / `json()` — the paid resource's response (settled
  payments; throws a descriptive error when the capture is unavailable).

## Errors

The separately gated experimental contract-mandate purchase API is
`POST /api/v1/agent/mandates/:mandateId/pay`. Use an already owner-approved
mandate and send `idempotencyKey`, decimal-integer `grossMinor`, `resourceUrl`
and optional `description`. Recipients, asset, network and fees are fixed by
the mandate. This endpoint reserves a payment; HTTP 202 is not settlement.
Read its `paymentId` with `paymentStatus()` until canonical confirmation.
Exact replay returns the same payment with HTTP 200; a changed request using
the same key returns 409. Resource URLs are audit metadata, not fulfillment.
Owner setup is a dashboard operation, never agent-key authority. This API is
off by default and has no Mainnet release clearance. The 1.x Agent SDK does
not export a helper for this route; use of the raw route is a separate reviewed
integration, not part of the #346 strict-payment canary.

`executePayment()` receiving HTTP 202 throws
`GenesisPayPaymentOutcomeUnknownError` with the original payment ID and key.
Keep polling that payment; do not create another purchase. The approval wait
loop continues polling after a queued execution response.

All API failures throw typed errors from `@genesis-tech/genesispay-agent`:

Every one of them extends `GenesisPayApiError`, so a single `instanceof` check is
exhaustive.

| Error | When | Safe to retry? |
| --- | --- | --- |
| `GenesisPayPaymentFailedError` | Nothing was signed — the payment was refused before any authorization existed. | **Yes**, nothing moved. |
| `GenesisPayPaymentOutcomeUnknownError` | Whether money moved is **unknown**. Covers a dropped connection or 5xx during `pay()`/`executePayment()`, and a `waitForApproval` timeout on a payment that was already executing. | **Only with the same `idempotencyKey`.** |
| `GenesisPayUnresolvedPaymentError` | The server confirmed it: the authorization reached the resource, the outcome is unknown. A subclass of the row above — carries `payment`. | **Only with the same `idempotencyKey`.** |
| `GenesisPayOutcomeWaitTimeoutError` | `waitForOutcome` ran out while the payment was still `unresolved`, `approved` or `executing`. Not confirmed yet — not failed. A subclass of `GenesisPayPaymentOutcomeUnknownError`; carries `payment` and `waitedMs`. | **Only with the same `idempotencyKey`**; keep polling `paymentStatus()`. |
| `GenesisPayIdempotencyConflictError` | 409 — the saved key identifies different or historical request terms. Carries original `paymentId` and `payment` when available. | Read the original payment; do not use a fresh key to bypass the conflict. |
| `GenesisPayDuplicatePaymentError` | Legacy 409 from an older API response. | Read the original payment. |
| `GenesisPayAuthError` | 401 — missing/revoked agent key. | After fixing the key. |
| `GenesisPayPolicyBlockedError` | 403 — the spending policy hard-blocked it: an allowlist miss, a revoked delegation, a revoked key, or a paused account. The message says which. | No — the owner must act. |
| `GenesisPayPaymentRejectedError` | Rejected **before anything was signed** — a bad or unreachable URL, a free resource, a requirement we cannot pay, an amount over your own ceiling, or a POST body refused locally (`status: 0`, nothing sent). Check `error.code`; note `target_unreachable` is a 502 because the failure is the seller's endpoint, so branch on the class, not the status. | Yes, once the cause is addressed. |
| `GenesisPayApprovalRejectedError` | The pending payment was denied or expired. | No. A denial is an answer. |
| `GenesisPayApprovalTimeoutError` | The `waitForApproval` window elapsed while the payment was **still `pending_approval`**. Nothing moved; the approval URL is still live. | Poll `paymentStatus()`. |
| `GenesisPayApiError` | Anything else. Network failures on read-only calls use `code: "network_error"`. | Depends. |

> **The distinction that matters.** `failed` means *no money moved*.
> `GenesisPayPaymentOutcomeUnknownError` means *we do not know*. Treating the second
> like the first is how a buyer gets charged twice — so pass an
> `idempotencyKey` on every `pay()` call and reuse it on any retry. The server
> replays the original matching payment without signing or fetching the resource
> again. Different request terms fail closed. Every `pay()` API error retains
> your saved `idempotencyKey`; there is no fallback to an unkeyed v1 request.

## Migration from the optional-key client

This source version uses `POST /api/v2/agent/pay`; deploy v2 before upgrading the
client. V1 remains available to existing integrations. Keys are required at
compile time and runtime (trimmed, 1–200 characters). Generate and persist one
key per purchase, then reuse the same URL, maximum, asset filter, description
and — for a POST — method and byte-identical body on retries. Never generate a replacement key just because the first response
was lost. Decimal aliases normalize identically but must agree when both supplied.
Omitted asset selection differs from an explicit USDC filter.

A matching replay returns authoritative current state. Settled replay resolves
with `replayed: true` and `response: null`; retrieve fulfillment through the
merchant's original purchase record instead of paying again. Approved/executing
replays raise `GenesisPayPaymentOutcomeUnknownError`; unresolved raises its
subclass — unless `waitForOutcome` is set, which first waits for them.
Poll `paymentStatus(error.paymentId)`. Failed/denied/expired replays
retain their terminal record and raise the corresponding typed error. Pending
approval still exposes the human approval URL.

## Environment variables

- `GENESISPAY_AGENT_KEY` — agent API key (`gp_ag_...`), created on the GenesisPay
  dashboard under your agent account's Keys tab.
- `GENESISPAY_BASE_URL` — base URL of the GenesisPay deployment.

Agent payments settle in **USDC on Base** in v1.

Amounts are integer USDC minor units (6 decimals) as strings everywhere in
the payment records; `maxAmountUsdc` is a human-readable decimal like
`"0.50"`.
