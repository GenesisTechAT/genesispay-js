/**
 * The catalog card (ADR-0113): an MCP App (SEP-1865) that hosts such as
 * claude.ai and ChatGPT draw inline for `genesispay_catalog_search` and
 * `genesispay_catalog_trending` when the catalog server is created with
 * `card: true`.
 *
 * Display only, and less than that: it shows a picture, title, shop, short
 * description and display price of up to three products, and up to ten more
 * products as plain text. It has no link (not even the public page), no
 * button and no form, never calls a tool and never opens a link; every
 * catalog tool is `visibility: ["model"]`, so a spec-conforming host refuses
 * a `tools/call` from any app. Services are never drawn. The model carries no
 * URL of any kind.
 *
 * Built on the money-free shell (app-card-shell.ts): its CSP, style and
 * protocol client. Seller text reaches the card only as data and is written
 * with `textContent`. Pictures come only from the result's `_meta`
 * (`APP_CARD_IMAGES_META_KEY`), never from `structuredContent`.
 */
import { appCardToolMeta, cardDocument } from "./app-card-shell.js";
import type { CatalogListing } from "./catalog-types.js";

/** The listing fields the card reads; nothing else (no URL, no buy path) reaches it. */
type CardListing = Pick<CatalogListing, "id" | "type" | "title" | "description" | "price" | "shop">;

export const CATALOG_CARD_RESOURCE_URI = "ui://genesispay/catalog-card";

/** Products drawn as cards per answer; further products are a plain list. */
export const CATALOG_CARDS_MAX = 3;
const CATALOG_CARD_LIST_MAX = 10;
const DESCRIPTION_MAX_CHARS = 280;

/** The one sentence every card ends with. */
export const CATALOG_CARD_FOOTER = "Display only: this card has no links or buttons.";
const LISTED_ONLY_NOTE = "Listed price; shipping and tax are added by the shop.";

/** `_meta` for the two tools the card renders. */
export const catalogCardToolMeta = appCardToolMeta(CATALOG_CARD_RESOURCE_URI);

type CatalogCardProduct = {
  id: string;
  title: string;
  shopName: string | null;
  description: string | null;
  /** The display price string, exactly as the tool result shows it. */
  price: string | null;
  /** Set when the shop adds shipping and tax to the listed price. */
  listedOnlyNote: string | null;
  /** The key of this product's picture in the result `_meta`, or null for a placeholder. */
  pictureKey: string | null;
};

export type CatalogCardData = {
  version: 1;
  kind: "listings";
  products: CatalogCardProduct[];
  more: Array<{ id: string; title: string; shopName: string | null; price: string | null }>;
  /** Products after the cards, including those the list leaves out. */
  moreCount: number;
};

function shortText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function products<T extends CardListing>(listings: readonly T[]): T[] {
  return listings.filter((listing) => listing.type === "product");
}

/** The ids of the products the card draws, in order: the only pictures worth fetching. */
export function catalogCardProductIds(listings: readonly CardListing[]): string[] {
  return products(listings).slice(0, CATALOG_CARDS_MAX).map((listing) => listing.id);
}

/**
 * The card for a list answer: its first three products as cards, up to ten
 * more as a list; services are left out. Null when the answer has no
 * product, so the result carries no card at all. `images` names the products
 * whose picture the result's `_meta` carries.
 */
export function catalogListingsCard(
  listings: readonly CardListing[],
  images: ReadonlySet<string>,
): CatalogCardData | null {
  const all = products(listings);
  if (all.length === 0) return null;
  const rest = all.slice(CATALOG_CARDS_MAX);
  return {
    version: 1,
    kind: "listings",
    products: all.slice(0, CATALOG_CARDS_MAX).map((listing) => ({
      id: listing.id,
      title: listing.title,
      shopName: listing.shop?.name ?? null,
      description: shortText(listing.description, DESCRIPTION_MAX_CHARS),
      price: listing.price?.display ?? null,
      listedOnlyNote: listing.price?.listedOnly ? LISTED_ONLY_NOTE : null,
      pictureKey: images.has(listing.id) ? listing.id : null,
    })),
    more: rest.slice(0, CATALOG_CARD_LIST_MAX).map((listing) => ({
      id: listing.id,
      title: listing.title,
      shopName: listing.shop?.name ?? null,
      price: listing.price?.display ?? null,
    })),
    moreCount: rest.length,
  };
}

/*
 * The renderer, run inside the shell's client, which provides text, el, well
 * and fine. It draws `structuredContent.catalogCard` only, and pictures only
 * from `_meta` (no content-index fallback).
 */
const RENDERER = `
  var FOOTER = __FOOTER__;

  function catalogCard(card, result) {
    var section = el("section");
    section.setAttribute("aria-label", "Products");
    var grid = el("div", "grid");
    (Array.isArray(card.products) ? card.products : []).forEach(function (product) {
      if (!product || !text(product.title)) return;
      var article = el("article", "card");
      article.appendChild(well(result, text(product.pictureKey), null, product.title));
      var body = el("div", "body");
      if (text(product.shopName)) body.appendChild(el("p", "shop", product.shopName));
      var title = el("h2", "title clamp", product.title);
      title.title = product.title;
      body.appendChild(title);
      if (text(product.description)) body.appendChild(el("p", "desc clamp", product.description));
      if (text(product.price)) {
        var price = el("p", "price");
        price.appendChild(el("span", "amount", product.price));
        if (text(product.listedOnlyNote)) price.appendChild(el("span", "plus", product.listedOnlyNote));
        body.appendChild(price);
      }
      article.appendChild(body);
      grid.appendChild(article);
    });
    section.appendChild(grid);
    var more = Array.isArray(card.more) ? card.more : [];
    if (more.length > 0) {
      var wrap = el("div", "more");
      wrap.appendChild(el("h3", null, "More products"));
      var list = el("ul");
      more.forEach(function (product) {
        if (!product || !text(product.title)) return;
        var item = el("li");
        var name = el("span", "name", product.title);
        name.title = product.title;
        item.appendChild(name);
        if (text(product.shopName)) item.appendChild(el("span", "shopname", product.shopName));
        if (text(product.price)) item.appendChild(el("span", "listed", product.price));
        list.appendChild(item);
      });
      wrap.appendChild(list);
      var extra = typeof card.moreCount === "number" ? card.moreCount - more.length : 0;
      if (extra > 0) wrap.appendChild(el("p", "rest", "and " + extra + " more in the answer"));
      section.appendChild(wrap);
    }
    section.appendChild(fine(FOOTER));
    return section;
  }

  function renderCard(result) {
    var card = result.structuredContent && result.structuredContent.catalogCard;
    if (!card || card.version !== 1 || card.kind !== "listings") return null;
    return catalogCard(card, result);
  }
`;

/** The card document. No seller or user data is ever templated into it. */
export function catalogCardHtml(appVersion: string): string {
  return cardDocument({
    title: "GenesisPay catalog card",
    appName: "genesispay-catalog-card",
    appVersion,
    render: RENDERER.replace("__FOOTER__", () => JSON.stringify(CATALOG_CARD_FOOTER)),
  });
}
