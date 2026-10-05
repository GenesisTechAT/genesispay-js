// Stateless, JSON-only MCP Streamable HTTP plumbing shared by the full remote
// handler (`./http.js`) and the catalog handler (`./catalog-http.js`). It owns
// the protocol envelope only and never sees a tool, an agent or a credential
// beyond the `authInfo` it forwards.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * Serves one MCP Streamable HTTP request on a fresh server from `createServer`.
 *
 * Stateless and JSON-only: every request gets a fresh server and transport
 * (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), the response
 * is one buffered `application/json` body, and nothing survives the request.
 * No session means no sticky routing and no standalone SSE stream, so any
 * method but `POST` answers `405` with `Allow: POST`. JSON-RPC batches are
 * refused with `400` / `-32600` (see `refuseBeforeTransport`).
 *
 * It never reads `request.signal`: a tool call keeps running to its recorded
 * outcome when the client disconnects, which is what a payment in flight
 * needs (MR-306).
 */
export async function handleStatelessMcpRequest(
  request: Request,
  createServer: () => McpServer,
  authInfo?: AuthInfo,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonRpcError(400, -32700, "Parse error: the request body could not be read.");
  }

  const refusal = refuseBeforeTransport(bodyText);
  if (refusal) {
    return refusal;
  }

  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    // In JSON mode the transport resolves only once every response of the
    // request is ready, with a fully buffered body, so closing afterwards
    // cannot truncate it. The reconstructed request carries no signal, so a
    // client disconnect never reaches the transport (MR-306).
    return await transport.handleRequest(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
      }),
      { authInfo },
    );
  } finally {
    await server.close();
  }
}

/**
 * Messages this stateless handler answers itself, before any server exists.
 *
 * - A JSON-RPC batch (a top-level array) gets `400` / `-32600`. Protocol
 *   2025-06-18 removed batching, and a batch pairing a `tools/call` with a
 *   `notifications/cancelled` for the same id makes the SDK drop that
 *   response, so the JSON-mode promise would never resolve.
 * - A lone `notifications/cancelled` gets `202`. Without a session it can never
 *   target a request in flight, so the transport never needs to see it.
 *
 * Unparseable JSON returns `undefined` and goes to the transport, which answers
 * `400` / `-32700`.
 */
function refuseBeforeTransport(bodyText: string): Response | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed)) {
    return jsonRpcError(400, -32600, "Invalid Request: batch requests are not supported.");
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "method" in parsed &&
    parsed.method === "notifications/cancelled" &&
    !("id" in parsed)
  ) {
    return new Response(null, { status: 202 });
  }

  return undefined;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
    {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    },
  );
}
