import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GenesisPayAgent, createPurchaseIntent, PURCHASE_INTENT_ERROR_CODES } from "@genesis-tech/genesispay-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenesisPayMcpServer } from "./server.js";
import { purchaseIntentToolSchema } from "./purchase-intent.js";

const approvalQuote = "Buy the report for at most 12.50 USDC.";
const intent = { maxTotal: "12.50", asset: "USDC" as const, approvalQuote,
  conversation: [{ role: "assistant" as const, content: "Private visible purchase detail" },
    { role: "user" as const, content: approvalQuote }] };
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function setup(mode?: "accept" | "omit", code = "purchase_intent_required") {
  const calls: { path: string; body: string }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(url), body: String(init?.body) });
    return Response.json({ error: "Refused", code }, { status: code === "purchase_evidence_unavailable" ? 503 : 422 });
  });
  const agent = new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesispay.example", fetchFn });
  const server = createGenesisPayMcpServer({ agent, purchaseIntent: mode });
  const client = new Client({ name: "intent-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return { client, calls };
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("MR-507 MCP capture boundary", () => {
  it.each(["accept", "omit"] as const)("%s registers the intended schema", async (mode) => {
    const { client, calls } = await setup(mode);
    const { tools } = await client.listTools();
    const pay = tools.find((tool) => tool.name === "genesispay_pay")!;
    expect(Object.hasOwn(pay.inputSchema.properties!, "purchaseIntent")).toBe(mode === "accept");
    expect(calls).toHaveLength(0);
    if (mode === "omit") {
      await client.callTool({ name: "genesispay_pay", arguments: { url: "https://example.com/report", idempotencyKey: "saved-key", purchaseIntent: intent } });
      // Even an unsolicited field cannot reach the SDK or payment API.
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0].body)).not.toHaveProperty("purchaseIntent");
      await client.callTool({ name: "genesispay_pay", arguments: { quoteToken: "gp_cq_abc", shippingOptionId: "flat_rate:1",
        idempotencyKey: "saved-key", purchaseIntent: intent, productId: "prod_12345678", quantity: 2 } });
      // The quote form ignores an unsolicited intent too.
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[1].body)).not.toHaveProperty("purchaseIntent");
      expect(calls[1].body).not.toContain(intent.approvalQuote);
    }
  });

  it.each(["url", "quote"] as const)("hashes locally and forwards digest only for %s purchases", async (form) => {
    const { client, calls } = await setup(); // Local stdio default: accept.
    const args = form === "url" ? { url: "https://example.com/report" }
      : { quoteToken: "gp_cq_abc", shippingOptionId: "flat_rate:1", productId: "prod_12345678", quantity: 2 };
    const result = await client.callTool({ name: "genesispay_pay", arguments: { ...args, idempotencyKey: "saved-key", purchaseIntent: intent } });
    expect(payload(result)).toMatchObject({ code: "purchase_intent_required", outcome: "not_charged" });
    expect(calls).toHaveLength(1);
    const item = form === "url" ? { url: "https://example.com/report" }
      : { productId: "prod_12345678", quantity: 2, shippingOptionId: "flat_rate:1" };
    expect(JSON.parse(calls[0].body).purchaseIntent).toEqual(createPurchaseIntent({ ...intent, item }));
    expect(calls[0].body).not.toContain('"conversation"');
    expect(calls[0].body).not.toContain("Private visible purchase detail");
  });

  it("refuses quote intent without product identity before any API call", async () => {
    const { client, calls } = await setup();
    const result = await client.callTool({ name: "genesispay_pay", arguments: {
      quoteToken: "gp_cq_abc", shippingOptionId: "flat_rate:1", idempotencyKey: "saved-key", purchaseIntent: intent,
    } });
    expect(payload(result)).toMatchObject({ code: "purchase_intent_invalid", outcome: "not_charged" });
    expect(calls).toHaveLength(0);
  });

  it.each(PURCHASE_INTENT_ERROR_CODES)("guides %s as not charged for URL and commerce", async (code) => {
    const { client } = await setup("accept", code);
    for (const args of [{ url: "https://example.com/report" }, { quoteToken: "gp_cq_abc", shippingOptionId: "flat_rate:1" }]) {
      const result = payload(await client.callTool({ name: "genesispay_pay", arguments: { ...args, idempotencyKey: "saved-key" } }));
      expect(result).toMatchObject({ code, outcome: "not_charged", idempotencyKey: "saved-key" });
      expect(result.instructions).toContain("Nothing was charged");
      if (code === "purchase_intent_required") expect(result.instructions).toContain("SAME idempotencyKey");
    }
  });

  it("caps messages, UTF-16 length and combined UTF-8 bytes without changing content", () => {
    const parse = (conversation: unknown) => purchaseIntentToolSchema.safeParse({ ...intent, conversation });
    expect(parse(Array.from({ length: 101 }, () => ({ role: "user", content: "x" }))).success).toBe(false);
    expect(parse([{ role: "user", content: "x".repeat(16_001) }]).success).toBe(false);
    expect(parse(Array.from({ length: 3 }, () => ({ role: "user", content: "界".repeat(16_000) }))).success).toBe(false);
    expect(parse(Array.from({ length: 8 }, () => ({ role: "user", content: "x".repeat(16_000) }))).success).toBe(true);
    expect(parse([{ role: "system", content: "x" }]).success).toBe(false);
    expect(parse([{ role: "user", content: " x  \n" }])).toMatchObject({ success: true, data: { conversation: [{ content: " x  \n" }] } });
  });
});
