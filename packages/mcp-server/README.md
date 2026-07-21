# @genesis-tech/peerpay-mcp

MCP (Model Context Protocol) stdio server that lets AI agents pay for
x402-gated HTTP resources through PeerDirect (formerly PeerPay) — with spending policies and human
approvals enforced server-side.

Ships the `peerpay-mcp` binary and exposes four tools:

| Tool | Description |
| --- | --- |
| `peerpay_discover` | Search the PeerDirect discovery directory for x402-payable services; pay a result's `resourceUrl` with `peerpay_pay`. |
| `peerpay_pay` | Pay for an HTTP 402 (x402) gated URL with the agent wallet (USDC on Base) and return the paid response. |
| `peerpay_payment_status` | Check a payment's status (`pending_approval`, `approved`, `settled`, ...). |
| `peerpay_account` | Wallet address, USDC balance, spending policy, and spend totals. |

Payments above the account's caps pause as `pending_approval`. The tool result
then carries an `approvalUrl`; the model is instructed to surface that URL to
the user (who approves on the PeerDirect dashboard) rather than retrying the
payment.

## Configuration

Two environment variables:

- `PEERPAY_AGENT_KEY` — agent API key (`pp_ag_...`), created on the PeerDirect
  dashboard under your agent account's Keys tab.
- `PEERPAY_BASE_URL` — base URL of the PeerDirect deployment, e.g.
  `https://peerpay.example`.

## Claude Code

```bash
claude mcp add peerpay \
  --env PEERPAY_AGENT_KEY=pp_ag_your_key \
  --env PEERPAY_BASE_URL=https://your-peerpay-instance.example \
  -- npx -y @genesis-tech/peerpay-mcp
```

## Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "peerpay": {
      "command": "npx",
      "args": ["-y", "@genesis-tech/peerpay-mcp"],
      "env": {
        "PEERPAY_AGENT_KEY": "pp_ag_your_key",
        "PEERPAY_BASE_URL": "https://your-peerpay-instance.example"
      }
    }
  }
}
```

## Usage example (skill-style prompt)

Once connected, prompts like these drive the tools:

```txt
Check my PeerDirect balance, then buy the report at
https://api.example.com/reports/q2 if it costs at most 0.50 USDC.
```

The model will call `peerpay_account`, then `peerpay_pay` with
`maxAmountUsdc: "0.50"`. If the account's policy requires approval, the tool
returns the approval URL and the model asks you to approve it on the PeerDirect
dashboard, then polls `peerpay_payment_status`.

## Running directly

```bash
PEERPAY_AGENT_KEY=pp_ag_your_key \
PEERPAY_BASE_URL=https://your-peerpay-instance.example \
npx -y @genesis-tech/peerpay-mcp
```

The server speaks MCP over stdio; diagnostics go to stderr.

## Programmatic use

```ts
import { PeerPayAgent } from "@genesis-tech/peerpay-agent";
import { createPeerPayMcpServer } from "@genesis-tech/peerpay-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createPeerPayMcpServer({
  agent: new PeerPayAgent({ apiKey: "pp_ag_...", baseUrl: "https://peerpay.example" }),
});
await server.connect(new StdioServerTransport());
```
