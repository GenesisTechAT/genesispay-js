// @genesis-tech/genesispay-mcp/http — the GenesisPay MCP tools over Streamable HTTP.

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createGenesisPayMcpServer } from "./server.js";
import type { GenesisPayAgentLike } from "./server.js";
import { handleStatelessMcpRequest } from "./stateless-http.js";

export type { AuthInfo };
export type { GenesisPayAgentLike };

export type GenesisPayMcpHttpRequestOptions = {
  /** The agent client the tools call, already bound to the caller's identity. */
  agent: GenesisPayAgentLike;
  /** The caller's validated credential, handed to the MCP request handlers. */
  authInfo?: AuthInfo;
};

/**
 * Serves one MCP Streamable HTTP request with the same tools as the stdio
 * server (`createGenesisPayMcpServer`), so remote and stdio are identical by
 * construction.
 *
 * Stateless and JSON-only (`stateless-http.ts`): a fresh server and transport
 * per request, one buffered `application/json` body, `405` with `Allow: POST`
 * for `GET` and `DELETE`, JSON-RPC batches refused with `400` / `-32600`.
 *
 * The caller authenticates and builds `agent`; this function owns only the
 * protocol. It never reads `request.signal`: a tool call keeps running to its
 * recorded outcome when the client disconnects, which is what a payment in
 * flight needs (MR-306).
 */
export async function handleGenesisPayMcpHttpRequest(
  request: Request,
  options: GenesisPayMcpHttpRequestOptions,
): Promise<Response> {
  return handleStatelessMcpRequest(
    request,
    () => createGenesisPayMcpServer({ agent: options.agent }),
    options.authInfo,
  );
}
