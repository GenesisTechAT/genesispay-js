/**
 * The shared shell of GenesisPay's display-only MCP Apps cards (SEP-1865,
 * `io.modelcontextprotocol/ui`): the product card of the full server
 * (product-card.ts) and the catalog card of the catalog-only server
 * (catalog-card.ts, ADR-0113).
 *
 * It holds what every card needs and nothing about money: the resource type
 * and protocol version, the empty CSP, tool `_meta` shapes, the pictures'
 * `_meta` key, a raster sniff, the document CSP and base style, and the
 * in-frame protocol client. A card brings only its own renderer. The shell
 * imports nothing (an ESLint fence keeps it importable by the catalog server)
 * and names no money field, so sharing it cannot hand the catalog card any
 * money capability.
 *
 * The in-frame client speaks the MCP Apps protocol directly (no SDK bundle,
 * so nothing is loaded): `ui/initialize`, then `ui/notifications/initialized`;
 * draw on `ui/notifications/tool-result`; follow
 * `ui/notifications/host-context-changed`; answer `ping` and
 * `ui/resource-teardown`; report `ui/notifications/size-changed`. Messages are
 * accepted only from the parent frame. It sends nothing else: no tool call, no
 * link, no message, no model-context update.
 */

/** The MCP Apps resource type (SEP-1865 `RESOURCE_MIME_TYPE`). */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The latest MCP Apps protocol version a card speaks in `ui/initialize`. */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

/**
 * The tool result `_meta` key that carries a card's pictures:
 * `{ [id]: { mimeType, data } }` (base64). MCP Apps hosts pass a result's
 * `_meta` to the card and keep it out of the model's context; claude.ai does
 * not pass a card the result's image blocks.
 */
export const APP_CARD_IMAGES_META_KEY = "genesispay/productImages";

/**
 * No origin at all: a card fetches nothing, loads nothing and embeds nothing.
 * With every list empty the host's sandbox is its restrictive default
 * (`connect-src 'none'`, `img-src 'self' data:`), and the document's own CSP
 * narrows images to `data:` only.
 */
export const APP_CARD_CSP = {
  connectDomains: [] as string[],
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
  baseUriDomains: [] as string[],
};

/** The `_meta` of a card resource (and of its `resources/read` contents). */
export const APP_CARD_RESOURCE_META = {
  ui: { csp: APP_CARD_CSP, prefersBorder: false },
};

/**
 * `_meta` for a tool a card renders. `ui.resourceUri` is the standard key;
 * `ui/resourceUri` (the deprecated flat key the official helper still writes)
 * and `openai/outputTemplate` (ChatGPT's alias) point at the same resource for
 * hosts that read only those. Model visibility only.
 */
export function appCardToolMeta(resourceUri: string) {
  return {
    ui: { resourceUri, visibility: ["model"] },
    "ui/resourceUri": resourceUri,
    "openai/outputTemplate": resourceUri,
  };
}

/**
 * `_meta` for every other tool: callable by the model, never by an app. A
 * host MUST reject an app's `tools/call` for a tool without "app" visibility
 * (SEP-1865), so no card, ours or injected, can call a tool.
 */
export const modelOnlyToolMeta = { ui: { visibility: ["model"] } };

export type RasterImageMimeType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/**
 * The raster type of `bytes` by magic number; null for anything else (SVG
 * included). A deliberate copy of the agent SDK's `sniffProductImageType`:
 * the catalog server may not import the SDK (ADR-0113 fence).
 */
export function sniffRasterImageType(bytes: Uint8Array): RasterImageMimeType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
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

/** Theme, the grid of cards, the picture well, the compact list and the footer. */
const STYLE = `
:root {
  color-scheme: light dark;
  --gp-bg: var(--color-background-primary, #ffffff);
  --gp-surface: var(--color-background-secondary, #f5f5f2);
  --gp-text: var(--color-text-primary, #1b1b19);
  --gp-muted: var(--color-text-secondary, #6b6b66);
  --gp-border: var(--color-border-primary, #e4e4de);
  --gp-photo-bg: #ffffff;
  --gp-placeholder: #c9c9c2;
  --gp-note-bg: #fff6e0;
  --gp-note-text: #6b4500;
  --gp-warn: #a33a1b;
  --gp-radius: var(--border-radius-lg, 14px);
  font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --gp-bg: var(--color-background-primary, #262624);
    --gp-surface: var(--color-background-secondary, #1f1f1d);
    --gp-text: var(--color-text-primary, #f1f1ec);
    --gp-muted: var(--color-text-secondary, #a8a8a1);
    --gp-border: var(--color-border-primary, #3d3d39);
    --gp-note-bg: #3a2c0a;
    --gp-note-text: #f3d48b;
    --gp-warn: #f0a58c;
  }
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] {
  color-scheme: dark;
  --gp-bg: var(--color-background-primary, #262624);
  --gp-surface: var(--color-background-secondary, #1f1f1d);
  --gp-text: var(--color-text-primary, #f1f1ec);
  --gp-muted: var(--color-text-secondary, #a8a8a1);
  --gp-border: var(--color-border-primary, #3d3d39);
  --gp-note-bg: #3a2c0a;
  --gp-note-text: #f3d48b;
  --gp-warn: #f0a58c;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { color: var(--gp-text); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
main:empty { display: none; }
main { padding: 2px; }
h2, h3, p { margin: 0; overflow-wrap: anywhere; }
ul, ol { margin: 0; padding: 0; list-style: none; }
.muted { color: var(--gp-muted); }
.small { font-size: 12px; }
.clamp { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }

/* At most three columns, none narrower than 200px. */
.grid { display: grid; gap: 12px; align-items: stretch;
  grid-template-columns: repeat(auto-fill, minmax(max(200px, calc((100% - 24px) / 3)), 1fr)); }
.card { background: var(--gp-bg); border: 1px solid var(--gp-border); border-radius: var(--gp-radius); overflow: hidden;
  display: flex; flex-direction: column; min-width: 0; }
.well { position: relative; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; background: var(--gp-photo-bg);
  display: flex; align-items: center; justify-content: center; border-bottom: 1px solid var(--gp-border); }
.photo { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: contain; padding: 10px; }
.placeholder { position: relative; width: 56px; height: 44px; border: 2px solid var(--gp-placeholder); border-radius: 8px;
  overflow: hidden; }
.placeholder::after { content: ""; position: absolute; left: 6px; right: -10px; bottom: -14px; height: 28px;
  background: var(--gp-placeholder); transform: rotate(-24deg); transform-origin: left bottom; }
.placeholder .sun { position: absolute; top: 7px; right: 9px; width: 9px; height: 9px; border-radius: 50%;
  background: var(--gp-placeholder); }
.body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; }
.shop { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--gp-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title { font-size: 14px; font-weight: 600; line-height: 1.3; -webkit-line-clamp: 2; }
.desc { font-size: 12px; color: var(--gp-muted); -webkit-line-clamp: 2; }
.price { margin-top: auto; padding-top: 8px; display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 6px; }
.amount { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.unit { font-size: 12px; font-weight: 600; color: var(--gp-muted); }
.plus { font-size: 12px; color: var(--gp-muted); }
.warn { font-size: 12px; color: var(--gp-warn); }
@media (max-width: 460px) {
  .grid .card { flex-direction: row; }
  .grid .well { width: 112px; flex: 0 0 112px; aspect-ratio: 1 / 1; align-self: stretch; border-bottom: 0;
    border-right: 1px solid var(--gp-border); }
  .grid .photo { padding: 6px; }
  .grid .body { padding: 10px 12px; }
  .grid .desc { display: none; }
}

.more { margin-top: 14px; border: 1px solid var(--gp-border); border-radius: var(--gp-radius); background: var(--gp-bg);
  overflow: hidden; }
.more h3 { padding: 10px 14px; font-size: 12px; font-weight: 600; color: var(--gp-muted); text-transform: uppercase;
  letter-spacing: 0.04em; border-bottom: 1px solid var(--gp-border); }
.more li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; padding: 8px 14px;
  border-top: 1px solid var(--gp-border); }
.more li:first-child { border-top: 0; }
.more .name { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.more .shopname { flex: 0 1 auto; min-width: 0; max-width: 35%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-size: 12px; color: var(--gp-muted); }
.more .listed { flex: 0 0 auto; font-weight: 600; font-variant-numeric: tabular-nums; }
.more .warn { flex: 1 1 100%; }
.more .rest { padding: 8px 14px; border-top: 1px solid var(--gp-border); font-size: 12px; color: var(--gp-muted); }
@media (max-width: 420px) { .more .shopname { display: none; } }

.fine { margin-top: 10px; font-size: 12px; color: var(--gp-muted); }
`;

/*
 * The client and the helpers every renderer may use: text, el, own, picture,
 * placeholder, well, fine. A renderer is the source of one function,
 * `renderCard(result)`, that returns a node to show or null for nothing.
 * Pictures are drawn only when the `_meta` (or, for the product card, the
 * content block at a given index) is a base64 raster whose bytes match its
 * declared type.
 */
const CLIENT = `
(function () {
  "use strict";
  var APP_NAME = __APP_NAME__;
  var APP_VERSION = __APP_VERSION__;
  var PROTOCOL_VERSION = __PROTOCOL_VERSION__;
  var IMAGES_META_KEY = __IMAGES_META_KEY__;
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
  function own(object, key) {
    return object && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : null;
  }
  function bytesStartWith(head, signature, offset) {
    if (head.length < offset + signature.length) return false;
    for (var i = 0; i < signature.length; i++) {
      var expected = typeof signature === "string" ? signature.charCodeAt(i) : signature[i];
      if (head.charCodeAt(offset + i) !== expected) return false;
    }
    return true;
  }
  /** The raster type of base64 data by its first bytes; null for anything else (SVG included). */
  function rasterType(data) {
    if (typeof data !== "string" || !BASE64.test(data)) return null;
    var head;
    try { head = atob(data.length > 16 ? data.slice(0, 16) : data); } catch (e) { return null; }
    if (bytesStartWith(head, [0xff, 0xd8, 0xff], 0)) return "image/jpeg";
    if (bytesStartWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)) return "image/png";
    if (bytesStartWith(head, "GIF87a", 0) || bytesStartWith(head, "GIF89a", 0)) return "image/gif";
    if (bytesStartWith(head, "RIFF", 0) && bytesStartWith(head, "WEBP", 8)) return "image/webp";
    return null;
  }
  function picture(result, id, index) {
    var block = typeof id === "string" ? own(own(result && result._meta, IMAGES_META_KEY), id) : null;
    if (block) return block;
    if (typeof index !== "number" || !result || !Array.isArray(result.content)) return null;
    block = result.content[index];
    return block && block.type === "image" ? block : null;
  }
  function placeholder() {
    var box = el("div", "placeholder");
    box.setAttribute("aria-hidden", "true");
    box.appendChild(el("span", "sun"));
    return box;
  }
  /** The picture well: the photo when the result carries a valid raster one, else a quiet placeholder. */
  function well(result, id, index, alt) {
    var box = el("div", "well");
    var block = picture(result, id, index);
    if (block && typeof block.mimeType === "string" && rasterType(block.data) === block.mimeType) {
      var img = document.createElement("img");
      img.className = "photo";
      img.alt = alt ? "Product photo: " + alt : "Product photo";
      img.src = "data:" + block.mimeType + ";base64," + block.data;
      box.appendChild(img);
    } else {
      box.appendChild(placeholder());
    }
    return box;
  }
  function fine(message) { return el("p", "fine", message); }

__RENDERER__

  function render(result) {
    root.replaceChildren();
    if (result && !result.isError) {
      var node = renderCard(result);
      if (node) root.appendChild(node);
    }
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
    appInfo: { name: APP_NAME, version: APP_VERSION },
    appCapabilities: { availableDisplayModes: ["inline"] }
  } });
})();
`;

export type CardDocumentOptions = {
  /** The document `<title>`. */
  title: string;
  /** `appInfo.name` in `ui/initialize`. */
  appName: string;
  /** `appInfo.version` in `ui/initialize`. */
  appVersion: string;
  /** The renderer's source: defines `function renderCard(result)` returning a node or null. */
  render: string;
  /** CSS added after the shared style. */
  style?: string;
};

/**
 * One self-contained card document: inline CSS and script, no fonts, scripts
 * or network. Only the caller's constants are templated in; seller or user
 * data reaches the card as tool-result data and is written with
 * `textContent`, never parsed as markup.
 */
export function cardDocument(options: CardDocumentOptions): string {
  const values: Record<string, string> = {
    __APP_NAME__: JSON.stringify(options.appName),
    __APP_VERSION__: JSON.stringify(options.appVersion),
    __PROTOCOL_VERSION__: JSON.stringify(MCP_APPS_PROTOCOL_VERSION),
    __IMAGES_META_KEY__: JSON.stringify(APP_CARD_IMAGES_META_KEY),
  };
  // Placeholders first, renderer last, each by a replacer function: no `$`
  // pattern in the renderer is interpreted and none of its text is rewritten.
  const script = CLIENT
    .replace(/__[A-Z_]+__/g, (token) => values[token] ?? token)
    .replace("__RENDERER__", () => options.render);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>${options.title}</title>
<style>${STYLE}${options.style ?? ""}</style>
</head>
<body>
<main id="root" aria-live="polite"></main>
<script>${script}</script>
</body>
</html>
`;
}
