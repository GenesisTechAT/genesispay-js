# @genesis-tech/peerpay-agent

Client SDK for the PeerDirect (formerly PeerPay) Agent API: pay for x402-gated URLs from an agent
wallet with spending policies, human approvals, and full audit trail handled
by PeerDirect.

## Install

```bash
npm install @genesis-tech/peerpay-agent
```

## Quick start

```ts
import { PeerPayAgent } from "@genesis-tech/peerpay-agent";

const agent = new PeerPayAgent({
  apiKey: process.env.PEERPAY_AGENT_KEY, // pp_ag_... (default: env PEERPAY_AGENT_KEY)
  baseUrl: "https://your-peerpay-instance.example", // default: env PEERPAY_BASE_URL
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
- Denied or expired → `PeerPayApprovalRejectedError`.
- No decision within `timeoutMs` → `PeerPayApprovalTimeoutError` (the payment
  stays pending; surface `error.approvalUrl` to the user and check again later
  with `paymentStatus()`).

## API

| Method | Description |
| --- | --- |
| `pay(url, options?)` | Pay for an x402-gated URL. Options: `maxAmountUsdc`, `description`, `waitForApproval`. |
| `discover(query, options?)` | Search the public PeerDirect discovery directory for x402-payable services. Options: `category`, `limit` (default 20, max 50). Returns `DiscoveredService[]`; pass a result's `resourceUrl` to `pay()`. |
| `paymentStatus(paymentId)` | Fetch the current payment record (status, txHash, failureReason, ...). |
| `executePayment(paymentId)` | Execute an already-approved payment (idempotent). |
| `account()` | Account snapshot: wallet, USDC balance, spending policy, spend totals. |

`pay`/`executePayment` resolve to an `AgentPaymentResult`:

- `status` — `"settled"` or `"pending_approval"`.
- `txHash`, `payment` (full record), `approvalUrl` (pending only).
- `bytes()` / `body()` / `json()` — the paid resource's response (settled
  payments; throws a descriptive error when the capture is unavailable).

## Errors

All API failures throw typed errors from `@genesis-tech/peerpay-agent`:

| Error | When |
| --- | --- |
| `PeerPayAuthError` | 401 — missing/revoked agent key. |
| `PeerPayPolicyBlockedError` | 403 — allowlist hard-blocked the target; the owner must edit the allowlist. |
| `PeerPayPaymentRejectedError` | 402/422 — e.g. `amount_exceeds_max`, `payment_not_required`, `unsupported_payment_requirement`. Check `error.code`. |
| `PeerPayPaymentFailedError` | Payment executed but failed to settle; carries the payment record. |
| `PeerPayApprovalRejectedError` | Pending payment was denied or expired. |
| `PeerPayApprovalTimeoutError` | `waitForApproval` window elapsed; payment still pending. |
| `PeerPayApiError` | Anything else (network errors use `code: "network_error"`). |

## Environment variables

- `PEERPAY_AGENT_KEY` — agent API key (`pp_ag_...`), created on the PeerDirect
  dashboard under your agent account's Keys tab.
- `PEERPAY_BASE_URL` — base URL of the PeerDirect deployment.

Amounts are integer USDC minor units (6 decimals) as strings everywhere in
the payment records; `maxAmountUsdc` is a human-readable decimal like
`"0.50"`.
