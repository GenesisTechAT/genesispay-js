import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { describe, expect, it } from "vitest";

import { CATALOG_TOOL_NAMES, handleGenesisPayCatalogMcpHttpRequest } from "./catalog-http.js";
import type { GenesisPayCatalogReader } from "./catalog-http.js";

const URL_ = "https://genesispay.example/mcp/catalog";
const ACCEPT_BOTH = "application/json, text/event-stream";

const catalog: GenesisPayCatalogReader = {
  search: async () => [],
  shops: async () => [],
  trending: async () => [],
  reviews: async () => null,
};

function post(body: unknown): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT_BOTH },
    body: JSON.stringify(body),
  });
}

describe("handleGenesisPayCatalogMcpHttpRequest (ADR-0113)", () => {
  it("lists only the four catalog tools over Streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (url, init) => handleGenesisPayCatalogMcpHttpRequest(new Request(url, init), { catalog }),
    });
    const client = new Client({ name: "catalog-http-test", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...CATALOG_TOOL_NAMES]);
    await client.close();
  });

  it("answers a stateless tools/call with one JSON body and no session id", async () => {
    const response = await handleGenesisPayCatalogMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "genesispay_catalog_trending", arguments: {} } }),
      { catalog },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ count: 0, listings: [] });
  });

  it("refuses a paying tool name as unknown", async () => {
    const response = await handleGenesisPayCatalogMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "genesispay_pay", arguments: { url: "https://x.example" } } }),
      { catalog },
    );
    const body = (await response.json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });

  it("answers GET and DELETE with 405 and refuses JSON-RPC batches", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await handleGenesisPayCatalogMcpHttpRequest(new Request(URL_, { method }), { catalog });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    const batch = await handleGenesisPayCatalogMcpHttpRequest(post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]), { catalog });
    expect(batch.status).toBe(400);
  });
});
