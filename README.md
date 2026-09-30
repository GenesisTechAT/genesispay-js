# genesispay-js

JavaScript/TypeScript SDKs for [GenesisPay](https://genesispay.finance) — stablecoin
payments over HTTP 402 (x402) that work for both humans and AI agents. USDC on
Base; every amount is integer minor units, never floats.

| Package | What it does |
| --- | --- |
| [`@genesis-tech/genesispay-seller`](packages/seller-sdk) | Framework-agnostic payment gate: wrap any Fetch-API handler (Next.js, Hono, Bun) and it becomes a paid x402 endpoint. |
| [`@genesis-tech/genesispay-agent`](packages/agent-sdk) | Agent-side client: pay x402-gated URLs (GET, or POST with an exact JSON body) from a policy-guarded agent wallet, discover payable services and shops, handle human approvals. |
| [`@genesis-tech/genesispay-mcp`](packages/mcp-server) | MCP stdio server (`npx @genesis-tech/genesispay-mcp`) exposing `genesispay_discover` / `genesispay_shops` / `genesispay_pay` / `genesispay_payment_status` / `genesispay_account` tools to Claude and other MCP clients. |
| [`@genesis-tech/genesispay-protocol`](packages/protocol) | Pure x402 V2 types, header codecs, validators, and EIP-3009 typed-data helpers. Zero I/O. |

## Sell: gate an endpoint

```ts
import { createPaymentGate, genesisPaySettlement } from "@genesis-tech/genesispay-seller";

const gate = createPaymentGate({
  amountUsdc: "0.10",
  payTo: "0xYourWallet",
  description: "Premium market data",
  network: "base-sepolia",
});

export const GET = gate.wrap(async () => Response.json({ data: "…" }), {
  verifySettlement: genesisPaySettlement({
    facilitatorBaseUrl: "https://your-genesispay-instance.example",
    apiKey: process.env.GENESISPAY_SELLER_KEY!, // gp_sk_...
  }),
});
```

## Buy: pay from an agent

```ts
import { GenesisPayAgent } from "@genesis-tech/genesispay-agent";

const agent = new GenesisPayAgent(); // env: GENESISPAY_AGENT_KEY, GENESISPAY_BASE_URL

const [service] = await agent.discover("weather api");
// Persist the key with your order before the first call, then reuse it on retries.
const result = await agent.pay(service.resourceUrl, { idempotencyKey: "saved-order-42", maxAmountUsdc: "0.50" });

if (result.settled) if (result.response) console.log(result.json()); // Replay has no captured resource body.
else console.log("Needs human approval:", result.approvalUrl);
```

Spending caps, allowlists, and approvals are enforced server-side by GenesisPay —
the agent key never holds a raw private key.

## Give your AI agent the tools

```bash
claude mcp add genesispay \
  --env GENESISPAY_AGENT_KEY=gp_ag_your_key \
  --env GENESISPAY_BASE_URL=https://your-genesispay-instance.example \
  -- npx -y @genesis-tech/genesispay-mcp
```

See [`GenesisTechAT/genesispay-agent-skill`](https://github.com/GenesisTechAT/genesispay-agent-skill)
for the full agent skill (discovery-then-pay pattern, approval handling) and
config snippets for other MCP clients.

## Development

```bash
npm ci
npm run build   # tsc -b, dependency order
npm test        # vitest, tests run from package sources
```

Node >= 20.9. Each package builds to `dist/` with `tsc`; tests are colocated
(`src/*.test.ts`).

This repository is a read-only publish mirror — development happens in the
main GenesisPay repository and is synced here. Issues and PRs are welcome and are
folded back upstream.

## Releasing

1. Bump versions in `packages/*/package.json`.
2. Confirm npm Trusted Publishing authorizes `.github/workflows/publish.yml`
   for every package. The workflow uses GitHub OIDC (`id-token: write`); it does
   not read an `NPM_TOKEN` secret.
3. Tag the reviewed snapshot and push that tag.
4. The [publish workflow](.github/workflows/publish.yml) builds, tests, verifies
   pack manifests, and publishes only package versions absent from npm.

## License

[MIT](LICENSE) © GenesisTech
