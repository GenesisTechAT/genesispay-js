#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { agentFromEnvironment } from "./cli-config.js";
import { createGenesisPayMcpServer } from "./server.js";

async function main(): Promise<void> {
  let agent;
  try {
    agent = agentFromEnvironment(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

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
