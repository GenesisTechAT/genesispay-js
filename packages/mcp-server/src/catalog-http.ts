// @genesis-tech/genesispay-mcp/catalog-http — the catalog-only MCP tools
// (ADR-0113) over Streamable HTTP. Read-only: it takes a catalog reader, never
// an agent, and lists exactly the four genesispay_catalog_* tools.

import { createGenesisPayCatalogMcpServer, CATALOG_TOOL_NAMES } from "./catalog-server.js";
import { handleStatelessMcpRequest } from "./stateless-http.js";
import type { GenesisPayCatalogReader } from "./catalog-types.js";

export { CATALOG_TOOL_NAMES };
export type {
  CatalogKind,
  CatalogListing,
  CatalogPrice,
  CatalogRating,
  CatalogReview,
  CatalogReviewsPage,
  CatalogSearchInput,
  CatalogShop,
  CatalogShopRef,
  GenesisPayCatalogReader,
} from "./catalog-types.js";

export type GenesisPayCatalogMcpHttpRequestOptions = {
  /** Read-only access to the public catalog. */
  catalog: GenesisPayCatalogReader;
};

/**
 * Serves one MCP Streamable HTTP request with the catalog tools. Stateless and
 * JSON-only, exactly like `@genesis-tech/genesispay-mcp/http`: a fresh server
 * per request, `405` with `Allow: POST` for other methods, JSON-RPC batches
 * refused with `400` / `-32600`.
 *
 * Authentication, admission, the body cap and Origin checks are the caller's;
 * the handler receives no credential and no identity, so nothing a tool does
 * can depend on who asked.
 */
export async function handleGenesisPayCatalogMcpHttpRequest(
  request: Request,
  options: GenesisPayCatalogMcpHttpRequestOptions,
): Promise<Response> {
  return handleStatelessMcpRequest(request, () =>
    createGenesisPayCatalogMcpServer({ catalog: options.catalog }),
  );
}
