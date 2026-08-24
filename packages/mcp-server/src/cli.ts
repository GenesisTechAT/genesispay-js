#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GenesisPayAgent } from "@genesis-tech/genesispay-agent";

import { createGenesisPayMcpServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.GENESISPAY_AGENT_KEY?.trim();
  const baseUrl = process.env.GENESISPAY_BASE_URL?.trim();

  if (!apiKey || !baseUrl) {
    console.error(
      "genesispay-mcp: missing configuration.\n" +
        "  GENESISPAY_AGENT_KEY  agent API key (gp_ag_...), created on the GenesisPay dashboard\n" +
        "  GENESISPAY_BASE_URL   base URL of the GenesisPay deployment, e.g. https://genesispay.example",
    );
    process.exit(1);
  }

  const agent = new GenesisPayAgent({ apiKey, baseUrl });
  const server = createGenesisPayMcpServer({ agent });

  await server.connect(new StdioServerTransport());
  console.error("genesispay-mcp: listening on stdio");
}

main().catch((error: unknown) => {
  console.error(
    `genesispay-mcp: fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
