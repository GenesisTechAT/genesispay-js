/** Covered by packages/agent-sdk/src/client.test.ts:1444 (payable vs quote-only listings) (no colocated test by design). */
import type { DiscoveredPayableService, DiscoveredQuoteProduct, DiscoveredService } from "./types.js";

/** A result you may pass to `pay()` (by its `resourceUrl`). */
export function isPayableListing(listing: DiscoveredService): listing is DiscoveredPayableService {
  return listing.purchase?.mode !== "quote" && typeof listing.resourceUrl === "string";
}

/** A quote-only physical product: call `quote({ productId: listing.purchase.productId, quantity })`. */
export function isQuoteProduct(listing: DiscoveredService): listing is DiscoveredQuoteProduct {
  return listing.purchase?.mode === "quote";
}
