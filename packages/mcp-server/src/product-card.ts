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
 * `textContent`, never parsed as markup. Pictures are the tool result's own
 * image blocks (bytes from GenesisPay's image proxy, ADR-0108), which the card
 * finds by content index — they are never copied into `structuredContent`,
 * which some hosts give the model, so no base64 is duplicated or read as text.
 */
import type {
  CommerceQuote,
  DiscoveredQuoteProduct,
  DiscoveredService,
} from "@genesis-tech/genesispay-agent";

export const PRODUCT_CARD_RESOURCE_URI = "ui://genesispay/product-card";

/** The MCP Apps resource type (SEP-1865 `RESOURCE_MIME_TYPE`). */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The latest MCP Apps protocol version the card speaks in `ui/initialize`. */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/** Cards shown at most per discovery answer; further physical results are a compact list. */
export const PRODUCT_CARDS_MAX = 3;
const PRODUCT_CARD_LIST_MAX = 10;
const DESCRIPTION_MAX_CHARS = 280;

/**
 * No origin at all: the card fetches nothing, loads nothing and embeds
 * nothing. With every list empty the host's sandbox is its restrictive
 * default (`connect-src 'none'`, `img-src 'self' data:`), and the document's
 * own CSP narrows images to `data:` only.
 */
export const PRODUCT_CARD_CSP = {
  connectDomains: [] as string[],
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
  baseUriDomains: [] as string[],
};

export const PRODUCT_CARD_RESOURCE_META = {
  ui: { csp: PRODUCT_CARD_CSP, prefersBorder: false },
};

/**
 * `_meta` for the two tools the card renders. `ui.resourceUri` is the
 * standard key; `ui/resourceUri` (the deprecated flat key the official helper
 * still writes) and `openai/outputTemplate` (ChatGPT's alias) point at the
 * same resource for hosts that read only those.
 */
export const productCardToolMeta = {
  ui: { resourceUri: PRODUCT_CARD_RESOURCE_URI, visibility: ["model"] },
  "ui/resourceUri": PRODUCT_CARD_RESOURCE_URI,
  "openai/outputTemplate": PRODUCT_CARD_RESOURCE_URI,
};

/**
 * `_meta` for every other tool: callable by the model, never by an app. A
 * host MUST reject an app's `tools/call` for a tool without "app" visibility
 * (SEP-1865), so no card, ours or injected, can reach `genesispay_pay`.
 */
export const modelOnlyToolMeta = { ui: { visibility: ["model"] } };

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

/**
 * The document's own policy, under whatever the host applies: images from
 * `data:` only, no network, no frames, no forms. Inline script and style are
 * the only code; nothing is loaded.
 */
const DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const STYLE = `
:root {
  color-scheme: light dark;
  --gp-bg: var(--color-background-primary, #ffffff);
  --gp-surface: var(--color-background-secondary, #f4f4f1);
  --gp-text: var(--color-text-primary, #1b1b19);
  --gp-muted: var(--color-text-secondary, #595955);
  --gp-border: var(--color-border-primary, #d9d9d3);
  --gp-note-bg: #fff6e0;
  --gp-note-text: #6b4500;
  --gp-radius: var(--border-radius-lg, 12px);
  font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --gp-bg: var(--color-background-primary, #1f1f1d);
    --gp-surface: var(--color-background-secondary, #2a2a27);
    --gp-text: var(--color-text-primary, #f1f1ec);
    --gp-muted: var(--color-text-secondary, #b4b4ad);
    --gp-border: var(--color-border-primary, #3d3d39);
    --gp-note-bg: #3a2c0a;
    --gp-note-text: #f3d48b;
  }
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] {
  color-scheme: dark;
  --gp-bg: var(--color-background-primary, #1f1f1d);
  --gp-surface: var(--color-background-secondary, #2a2a27);
  --gp-text: var(--color-text-primary, #f1f1ec);
  --gp-muted: var(--color-text-secondary, #b4b4ad);
  --gp-border: var(--color-border-primary, #3d3d39);
  --gp-note-bg: #3a2c0a;
  --gp-note-text: #f3d48b;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { color: var(--gp-text); font-size: 14px; line-height: 1.45; }
main:empty { display: none; }
main { padding: 2px; }
.grid { display: grid; gap: 12px; align-items: start; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
.card { background: var(--gp-bg); border: 1px solid var(--gp-border); border-radius: var(--gp-radius); overflow: hidden;
  display: flex; flex-direction: column; min-width: 0; }
.quote { flex-direction: row; flex-wrap: wrap; }
.photo { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; background: var(--gp-surface); }
.quote .photo { width: 160px; flex: 0 0 160px; aspect-ratio: 1 / 1; align-self: flex-start; }
@media (max-width: 420px) { .quote .photo { width: 100%; flex-basis: 100%; aspect-ratio: 4 / 3; } }
.body { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1 1 220px; }
h2 { font-size: 15px; line-height: 1.3; margin: 0; overflow-wrap: anywhere; }
h3 { font-size: 12px; margin: 8px 0 2px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--gp-muted); }
p { margin: 0; overflow-wrap: anywhere; }
.muted { color: var(--gp-muted); }
.small { font-size: 12px; }
.tag { align-self: flex-start; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--gp-border); color: var(--gp-muted); }
.price { font-weight: 600; }
.desc { color: var(--gp-muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
ul, ol { margin: 0; padding: 0; list-style: none; }
.options li { padding: 6px 0; border-top: 1px solid var(--gp-border); }
.options li:first-child { border-top: 0; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.address p { overflow-wrap: anywhere; }
.note { background: var(--gp-note-bg); color: var(--gp-note-text); border-radius: 8px; padding: 6px 10px; font-size: 12px; }
.more { margin-top: 12px; }
.more li { padding: 4px 0; border-top: 1px solid var(--gp-border); }
.fine { margin-top: 10px; font-size: 12px; color: var(--gp-muted); }
`;

/*
 * The in-frame client, written against the MCP Apps protocol directly (no
 * SDK bundle, so nothing is loaded): `ui/initialize`, then
 * `ui/notifications/initialized`; draw on `ui/notifications/tool-result`;
 * follow `ui/notifications/host-context-changed`; answer `ping` and
 * `ui/resource-teardown`; report `ui/notifications/size-changed`. Messages are
 * accepted only from the parent frame. It sends nothing else: no tool call,
 * no link, no message, no model-context update.
 */
const SCRIPT = `
(function () {
  "use strict";
  var APP_VERSION = __APP_VERSION__;
  var PROTOCOL_VERSION = __PROTOCOL_VERSION__;
  var IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  var BASE64 = /^[A-Za-z0-9+\\/]+={0,2}$/;
  var root = document.getElementById("root");
  var parent = window.parent;
  var initId = 1;
  var lastSize = "";

  function send(message) {
    if (!parent || parent === window) return;
    message.jsonrpc = "2.0";
    parent.postMessage(message, "*");
  }
  function reply(id, result) { send({ id: id, result: result }); }

  function text(value) { return typeof value === "string" && value.length > 0 ? value : null; }
  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
  function amount(value, asset) {
    return text(value) ? value + " " + (text(asset) || "USDC") : null;
  }
  function photo(result, index, alt) {
    if (typeof index !== "number" || !result || !Array.isArray(result.content)) return null;
    var block = result.content[index];
    if (!block || block.type !== "image" || typeof block.data !== "string" ||
        IMAGE_TYPES.indexOf(block.mimeType) < 0 || !BASE64.test(block.data)) return null;
    var img = document.createElement("img");
    img.className = "photo";
    img.alt = alt ? "Product photo: " + alt : "Product photo";
    img.src = "data:" + block.mimeType + ";base64," + block.data;
    return img;
  }
  function fine(message) { return el("p", "fine", message); }

  function discoverCard(card, result) {
    var products = Array.isArray(card.products) ? card.products : [];
    var section = el("section");
    section.setAttribute("aria-label", "Physical products");
    var grid = el("div", "grid");
    products.forEach(function (product) {
      if (!product || !text(product.title)) return;
      var article = el("article", "card");
      var image = photo(result, product.imageContentIndex, product.title);
      if (image) article.appendChild(image);
      var body = el("div", "body");
      body.appendChild(el("span", "tag", "Physical product · quote needed"));
      body.appendChild(el("h2", null, product.title));
      if (text(product.shopName)) body.appendChild(el("p", "muted small", "Sold by " + product.shopName));
      if (text(product.description)) body.appendChild(el("p", "desc small", product.description));
      var listed = amount(product.listedPriceUsdc, product.asset);
      if (listed) body.appendChild(el("p", "price", "Listed at " + listed));
      body.appendChild(el("p", "muted small", product.notPayable
        ? "Not available with this agent wallet: it settles in " + (text(product.asset) || "another asset") + "."
        : "Not the total: shipping, tax and stock depend on the delivery address."));
      article.appendChild(body);
      grid.appendChild(article);
    });
    section.appendChild(grid);
    var more = Array.isArray(card.more) ? card.more : [];
    if (more.length > 0) {
      var wrap = el("div", "more");
      wrap.appendChild(el("h3", null, "More physical products"));
      var list = el("ul");
      more.forEach(function (product) {
        if (!product || !text(product.title)) return;
        var item = el("li");
        item.appendChild(el("span", null, product.title));
        var detail = [text(product.shopName), amount(product.listedPriceUsdc, product.asset),
          product.notPayable ? "not available with this agent wallet" : null].filter(Boolean).join(" · ");
        if (detail) item.appendChild(el("span", "muted small", " — " + detail));
        list.appendChild(item);
      });
      wrap.appendChild(list);
      var extra = typeof card.moreCount === "number" ? card.moreCount - more.length : 0;
      if (extra > 0) wrap.appendChild(el("p", "muted small", "and " + extra + " more in the answer"));
      section.appendChild(wrap);
    }
    section.appendChild(fine("Display only: nothing here orders or pays. Ask in the chat for a quote; " +
      "you confirm the delivery address and the exact total there before anything is bought."));
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
    var image = photo(result, card.imageContentIndex, card.title);
    if (image) article.appendChild(image);
    var body = el("div", "body");
    body.appendChild(el("span", "tag", "Quote · nothing ordered yet"));
    body.appendChild(el("h2", null, text(card.title) || "Physical product"));
    var meta = ["Quantity " + (typeof card.quantity === "number" ? card.quantity : "?")];
    if (text(card.shopName)) meta.push("sold by " + card.shopName);
    body.appendChild(el("p", "muted small", meta.join(" · ")));

    var options = Array.isArray(card.options) ? card.options : [];
    body.appendChild(el("h3", null, options.length === 1 ? "Shipping option" : "Shipping options"));
    var list = el("ol", "options");
    options.forEach(function (option) {
      if (!option) return;
      var item = el("li");
      var row = el("div", "row");
      row.appendChild(el("span", null, text(option.label) || "Shipping"));
      row.appendChild(el("span", "price", "Total " + (amount(option.totalUsdc) || "?")));
      item.appendChild(row);
      item.appendChild(el("p", "muted small", (amount(option.subtotalUsdc) || "?") + " + shipping " +
        (amount(option.shippingUsdc) || "?") + " + tax " + (amount(option.taxUsdc) || "?")));
      list.appendChild(item);
    });
    body.appendChild(list);

    var ship = card.shipTo || {};
    body.appendChild(el("h3", null, "Ships to"));
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

  function render(result) {
    var card = result && result.structuredContent && result.structuredContent.productCard;
    root.replaceChildren();
    if (!result || result.isError || !card || card.version !== 1) { reportSize(); return; }
    if (card.kind === "discover") root.appendChild(discoverCard(card, result));
    else if (card.kind === "quote") root.appendChild(quoteCard(card, result));
    reportSize();
  }

  function applyContext(context) {
    if (!context || typeof context !== "object") return;
    if (context.theme === "light" || context.theme === "dark") {
      document.documentElement.setAttribute("data-theme", context.theme);
    }
    var variables = context.styles && context.styles.variables;
    if (variables && typeof variables === "object") {
      Object.keys(variables).forEach(function (name) {
        var value = variables[name];
        if (/^--[A-Za-z0-9-]{1,64}$/.test(name) && typeof value === "string" && value.length <= 256) {
          document.documentElement.style.setProperty(name, value);
        }
      });
    }
  }

  function reportSize() {
    var height = Math.ceil(root.childNodes.length === 0 ? 0 : document.body.getBoundingClientRect().height);
    var width = Math.ceil(window.innerWidth || 0);
    var size = width + "x" + height;
    if (size === lastSize) return;
    lastSize = size;
    send({ method: "ui/notifications/size-changed", params: { width: width, height: height } });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var message = event.data;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    if (message.method === undefined) {
      if (message.id === initId) {
        initId = null;
        if (message.result) {
          applyContext(message.result.hostContext);
          send({ method: "ui/notifications/initialized" });
        }
      }
      return;
    }
    switch (message.method) {
      case "ui/notifications/tool-result": render(message.params); break;
      case "ui/notifications/host-context-changed": applyContext(message.params); break;
      case "ui/resource-teardown": reply(message.id, {}); break;
      case "ping": reply(message.id, {}); break;
      default:
        if (message.id !== undefined && message.id !== null) {
          send({ id: message.id, error: { code: -32601, message: "Method not found" } });
        }
    }
  });

  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);
  send({ id: initId, method: "ui/initialize", params: {
    protocolVersion: PROTOCOL_VERSION,
    appInfo: { name: "genesispay-product-card", version: APP_VERSION },
    appCapabilities: { availableDisplayModes: ["inline"] }
  } });
})();
`;

/** The card document. No seller or user data is ever templated into it. */
export function productCardHtml(appVersion: string): string {
  const script = SCRIPT
    .replace("__APP_VERSION__", JSON.stringify(appVersion))
    .replace("__PROTOCOL_VERSION__", JSON.stringify(MCP_APPS_PROTOCOL_VERSION));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>GenesisPay product card</title>
<style>${STYLE}</style>
</head>
<body>
<main id="root" aria-live="polite"></main>
<script>${script}</script>
</body>
</html>
`;
}
