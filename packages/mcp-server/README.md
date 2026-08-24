# @genesis-tech/genesispay-mcp

MCP (Model Context Protocol) stdio server that lets AI agents pay for
x402-gated HTTP resources through GenesisPay (formerly GenesisPay) — with spending policies and human
approvals enforced server-side.

Ships the `genesispay-mcp` binary and exposes four tools:

| Tool | Description |
| --- | --- |
| `genesispay_discover` | Search the GenesisPay discovery directory for x402-payable services; pay a result's `resourceUrl` with `genesispay_pay`. |
| `genesispay_pay` | Pay for an HTTP 402 (x402) gated URL with the agent wallet (USDC on Base) and return the paid response. |
| `genesispay_payment_status` | Check a payment's status (`pending_approval`, `approved`, `settled`, `denied`, `failed`, `expired`, `unresolved`). |
| `genesispay_account` | Wallet address, USDC balance, spending policy, and spend totals. |

Payments above the account's caps pause as `pending_approval`. The tool result
then carries an `approvalUrl`; the model is instructed to surface that URL to
the user (who approves on the GenesisPay dashboard) rather than retrying the
payment.

## `unresolved`, and why the model is told not to retry

If a seller takes the signed payment and then times out or errors, whether it
settled is genuinely unknown — they can still redeem it. That is reported as
**`unresolved`**, never as `failed`, because `failed` would claim no money
moved. On both the pay path and the status path the model is told, in the tool
result itself, that the buyer **may already have been charged** and must not buy
the item again.

`genesispay_pay` takes an `idempotencyKey` and **generates one per call** when you
omit it, returning the effective key on success *and* on failure. Reusing that
key on a retry makes it the same payment rather than a second one: the server
refuses the duplicate outright, and the on-chain nonce is derived from the key,
so even a re-execution cannot settle twice.

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
  -- npx -y @genesis-tech/genesispay-mcp
```

## Codex

```bash
codex mcp add genesispay --env GENESISPAY_AGENT_KEY=gp_ag_your_key --env GENESISPAY_BASE_URL=https://your-genesispay-instance.example -- npx -y @genesis-tech/genesispay-mcp
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.genesispay]
command = "npx"
args = ["-y", "@genesis-tech/genesispay-mcp"]
env = { GENESISPAY_AGENT_KEY = "gp_ag_your_key", GENESISPAY_BASE_URL = "https://your-genesispay-instance.example" }
```

## Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "genesispay": {
      "command": "npx",
      "args": ["-y", "@genesis-tech/genesispay-mcp"],
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
`maxAmountUsdc: "0.50"`. If the account's policy requires approval, the tool
returns the approval URL and the model asks you to approve it on the GenesisPay
dashboard, then polls `genesispay_payment_status`.

## Running directly

```bash
GENESISPAY_AGENT_KEY=gp_ag_your_key \
GENESISPAY_BASE_URL=https://your-genesispay-instance.example \
npx -y @genesis-tech/genesispay-mcp
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
