// @vitest-environment jsdom
/**
 * The card document itself, run in a real DOM: the MCP Apps handshake, what
 * it draws from a tool result, and that seller text stays text. The card runs
 * in an iframe whose parent plays the host.
 */
import { afterEach, describe, expect, it } from "vitest";

import { MCP_APPS_PROTOCOL_VERSION, productCardHtml } from "./product-card.js";

type Message = { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown>;
  result?: unknown; error?: unknown };

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";

const frames: HTMLIFrameElement[] = [];

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

/** Mounts the card; returns what it sent to its parent and a way to talk to it. */
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
  doc.write(productCardHtml("1.6.0"));
  doc.close();
  await settle();

  /** A message from the host: jsdom's postMessage sets no source, so the event is built here. */
  const fromHost = async (message: Message, source: Window = view.parent) => {
    view.dispatchEvent(new view.MessageEvent("message", { data: message, source }));
    await settle();
  };
  const initialize = async () => {
    const request = sent.find((message) => message.method === "ui/initialize");
    await fromHost({ jsonrpc: "2.0", id: request?.id, result: {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION, hostInfo: { name: "test-host", version: "1" }, hostCapabilities: {},
      hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "rgb(1, 2, 3)" } } },
    } });
  };
  const toolResult = (params: Record<string, unknown>) =>
    fromHost({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params });
  const shown = () => doc.getElementById("root")?.textContent ?? "";
  return { sent, view, doc, shown, fromHost, initialize, toolResult, detach: () => window.removeEventListener("message", listener) };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

const quoteCard = {
  version: 1, kind: "quote", productId: "prod_0kQkjzgoRSCRm3f3", quantity: 2, title: "Chewingum", shopName: "My Agent Bought It",
  shipTo: { name: "Maria Muster", lines: ["Musterstraße 1"], postalCode: "1010", city: "Wien", state: null, country: "AT",
    emailMasked: "m…@example.com" },
  addressStatus: "new_requires_approval",
  options: [{ label: "Flat rate", subtotalUsdc: "0.02", shippingUsdc: "4.9", taxUsdc: "0", totalUsdc: "4.92" }],
  expiresAt: "2026-10-03T12:05:00.000Z", imageContentIndex: 2,
};

describe("the product card document (MCP Apps)", () => {
  it("opens with ui/initialize, then announces initialized only after the host answers", async () => {
    const card = await mountCard();
    const init = card.sent.find((message) => message.method === "ui/initialize");
    expect(init).toMatchObject({ jsonrpc: "2.0", params: { protocolVersion: "2026-01-26",
      appInfo: { name: "genesispay-product-card", version: "1.6.0" } } });
    expect(card.sent.some((message) => message.method === "ui/notifications/initialized")).toBe(false);
    await card.initialize();
    expect(card.sent.some((message) => message.method === "ui/notifications/initialized")).toBe(true);
    expect(card.doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(card.doc.documentElement.style.getPropertyValue("--color-text-primary")).toBe("rgb(1, 2, 3)");
    card.detach();
  });

  it("draws a quote from structuredContent with the server's exact strings and the picture by content index", async () => {
    const card = await mountCard();
    await card.initialize();
    await card.toolResult({
      content: [{ type: "text", text: "{}" }, { type: "text", text: "Product images follow" },
        { type: "image", mimeType: "image/png", data: PNG_BASE64 }],
      structuredContent: { productCard: quoteCard },
    });
    const text = card.shown();
    expect(text).toContain("Chewingum");
    expect(text).toContain("Total 4.92 USDC");
    expect(text).toContain("0.02 USDC + shipping 4.9 USDC + tax 0 USDC");
    expect(text).toContain("Maria Muster");
    expect(text).toContain("1010 Wien");
    expect(text).toMatch(/New address: the account owner approves the first order/);
    expect(text).toMatch(/nothing has been ordered or charged/);
    const images = card.doc.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toBe(`data:image/png;base64,${PNG_BASE64}`);
    // Display only: nothing to click, follow or submit.
    expect(card.doc.querySelectorAll("button, a, form, input, select, textarea, iframe")).toHaveLength(0);
    expect(card.sent.some((message) => message.method === "ui/notifications/size-changed")).toBe(true);
    // The card never asks the host to call a tool, open a link or send a message.
    expect(card.sent.every((message) => message.method === undefined || ["ui/initialize", "ui/notifications/initialized",
      "ui/notifications/size-changed"].includes(message.method))).toBe(true);
    card.detach();
  });

  it("renders seller text inert: markup in a title or label is shown as text, never parsed or run", async () => {
    const card = await mountCard();
    await card.initialize();
    const hostile = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><a href="https://evil.example">x</a>`;
    await card.toolResult({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { productCard: {
        version: 1, kind: "discover", moreCount: 1,
        products: [{ productId: "prod_a", title: hostile, description: hostile, shopName: hostile, listedPriceUsdc: "1",
          asset: "USDC", notPayable: false, imageContentIndex: null }],
        more: [{ productId: "prod_b", title: hostile, shopName: null, listedPriceUsdc: "2", asset: "USDC", notPayable: false },
          { productId: "prod_c", title: "Euro gum", shopName: null, listedPriceUsdc: "3", asset: "EURC", notPayable: true }],
      } },
    });
    expect(card.shown()).toContain(hostile);
    expect(card.shown()).toContain("Euro gum — 3 EURC · not available with this agent wallet");
    expect(card.doc.querySelectorAll("img, a, iframe")).toHaveLength(0);
    expect(card.doc.querySelectorAll("body script")).toHaveLength(1);
    expect((card.view as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    card.detach();
  });

  it("ignores a picture that is not a raster data block, and messages that do not come from the host", async () => {
    const card = await mountCard();
    await card.initialize();
    await card.toolResult({
      content: [{ type: "text", text: "{}" }, { type: "text", text: "x" },
        { type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" }],
      structuredContent: { productCard: quoteCard },
    });
    expect(card.doc.querySelectorAll("img")).toHaveLength(0);
    await card.toolResult({
      content: [{ type: "text", text: "{}" }, { type: "text", text: "x" },
        { type: "image", mimeType: "image/png", data: "\"><script>" }],
      structuredContent: { productCard: quoteCard },
    });
    expect(card.doc.querySelectorAll("img")).toHaveLength(0);

    // A frame other than the parent cannot make it draw anything.
    await card.toolResult({ content: [], isError: true });
    expect(card.doc.getElementById("root")?.childNodes).toHaveLength(0);
    await card.fromHost({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { content: [], structuredContent: { productCard: quoteCard } } }, card.view);
    expect(card.doc.getElementById("root")?.childNodes).toHaveLength(0);
    card.detach();
  });

  it("answers ping and teardown, and refuses unknown requests", async () => {
    const card = await mountCard();
    await card.initialize();
    await card.fromHost({ jsonrpc: "2.0", id: 7, method: "ping" });
    await card.fromHost({ jsonrpc: "2.0", id: 8, method: "ui/resource-teardown", params: {} });
    await card.fromHost({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "genesispay_pay" } });
    expect(card.sent.find((message) => message.id === 7)).toMatchObject({ result: {} });
    expect(card.sent.find((message) => message.id === 8)).toMatchObject({ result: {} });
    expect(card.sent.find((message) => message.id === 9)).toMatchObject({ error: { code: -32601 } });
    card.detach();
  });
});
