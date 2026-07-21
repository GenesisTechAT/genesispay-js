#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PeerPayAgent } from "@genesis-tech/peerpay-agent";

import { createPeerPayMcpServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.PEERPAY_AGENT_KEY?.trim();
  const baseUrl = process.env.PEERPAY_BASE_URL?.trim();

  if (!apiKey || !baseUrl) {
    console.error(
      "peerpay-mcp: missing configuration.\n" +
        "  PEERPAY_AGENT_KEY  agent API key (pp_ag_...), created on the PeerPay dashboard\n" +
        "  PEERPAY_BASE_URL   base URL of the PeerPay deployment, e.g. https://peerpay.example",
    );
    process.exit(1);
  }

  const agent = new PeerPayAgent({ apiKey, baseUrl });
  const server = createPeerPayMcpServer({ agent });

  await server.connect(new StdioServerTransport());
  console.error("peerpay-mcp: listening on stdio");
}

main().catch((error: unknown) => {
  console.error(
    `peerpay-mcp: fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
