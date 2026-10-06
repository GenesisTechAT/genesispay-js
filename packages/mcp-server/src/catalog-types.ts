/** Types only. Covered by packages/mcp-server/src/catalog-server.test.ts:136 (no payable field reaches a tool output) (no colocated test by design). */
/**
 * The catalog connector's data contract (ADR-0113): what a catalog reader
 * returns and what the four catalog tools put in front of a model.
 *
 * Deliberately narrow. No type here has a field that could carry a payable
 * URL, an HTTP method, x402 terms, a purchase key or any other purchase
 * preparation: a result names a thing and the public page where a human buys
 * it, nothing more. Prices are display strings the reader formatted from
 * integer minor units (MR-101); this package does no money arithmetic.
 */

/** A display price, e.g. `"0.10 USDC"`. `listedOnly`: the shop sets shipping and tax at its own checkout. */
export type CatalogPrice = {
  display: string;
  listedOnly: boolean;
};

/** Published, visible reviews only; `average` is null when `count` is 0. */
export type CatalogRating = {
  count: number;
  average: number | null;
};

export type CatalogShopRef = {
  /** `shop_…` */
  id: string;
  name: string;
  /** The shop's public page on GenesisPay (absolute URL). */
  pageUrl: string;
};

/** One product or service, as the public Explore pages show it. */
export type CatalogListing = {
  /** `prod_…`, a listing id, or `ext_…` for a curated external service. */
  id: string;
  type: "product" | "service";
  title: string;
  description: string | null;
  price: CatalogPrice | null;
  category: string | null;
  shop: CatalogShopRef | null;
  rating: CatalogRating | null;
  /** The seller's own preview picture URL; never fetched by this package. */
  imageUrl: string | null;
  /** The public GenesisPay page for this result (absolute URL). */
  pageUrl: string;
};

export type CatalogShop = {
  /** `shop_…` */
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  productCount: number;
  rating: CatalogRating | null;
  /** The shop's public page on GenesisPay (absolute URL). */
  pageUrl: string;
};

export type CatalogReview = {
  pseudonym: string;
  stars: number;
  comment: string;
  publishedAt: string;
  verifiedPurchase: true;
};

export type CatalogReviewsPage = {
  /** The product (`prod_…`) or service (`ext_…`) the reviews are about. */
  id: string;
  rating: CatalogRating;
  reviews: CatalogReview[];
  /** Pass unchanged to read the next page; null on the last page. */
  nextCursor: string | null;
  /** The public page the reviews are shown on (absolute URL). */
  pageUrl: string;
};

/** `kind` filter: "physical" = goods shipped by a shop, "digital" = everything else. */
export type CatalogKind = "physical" | "digital";

export type CatalogSearchInput = {
  query?: string;
  kind?: CatalogKind;
  /** `shop_…`: only this shop's listings. */
  shop?: string;
  category?: string;
  limit: number;
};

/**
 * Read-only access to the public catalog. There is no write method and no
 * agent or caller identity: a catalog read is the same for everyone who may
 * call the endpoint. `reviews` answers null for an id that has no public page.
 */
export interface GenesisPayCatalogReader {
  search(input: CatalogSearchInput): Promise<CatalogListing[]>;
  shops(input: { query?: string; limit: number }): Promise<CatalogShop[]>;
  trending(input: { limit: number }): Promise<CatalogListing[]>;
  reviews(input: { id: string; limit: number; cursor?: string }): Promise<CatalogReviewsPage | null>;
}
