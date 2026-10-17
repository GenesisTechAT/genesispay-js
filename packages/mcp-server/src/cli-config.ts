import { GenesisPayAgent } from "@genesis-tech/genesispay-agent";

const CONFIGURATION_HELP =
  "  GENESISPAY_AGENT_KEY  agent API key (gp_ag_...), created on the GenesisPay dashboard\n" +
  "  GENESISPAY_BASE_URL   base URL of the GenesisPay deployment, e.g. https://genesispay.example\n" +
  "                        (https; plain http only for localhost or 127.0.0.1)";

/**
 * The stdio CLI's agent, built from its two environment variables before the
 * server starts. A missing value or a base URL the agent SDK refuses — plain
 * http off this machine would send the spend-capable agent key in cleartext
 * (#947) — ends the process with the configuration help, never a server that
 * starts and leaks the key on its first tool call.
 */
export function agentFromEnvironment(env: Readonly<Record<string, string | undefined>>): GenesisPayAgent {
  const apiKey = env.GENESISPAY_AGENT_KEY?.trim();
  const baseUrl = env.GENESISPAY_BASE_URL?.trim();
  if (!apiKey || !baseUrl) {
    throw new Error(`genesispay-mcp: missing configuration.\n${CONFIGURATION_HELP}`);
  }
  try {
    return new GenesisPayAgent({ apiKey, baseUrl });
  } catch (error) {
    // #976: this reaches stderr, which MCP hosts log. The agent SDK already
    // never quotes a key-shaped or credential-bearing value; removing the
    // configured key here as well makes "never the agent key" hold for any
    // key format and any future message.
    const reason = (error instanceof Error ? error.message : String(error)).split(apiKey).join("***");
    throw new Error(`genesispay-mcp: invalid configuration: ${reason}\n${CONFIGURATION_HELP}`);
  }
}
