/**
 * The product card: an MCP App (the "MCP Apps" extension, SEP-1865,
 * `io.modelcontextprotocol/ui`) that hosts such as claude.ai and ChatGPT
 * render inline, in a sandboxed iframe, for `genesispay_discover` (physical
 * results) and `genesispay_quote`. Those hosts do not show a tool result's
 * image blocks to the user; an MCP App can.
 *
 * Display only. The card has no button, link or form, never calls a tool and
 * never opens a link: it draws what the tool result already says, and every
 * tool this server registers is `visibility: ["model"]`, so a spec-conforming
 * host refuses a `tools/call` from any app (`modelOnlyToolMeta`). Buying stays
 * in the chat, where the user confirms the address and total (MR-506).
 *
 * The HTML is one self-contained document: inline CSS and script, no fonts,
 * scripts or network. Seller text reaches it only as data and is written with
 * `textContent`, never parsed as markup. Pictures are bytes from GenesisPay's
 * image proxy (ADR-0108): the card reads them from the result's `_meta`
 * (`PRODUCT_CARD_IMAGES_META_KEY`), which hosts give the card and not the
 * model, and falls back to the result's own image blocks by content index.
 * They are never copied into `structuredContent`, which some hosts give the
 * model, so no base64 is read as text.
 *
 * The document CSP, shared style and in-frame protocol client are the shell's
 * (app-card-shell.ts, shared with the catalog card); this file keeps the
 * discover and quote models and their renderer.
 */
import type {
  CommerceQuote,
  DiscoveredQuoteProduct,
  DiscoveredService,
} from "@genesis-tech/genesispay-agent";

import {
  APP_CARD_IMAGES_META_KEY,
  APP_CARD_RESOURCE_META,
  appCardToolMeta,
  cardDocument,
} from "./app-card-shell.js";

export { MCP_APP_MIME_TYPE, MCP_APPS_PROTOCOL_VERSION, modelOnlyToolMeta } from "./app-card-shell.js";

export const PRODUCT_CARD_RESOURCE_URI = "ui://genesispay/product-card";

/**
 * The tool result `_meta` key that carries the card's pictures:
 * `{ [productId]: { mimeType, data } }` (the shell's key, shared with the
 * catalog card).
 */
export const PRODUCT_CARD_IMAGES_META_KEY = APP_CARD_IMAGES_META_KEY;

/** Cards shown at most per discovery answer; further physical results are a compact list. */
export const PRODUCT_CARDS_MAX = 3;
const PRODUCT_CARD_LIST_MAX = 10;
const DESCRIPTION_MAX_CHARS = 280;

/** No origin at all: the shell's empty CSP (`APP_CARD_CSP`). */
export const PRODUCT_CARD_RESOURCE_META = APP_CARD_RESOURCE_META;

/** `_meta` for the two tools the card renders (`genesispay_discover`, `genesispay_quote`). */
export const productCardToolMeta = appCardToolMeta(PRODUCT_CARD_RESOURCE_URI);

/** One picture of a result: the index of its `image` block in `content`. */
export type ProductCardImages = ReadonlyMap<string, number>;

type CardProduct = {
  productId: string;
  title: string;
  description: string | null;
  shopName: string | null;
  listedPriceUsdc: string;
  asset: string;
  notPayable: boolean;
  imageContentIndex: number | null;
};

export type ProductCardData =
  | {
    version: 1;
    kind: "discover";
    products: CardProduct[];
    more: Array<{ productId: string; title: string; shopName: string | null; listedPriceUsdc: string; asset: string;
      notPayable: boolean }>;
    moreCount: number;
  }
  | {
    version: 1;
    kind: "quote";
    productId: string;
    quantity: number;
    title: string | null;
    shopName: string | null;
    shipTo: CommerceQuote["shipTo"];
    addressStatus: string;
    options: Array<{ label: string; subtotalUsdc: string; shippingUsdc: string; taxUsdc: string; totalUsdc: string }>;
    expiresAt: string;
    imageContentIndex: number | null;
  };

function isQuoteProduct(listing: DiscoveredService): listing is DiscoveredQuoteProduct {
  return listing.purchase?.mode === "quote";
}

function shortText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * The card for a discovery answer: its quote-only physical products only
 * (payable listings are not drawn — the card must never look like a buy
 * button), the first three as cards and up to ten more as a list. Null when
 * the answer has no physical product, so no card is offered at all.
 */
export function discoverProductCard(
  listings: readonly DiscoveredService[],
  images: ProductCardImages,
): ProductCardData | null {
  const physical = listings.filter(isQuoteProduct);
  if (physical.length === 0) return null;
  const rest = physical.slice(PRODUCT_CARDS_MAX);
  return {
    version: 1,
    kind: "discover",
    products: physical.slice(0, PRODUCT_CARDS_MAX).map((listing) => ({
      productId: listing.purchase.productId,
      title: listing.title,
      description: shortText(listing.description, DESCRIPTION_MAX_CHARS),
      shopName: listing.shop?.name ?? null,
      listedPriceUsdc: listing.purchase.listedPriceUsdc,
      asset: listing.asset ?? "USDC",
      notPayable: listing.asset !== undefined && listing.asset !== "USDC",
      imageContentIndex: images.get(listing.purchase.productId) ?? null,
    })),
    more: rest.slice(0, PRODUCT_CARD_LIST_MAX).map((listing) => ({
      productId: listing.purchase.productId,
      title: listing.title,
      shopName: listing.shop?.name ?? null,
      listedPriceUsdc: listing.purchase.listedPriceUsdc,
      asset: listing.asset ?? "USDC",
      notPayable: listing.asset !== undefined && listing.asset !== "USDC",
    })),
    moreCount: rest.length,
  };
}

/**
 * The card for a quote: every figure exactly as the server sent it (MR-101),
 * the address exactly as the quote result shows it. The option ids and the
 * quoteToken are left out: the card has nothing to buy with.
 */
export function quoteProductCard(
  quote: CommerceQuote,
  request: { productId: string; quantity: number },
  details: { title: string; shopName: string | null } | null,
  images: ProductCardImages,
): ProductCardData {
  return {
    version: 1,
    kind: "quote",
    productId: request.productId,
    quantity: request.quantity,
    title: details?.title ?? null,
    shopName: details?.shopName ?? null,
    shipTo: quote.shipTo,
    addressStatus: quote.addressStatus,
    options: quote.options.map((option) => ({
      label: option.label,
      subtotalUsdc: option.subtotalUsdc,
      shippingUsdc: option.shippingUsdc,
      taxUsdc: option.taxUsdc,
      totalUsdc: option.totalUsdc,
    })),
    expiresAt: quote.expiresAt,
    imageContentIndex: images.get(request.productId) ?? null,
  };
}

/** The quote card's own layout, after the shell's shared style. */
const STYLE = `
.quote { flex-direction: row; flex-wrap: wrap; }
.quote .well { width: 152px; flex: 0 0 152px; aspect-ratio: 1 / 1; align-self: flex-start; margin: 14px 0 14px 14px;
  border: 1px solid var(--gp-border); border-radius: 10px; }
@media (max-width: 460px) {
  .quote .well { width: auto; flex: 1 1 100%; aspect-ratio: 4 / 3; margin: 0; border: 0; border-radius: 0;
    border-bottom: 1px solid var(--gp-border); }
}
.quote .body { flex: 1 1 240px; gap: 6px; }
.quote .title { -webkit-line-clamp: 3; font-size: 15px; }
.tag { align-self: flex-start; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--gp-surface); color: var(--gp-muted); }
.label { margin-top: 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--gp-muted); }
.options { border: 1px solid var(--gp-border); border-radius: 10px; overflow: hidden; }
.options li { padding: 8px 12px; border-top: 1px solid var(--gp-border); }
.options li:first-child { border-top: 0; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.total { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.address { background: var(--gp-surface); border-radius: 10px; padding: 8px 12px; }
.note { background: var(--gp-note-bg); color: var(--gp-note-text); border-radius: 8px; padding: 6px 10px; font-size: 12px; }
`;

/*
 * The renderer, run inside the shell's client (app-card-shell.ts), which
 * provides text, el, well and fine. It draws `structuredContent.productCard`
 * only.
 */
const RENDERER = `
  function amount(value, asset) {
    return text(value) ? value + " " + (text(asset) || "USDC") : null;
  }
  function price(value, asset) {
    var row = el("p", "price");
    var amountNode = el("span", "amount", value);
    amountNode.appendChild(el("span", "unit", " " + (text(asset) || "USDC")));
    row.appendChild(amountNode);
    row.appendChild(el("span", "plus", "+ shipping & tax"));
    return row;
  }

  function discoverCard(card, result) {
    var products = Array.isArray(card.products) ? card.products : [];
    var section = el("section");
    section.setAttribute("aria-label", "Physical products");
    var grid = el("div", "grid");
    products.forEach(function (product) {
      if (!product || !text(product.title)) return;
      var article = el("article", "card");
      article.appendChild(well(result, product.productId, product.imageContentIndex, product.title));
      var body = el("div", "body");
      if (text(product.shopName)) body.appendChild(el("p", "shop", product.shopName));
      var title = el("h2", "title clamp", product.title);
      title.title = product.title;
      body.appendChild(title);
      if (text(product.description)) body.appendChild(el("p", "desc clamp", product.description));
      if (text(product.listedPriceUsdc)) body.appendChild(price(product.listedPriceUsdc, product.asset));
      if (product.notPayable) {
        body.appendChild(el("p", "warn", "Settles in " + (text(product.asset) || "another asset") +
          ": not available with this agent wallet."));
      }
      article.appendChild(body);
      grid.appendChild(article);
    });
    section.appendChild(grid);
    var more = Array.isArray(card.more) ? card.more : [];
    if (more.length > 0) {
      var wrap = el("div", "more");
      wrap.appendChild(el("h3", null, "More results"));
      var list = el("ul");
      more.forEach(function (product) {
        if (!product || !text(product.title)) return;
        var item = el("li");
        var name = el("span", "name", product.title);
        name.title = product.title;
        item.appendChild(name);
        if (text(product.shopName)) item.appendChild(el("span", "shopname", product.shopName));
        var listed = amount(product.listedPriceUsdc, product.asset);
        if (listed) item.appendChild(el("span", "listed", listed));
        if (product.notPayable) item.appendChild(el("span", "warn", "Not available with this agent wallet."));
        list.appendChild(item);
      });
      wrap.appendChild(list);
      var extra = typeof card.moreCount === "number" ? card.moreCount - more.length : 0;
      if (extra > 0) wrap.appendChild(el("p", "rest", "and " + extra + " more in the answer"));
      section.appendChild(wrap);
    }
    section.appendChild(fine("Listed prices, not totals: shipping, tax and stock depend on the delivery address. " +
      "Display only, nothing here orders or pays. Ask in the chat for a quote; you confirm the delivery address and " +
      "the exact total there before anything is bought."));
    return section;
  }

  function expiry(value) {
    var date = text(value) ? new Date(value) : null;
    if (!date || isNaN(date.getTime())) return value || "";
    try { return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return value; }
  }

  function quoteCard(card, result) {
    var article = el("article", "card quote");
    article.setAttribute("aria-label", "Quote");
    article.appendChild(well(result, card.productId, card.imageContentIndex, card.title));
    var body = el("div", "body");
    body.appendChild(el("span", "tag", "Quote · nothing ordered yet"));
    body.appendChild(el("h2", "title clamp", text(card.title) || "Physical product"));
    var meta = ["Quantity " + (typeof card.quantity === "number" ? card.quantity : "?")];
    if (text(card.shopName)) meta.push("sold by " + card.shopName);
    body.appendChild(el("p", "muted small", meta.join(" · ")));

    var options = Array.isArray(card.options) ? card.options : [];
    body.appendChild(el("h3", "label", options.length === 1 ? "Shipping option" : "Shipping options"));
    var list = el("ol", "options");
    options.forEach(function (option) {
      if (!option) return;
      var item = el("li");
      var row = el("div", "row");
      row.appendChild(el("span", null, text(option.label) || "Shipping"));
      row.appendChild(el("span", "total", "Total " + (amount(option.totalUsdc) || "?")));
      item.appendChild(row);
      item.appendChild(el("p", "muted small", (amount(option.subtotalUsdc) || "?") + " + shipping " +
        (amount(option.shippingUsdc) || "?") + " + tax " + (amount(option.taxUsdc) || "?")));
      list.appendChild(item);
    });
    body.appendChild(list);

    var ship = card.shipTo || {};
    body.appendChild(el("h3", "label", "Ships to"));
    var address = el("div", "address");
    var lines = [text(ship.name)].concat(Array.isArray(ship.lines) ? ship.lines : [],
      [[text(ship.postalCode), text(ship.city)].filter(Boolean).join(" "), text(ship.state), text(ship.country)]);
    lines.forEach(function (line) { if (text(line)) address.appendChild(el("p", null, line)); });
    body.appendChild(address);
    if (card.addressStatus !== "confirmed") {
      body.appendChild(el("p", "note", "New address: the account owner approves the first order to it in the GenesisPay dashboard."));
    }
    body.appendChild(fine("Display only: nothing has been ordered or charged. Quote valid until " + expiry(card.expiresAt) +
      ". To buy, confirm the address and the option's total in the chat."));
    article.appendChild(body);
    return article;
  }

  function renderCard(result) {
    var card = result.structuredContent && result.structuredContent.productCard;
    if (!card || card.version !== 1) return null;
    if (card.kind === "discover") return discoverCard(card, result);
    if (card.kind === "quote") return quoteCard(card, result);
    return null;
  }
`;

/** The card document. No seller or user data is ever templated into it. */
export function productCardHtml(appVersion: string): string {
  return cardDocument({
    title: "GenesisPay product card",
    appName: "genesispay-product-card",
    appVersion,
    render: RENDERER,
    style: STYLE,
  });
}
