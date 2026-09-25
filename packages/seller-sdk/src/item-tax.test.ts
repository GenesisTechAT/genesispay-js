import { describe, expect, it, vi } from "vitest";
import { GenesisPay } from "./client.js";
import { parseItemTax, type ItemTax } from "./item-tax.js";

const tax: ItemTax = { version: 1, treatment: "taxable", rateBps: 725, note: null };
describe("item tax public contract", () => {
  it("leaves old data unconfigured and rejects malformed or automatic treatment claims", () => {
    expect(parseItemTax(undefined)).toBeNull();
    for (const input of [{ ...tax, treatment: "reverse_charge" }, { ...tax, rateBps: 0 }, { ...tax, rateBps: 7.25 }, { ...tax, treatment: "exempt", rateBps: 0 }]) expect(() => parseItemTax(input)).toThrow();
  });
  it("sends explicit product tax, publishes CAS updates and exposes returned configuration", async () => {
    const fetchFn = vi.fn(async () => Response.json({ product: { publicId: "prod_1", taxConfig: tax } }));
    const client = new GenesisPay({ apiKey: `gp_sk_test_${"a".repeat(32)}`, baseUrl: "http://localhost:3000", fetchFn });
    expect((await client.products.create({ name: "Item", price: "12", taxConfig: tax })).taxConfig).toEqual(tax);
    await client.products.update("prod_1", { taxConfig: tax, expectedTaxConfig: null });
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(calls[0][1].body as string).taxConfig).toEqual(tax);
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ taxConfig: tax, expectedTaxConfig: null });
  });
  it("supports standalone-link tax creation and compare-and-swap publication", async () => {
    const fetchFn = vi.fn(async () => Response.json({
      link: { publicId: "inv_1", payUrl: "https://example.test/pay/inv_1", taxConfig: tax },
      apiVersion: "2026-08-26", requestId: "req_item_tax",
    }, { headers: { "GENESISPAY-Version": "2026-08-26", "GENESISPAY-Request-Id": "req_item_tax" } }));
    const client = new GenesisPay({ apiKey: `gp_sk_test_${"a".repeat(32)}`, baseUrl: "http://localhost:3000", fetchFn });
    expect((await client.checkout.create({ title: "Item", amount: "12", taxConfig: tax }, { idempotencyKey: "item-tax-create" })).taxConfig).toEqual(tax);
    await client.checkout.updateTax("inv_1", { taxConfig: tax, expectedTaxConfig: null });
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls[1][0]).toContain("/api/v1/links/inv_1");
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ taxConfig: tax, expectedTaxConfig: null });
  });
});
