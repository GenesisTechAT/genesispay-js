// @vitest-environment jsdom
/**
 * The catalog card document (ADR-0113) in a real DOM: it draws pictures only
 * from the result's `_meta`, keeps a placeholder otherwise, refuses non-raster
 * data, and has nothing to click, follow or submit. The card runs in an
 * iframe whose parent plays the host.
 */
import { afterEach, describe, expect, it } from "vitest";

import { MCP_APPS_PROTOCOL_VERSION } from "./app-card-shell.js";
import { CATALOG_CARD_FOOTER, catalogCardHtml, catalogListingsCard } from "./catalog-card.js";
import type { CatalogListing } from "./catalog-types.js";

type Message = { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown>;
  result?: unknown; error?: unknown };

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";
const SVG_BASE64 = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>").toString("base64");
const META_KEY = "genesispay/productImages";

const frames: HTMLIFrameElement[] = [];

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function mountCard() {
  const sent: Message[] = [];
  const iframe = document.createElement("iframe");
  frames.push(iframe);
  document.body.appendChild(iframe);
  const view = iframe.contentWindow as Window & typeof globalThis;
  const listener = (event: MessageEvent) => { if (event.data && typeof event.data === "object") sent.push(event.data as Message); };
  window.addEventListener("message", listener);
  const doc = iframe.contentDocument as Document;
  doc.open();
  doc.write(catalogCardHtml("1.10.0"));
  doc.close();
  await settle();

  const fromHost = async (message: Message) => {
    view.dispatchEvent(new view.MessageEvent("message", { data: message, source: view.parent }));
    await settle();
  };
  const request = sent.find((message) => message.method === "ui/initialize");
  await fromHost({ jsonrpc: "2.0", id: request?.id, result: {
    protocolVersion: MCP_APPS_PROTOCOL_VERSION, hostInfo: { name: "test-host", version: "1" }, hostCapabilities: {},
  } });
  const toolResult = (params: Record<string, unknown>) =>
    fromHost({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params });
  return { sent, view, doc, fromHost, toolResult, detach: () => window.removeEventListener("message", listener) };
}

function listing(id: string, title: string, overrides: Partial<CatalogListing> = {}): CatalogListing {
  return {
    id, type: "product", title, description: "A thing.", price: { display: "12.00 USDC", listedOnly: true },
    category: null, shop: { id: "shop_abcdefgh123", name: "Roastery", pageUrl: "https://genesispay.test/explore/shops/r" },
    rating: null, imageUrl: null, pageUrl: `https://genesispay.test/explore/products/${id}`, buyPath: "merchant_store", ...overrides,
  };
}

const listings = [
  listing("ext_weather_api", "Weather API", { type: "service" }),
  listing("prod_a", "Coffee"),
  listing("prod_b", "Mug"),
  listing("prod_c", "Grinder"),
  listing("prod_d", "Filter"),
];

describe("the catalog card document (MCP Apps)", () => {
  it("introduces itself as the catalog card", async () => {
    const card = await mountCard();
    expect(card.sent.find((message) => message.method === "ui/initialize")).toMatchObject({ params: {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION, appInfo: { name: "genesispay-catalog-card", version: "1.10.0" } } });
    expect(card.sent.some((message) => message.method === "ui/notifications/initialized")).toBe(true);
    card.detach();
  });

  it("draws products with their picture from _meta, a placeholder without one, and no services", async () => {
    const card = await mountCard();
    await card.toolResult({
      content: [{ type: "text", text: "{}" }, { type: "image", mimeType: "image/png", data: PNG_BASE64 }],
      structuredContent: { catalogCard: catalogListingsCard(listings, new Set(["prod_a"])) },
      _meta: { [META_KEY]: { prod_a: { mimeType: "image/png", data: PNG_BASE64 } } },
    });
    const shown = card.doc.getElementById("root")?.textContent ?? "";
    expect(card.doc.querySelectorAll(".grid .card")).toHaveLength(3);
    expect(shown).toContain("Coffee");
    expect(shown).toContain("12.00 USDC");
    expect(shown).toContain("Listed price; shipping and tax are added by the shop.");
    expect(card.doc.querySelector(".more")?.textContent).toContain("Filter");
    expect(shown).not.toContain("Weather API");
    expect(shown).toContain(CATALOG_CARD_FOOTER);

    const images = card.doc.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(images[0].getAttribute("alt")).toBe("Product photo: Coffee");
    // Only _meta counts: the image block in content is not drawn for "Mug" or "Grinder".
    expect(card.doc.querySelectorAll(".well .placeholder")).toHaveLength(2);
    card.detach();
  });

  it("refuses _meta data that is not a raster image or does not match its declared type", async () => {
    const card = await mountCard();
    await card.toolResult({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { catalogCard: catalogListingsCard(listings, new Set(["prod_a", "prod_b", "prod_c"])) },
      _meta: { [META_KEY]: {
        prod_a: { mimeType: "image/svg+xml", data: SVG_BASE64 },
        prod_b: { mimeType: "image/png", data: SVG_BASE64 },
        prod_c: { mimeType: "image/png", data: "\"><script>window.__pwned=1</script>" },
      } },
    });
    expect(card.doc.querySelectorAll("img")).toHaveLength(0);
    expect(card.doc.querySelectorAll(".well .placeholder")).toHaveLength(3);
    expect((card.view as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    card.detach();
  });

  it("has nothing to click, follow or submit, and never asks the host to call a tool or open a link", async () => {
    const card = await mountCard();
    const hostile = `<a href="https://evil.example">x</a><button>buy</button>`;
    await card.toolResult({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { catalogCard: catalogListingsCard([listing("prod_a", hostile)], new Set()) },
    });
    expect(card.doc.getElementById("root")?.textContent).toContain(hostile);
    expect(card.doc.querySelectorAll("a, form, button, input, select, textarea, iframe")).toHaveLength(0);
    await card.fromHost({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "genesispay_catalog_search" } });
    expect(card.sent.find((message) => message.id === 9)).toMatchObject({ error: { code: -32601 } });
    expect(card.sent.every((message) => message.method === undefined || ["ui/initialize", "ui/notifications/initialized",
      "ui/notifications/size-changed"].includes(message.method))).toBe(true);
    card.detach();
  });

  it("draws nothing for an error, another card's data or no card", async () => {
    const card = await mountCard();
    await card.toolResult({ content: [], isError: true, structuredContent: { catalogCard: catalogListingsCard(listings, new Set()) } });
    expect(card.doc.getElementById("root")?.childNodes).toHaveLength(0);
    await card.toolResult({ content: [], structuredContent: { productCard: { version: 1, kind: "discover", products: [] } } });
    expect(card.doc.getElementById("root")?.childNodes).toHaveLength(0);
    await card.toolResult({ content: [] });
    expect(card.doc.getElementById("root")?.childNodes).toHaveLength(0);
    card.detach();
  });
});
