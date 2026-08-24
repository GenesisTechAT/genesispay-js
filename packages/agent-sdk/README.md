# @genesis-tech/genesispay-agent

Client SDK for the GenesisPay (formerly GenesisPay) Agent API: pay for x402-gated URLs from an agent
wallet with spending policies, human approvals, and full audit trail handled
by GenesisPay.

## Install

```bash
npm install @genesis-tech/genesispay-agent
```

## Quick start

```ts
import { GenesisPayAgent } from "@genesis-tech/genesispay-agent";

const agent = new GenesisPayAgent({
  apiKey: process.env.GENESISPAY_AGENT_KEY, // gp_ag_... (default: env GENESISPAY_AGENT_KEY)
  baseUrl: "https://your-genesispay-instance.example", // default: env GENESISPAY_BASE_URL
});

const result = await agent.pay("https://api.example.com/premium", {
  maxAmountUsdc: "0.50",
});

if (result.settled) {
  console.log(result.txHash);
  console.log(result.json()); // the paid resource's response body
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
const result = await agent.pay("https://api.example.com/premium", {
  maxAmountUsdc: "5.00",
  waitForApproval: { timeoutMs: 10 * 60_000, pollIntervalMs: 5_000 },
});
```

- Approved → the payment executes and you get a settled result.
- Denied or expired → `GenesisPayApprovalRejectedError`.
- No decision within `timeoutMs` → `GenesisPayApprovalTimeoutError` (the payment
  stays pending; surface `error.approvalUrl` to the user and check again later
  with `paymentStatus()`).

## API

| Method | Description |
| --- | --- |
| `pay(url, options?)` | Pay for an x402-gated URL. Options: `maxAmountUsdc`, `description`, `waitForApproval`. |
| `discover(query, options?)` | Search the public GenesisPay discovery directory for x402-payable services. Options: `category`, `limit` (default 20, max 50). Returns `DiscoveredService[]`; pass a result's `resourceUrl` to `pay()`. |
| `paymentStatus(paymentId)` | Fetch the current payment record (status, txHash, failureReason, ...). |
| `executePayment(paymentId)` | Execute an already-approved payment (idempotent). |
| `account()` | Account snapshot: wallet, USDC balance, spending policy, spend totals. |

`pay`/`executePayment` resolve to an `AgentPaymentResult`:

- `status` — `"settled"` or `"pending_approval"`.
- `txHash`, `payment` (full record), `approvalUrl` (pending only).
- `bytes()` / `body()` / `json()` — the paid resource's response (settled
  payments; throws a descriptive error when the capture is unavailable).

## Errors

All API failures throw typed errors from `@genesis-tech/genesispay-agent`:

Every one of them extends `GenesisPayApiError`, so a single `instanceof` check is
exhaustive.

| Error | When | Safe to retry? |
| --- | --- | --- |
| `GenesisPayPaymentFailedError` | Nothing was signed — the payment was refused before any authorization existed. | **Yes**, nothing moved. |
| `GenesisPayPaymentOutcomeUnknownError` | Whether money moved is **unknown**. Covers a dropped connection or 5xx during `pay()`/`executePayment()`, and a `waitForApproval` timeout on a payment that was already executing. | **Only with the same `idempotencyKey`.** |
| `GenesisPayUnresolvedPaymentError` | The server confirmed it: the authorization reached the resource, the outcome is unknown. A subclass of the row above — carries `payment`. | **Only with the same `idempotencyKey`.** |
| `GenesisPayDuplicatePaymentError` | 409 — this `idempotencyKey` already has a payment, so nothing was charged twice. Read `paymentId`. | Don't. Read its status. |
| `GenesisPayAuthError` | 401 — missing/revoked agent key. | After fixing the key. |
| `GenesisPayPolicyBlockedError` | 403 — the spending policy hard-blocked it: an allowlist miss, a revoked delegation, a revoked key, or a paused account. The message says which. | No — the owner must act. |
| `GenesisPayPaymentRejectedError` | Rejected **before anything was signed** — a bad or unreachable URL, a free resource, a requirement we cannot pay, an amount over your own ceiling. Check `error.code`; note `target_unreachable` is a 502 because the failure is the seller's endpoint, so branch on the class, not the status. | Yes, once the cause is addressed. |
| `GenesisPayApprovalRejectedError` | The pending payment was denied or expired. | No. A denial is an answer. |
| `GenesisPayApprovalTimeoutError` | The `waitForApproval` window elapsed while the payment was **still `pending_approval`**. Nothing moved; the approval URL is still live. | Poll `paymentStatus()`. |
| `GenesisPayApiError` | Anything else. Network failures on read-only calls use `code: "network_error"`. | Depends. |

> **The distinction that matters.** `failed` means *no money moved*.
> `GenesisPayPaymentOutcomeUnknownError` means *we do not know*. Treating the second
> like the first is how a buyer gets charged twice — so pass an
> `idempotencyKey` on every `pay()` call and reuse it on any retry. The server
> refuses a duplicate key outright, and the on-chain nonce is derived from it,
> so even a re-execution cannot settle twice.

## Environment variables

- `GENESISPAY_AGENT_KEY` — agent API key (`gp_ag_...`), created on the GenesisPay
  dashboard under your agent account's Keys tab.
- `GENESISPAY_BASE_URL` — base URL of the GenesisPay deployment.

Agent payments settle in **USDC on Base** in v1.

Amounts are integer USDC minor units (6 decimals) as strings everywhere in
the payment records; `maxAmountUsdc` is a human-readable decimal like
`"0.50"`.
