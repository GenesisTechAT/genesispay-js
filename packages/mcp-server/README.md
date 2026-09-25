# @genesis-tech/genesispay-mcp

MCP (Model Context Protocol) stdio server that lets AI agents pay for
x402-gated HTTP resources through GenesisPay — with spending policies and human
approvals enforced server-side.

Setup requires a GenesisPay deployment that serves `/api/v2/agent/pay` and
MCP server version 1.0 or later. POST purchases additionally need a deployment
that confirms them (its v2 answer echoes `requestMethod` and `bodySha256`);
against an older one the purchase is reported as an unknown outcome, never as
a success.

Ships the `genesispay-mcp` binary and exposes five tools:

| Tool | Description |
| --- | --- |
| `genesispay_discover` | Search the GenesisPay discovery directory for x402-payable services; pay a result's `resourceUrl` with `genesispay_pay`, passing its `priceUsdc` as `maxAmountUsdc`. Listings carry `method`, `asset` and `shop` when the directory knows them; only USDC (or asset-less) listings are payable — others come back `notPayable`, because the ceiling guards USDC payments only. |
| `genesispay_shops` | Read-only search of the shop directory (`id`, `name`, `description`, `storefrontUrl`, `category`, `productCount`). `storefrontUrl` is for humans; buy a shop's products via `genesispay_discover`. |
| `genesispay_trending` | Read-only: what is trending on GenesisPay right now (`limit` 1–20, default 10). Listed products ranked by distinct buyers of paid orders in the last 7 days (coarse bands; the signal may be up to 60 s old, listing is always current), newest listed after them; each carries `rank`, `priceUsdc`, `priceMinor`, `asset`, `resourceUrl`, `method`, `shop` and `signal` (`"sales"` or `"new"`) — never a count. Buy one only after confirming with the user, via `genesispay_pay` with its `priceUsdc` as `maxAmountUsdc`; non-USDC products come back `notPayable`. |
| `genesispay_pay` | Pay for an HTTP 402 (x402) gated URL with the agent wallet (USDC on Base) and return the paid response. `method: "POST"` with the exact JSON `body` buys a body-priced API. |
| `genesispay_payment_status` | Check a payment's status (`pending_approval`, `approved`, `settled`, `denied`, `failed`, `expired`, `unresolved`). |
| `genesispay_account` | Wallet address, USDC balance, spending policy, and spend totals. |

Payments above the account's caps pause as `pending_approval`. The tool result
then carries an `approvalUrl` (`/dashboard/approvals?payment=<paymentId>`, which
highlights that entry); the model is instructed to tell the user the amount,
`resourceUrl` and `paymentId`, and to poll `genesispay_payment_status` rather
than retrying the payment. Approving executes it server-side. An allowlist miss
or a paused account is `policy_blocked`: a hard stop, not an approval request —
the model is told to stop and tell the user rather than retry under another key.

## `unresolved`, and why the model is told not to retry

If a seller takes the signed payment and then times out or errors, whether it
settled is genuinely unknown — they can still redeem it. That is reported as
**`unresolved`**, never as `failed`, because `failed` would claim no money
moved. On both the pay path and the status path the model is told, in the tool
result itself, that the buyer **may already have been charged** and must not buy
the item again.

`genesispay_pay` requires a nonblank `idempotencyKey` of at most 200 characters.
Generate and save it in the purchase/job record **before the first tool call**;
the tool never invents a key. The convention the tool description teaches is
`<purpose>-<yyyymmdd>-<6 random chars>` (e.g. `q2-report-20260923-k7f2qa`),
written into the reply together with `url`, `maxAmountUsdc` and the optional
`description` before the call, then reused unchanged on every retry. A new key
is only for a genuinely new purchase, or after the purchase was reported
`failed`. `description` is part of the request terms. It echoes the key on success and failure, but the
saved record is what lets you recover when the entire first response is lost.
Reuse identical request terms and that same key. The strict v2 API returns the
original payment state without a second authorization or resource fetch. A
settled replay has `replayed: true` and `resource: null`; recover fulfillment from
the merchant's original record. Different or historical request terms return
`idempotency_conflict` with the original locator; do not bypass it with a new key.
Approved/executing/unresolved results require polling that original payment.
Deploy the v2 server before upgrading this client. V1 remains compatible, but
this MCP version does not fall back to it.

## Not confirmed yet: the bounded wait

A payment can be accepted before it is confirmed — a hosted GenesisPay link with
the settlement queue answers `202`, and GenesisPay then waits for the chain.
`genesispay_pay` therefore waits up to 25 s after the pay call, only reading
the payment's status (it never executes or re-sends anything), and returns the
settled result if confirmation arrives. If the payment is still unconfirmed,
the result is **not** an error and never says `failed`:

```json
{
  "status": "unresolved",
  "outcome": "not_confirmed_yet",
  "paymentId": "…",
  "idempotencyKey": "…",
  "instructions": "This payment is not confirmed yet. … the buyer MAY ALREADY HAVE BEEN CHARGED. … poll genesispay_payment_status … until it reports settled or another final status (failed, denied or expired). Never buy this item again with a new idempotencyKey …"
}
```

**Time budget.** MCP clients cancel a request after 60 s by default (Claude
Code: `MCP_TOOL_TIMEOUT`). A typical pay call returns within ~15 s — probe,
preparation, signed request, and GenesisPay's own 12 s follow-up wait for a
queued link — so pay plus the 25 s wait stays inside 60 s. The pay request
itself is deliberately not cut off client-side: GenesisPay gives a slow seller
up to 60 s for the signed request, and aborting our side would not stop the
server, only turn a probable success into an unknown outcome without a
`paymentId`. If a slow seller pushes the call past your client's timeout, the
client cancels it; retrying with the same `idempotencyKey` and terms is safe and
returns the original payment. Raise the client timeout if your sellers are slow.

## POST purchases with a body

Some x402 APIs price or admit a request by its body. When a
`genesispay_discover` listing says `method: "POST"`, the model calls
`genesispay_pay` with `method: "POST"` and the exact JSON text the API expects
as `body` (at most 256 KiB; `contentType` defaults to `application/json`, the
only supported value):

```json
{
  "url": "https://api.example.com/v1/forecast",
  "idempotencyKey": "forecast-20260924-k7f2qa",
  "maxAmountUsdc": "0.05",
  "method": "POST",
  "body": "{\"horizon\":\"7d\",\"city\":\"Zurich\"}"
}
```

The body is part of the purchase identity and is sent byte-for-byte, never
re-serialized. Every retry with the same key must carry the byte-identical body;
a different or reformatted body with the same key ends in
`idempotency_conflict`. Never put secrets or personal data in it — it is stored
with the payment. A settled result reports the confirmed `requestMethod` and
`bodySha256`.

## Configuration

Two environment variables:

- `GENESISPAY_AGENT_KEY` — agent API key (`gp_ag_...`), created on the GenesisPay
  dashboard under your agent account's Keys tab.
- `GENESISPAY_BASE_URL` — base URL of the GenesisPay deployment, e.g.
  `https://genesispay.example`.

## Claude Code

```bash
claude mcp add genesispay \
  --env GENESISPAY_AGENT_KEY=gp_ag_your_key \
  --env GENESISPAY_BASE_URL=https://your-genesispay-instance.example \
  -- npx -y @genesis-tech/genesispay-mcp@1.2.0
```

## Codex

```bash
codex mcp add genesispay --env GENESISPAY_AGENT_KEY=gp_ag_your_key --env GENESISPAY_BASE_URL=https://your-genesispay-instance.example -- npx -y @genesis-tech/genesispay-mcp@1.2.0
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.genesispay]
command = "npx"
args = ["-y", "@genesis-tech/genesispay-mcp@1.2.0"]
env = { GENESISPAY_AGENT_KEY = "gp_ag_your_key", GENESISPAY_BASE_URL = "https://your-genesispay-instance.example" }
```

## Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "genesispay": {
      "command": "npx",
      "args": ["-y", "@genesis-tech/genesispay-mcp@1.2.0"],
      "env": {
        "GENESISPAY_AGENT_KEY": "gp_ag_your_key",
        "GENESISPAY_BASE_URL": "https://your-genesispay-instance.example"
      }
    }
  }
}
```

## Usage example (skill-style prompt)

Once connected, prompts like these drive the tools:

```txt
Check my GenesisPay balance, then buy the report at
https://api.example.com/reports/q2 if it costs at most 0.50 USDC.
```

The model will call `genesispay_account`, then `genesispay_pay` with
`maxAmountUsdc: "0.50"` and a previously saved `idempotencyKey`. If the account's policy requires approval, the tool
returns the approval URL and the model asks you to approve it on the GenesisPay
dashboard, then polls `genesispay_payment_status`.

```txt
Find a 7-day weather forecast API in the GenesisPay directory and buy one
forecast for Zurich.
```

The model calls `genesispay_discover`, sees a USDC listing with
`method: "POST"` and `priceUsdc`, then calls `genesispay_pay` with
`maxAmountUsdc` set to that price, `method: "POST"` and the JSON body the API
documents. A listing in another asset comes back `notPayable` with a note; the
model tells you instead of paying, because the ceiling guards USDC payments
only.

```txt
What is trending on GenesisPay right now?
```

The model calls `genesispay_trending` and lists the products, saying which rank
by recent sales and which are simply new. It moves no money; if you then pick
one, the model confirms with you and pays its `resourceUrl` with
`genesispay_pay`, passing its `priceUsdc` as `maxAmountUsdc`.

## Running directly

```bash
GENESISPAY_AGENT_KEY=gp_ag_your_key \
GENESISPAY_BASE_URL=https://your-genesispay-instance.example \
npx -y @genesis-tech/genesispay-mcp@1.2.0
```

The server speaks MCP over stdio; diagnostics go to stderr.

## Programmatic use

```ts
import { GenesisPayAgent } from "@genesis-tech/genesispay-agent";
import { createGenesisPayMcpServer } from "@genesis-tech/genesispay-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createGenesisPayMcpServer({
  agent: new GenesisPayAgent({ apiKey: "gp_ag_...", baseUrl: "https://genesispay.example" }),
});
await server.connect(new StdioServerTransport());
```
