import { describe, expect, it, vi } from "vitest";

import { GenesisPay } from "./client.js";
import { GenesisPayConfigError } from "./errors.js";

const TEST_KEY = `gp_sk_test_${"a".repeat(32)}`;

const document = {
  id: "document-internal",
  publicId: "doc_1",
  kind: "enhanced_receipt",
  invoiceNumber: null,
  asset: "USDC",
  chainId: 84532,
  subtotalMinor: "2500000",
  discountMinor: "0",
  taxMinor: "0",
  totalMinor: "2500000",
  txHash: "0xabc",
  confirmedAt: "2026-08-24T10:00:00.000Z",
  issuedAt: "2026-08-24T10:00:01.000Z",
  retainUntil: "2033-08-24T10:00:01.000Z",
  recipientEmail: "buyer@example.com",
  snapshot: {
    version: 1,
    seller: {
      userId: "seller-internal",
      legalName: "Genesis Seller GmbH",
      email: "seller@example.com",
      addressLine1: "Hauptstrasse 1",
      addressLine2: null,
      city: "Vienna",
      postalCode: "1010",
      countryCode: "AT",
      taxId: "ATU12345678",
    },
    buyer: {
      legalName: "Ada Lovelace",
      companyName: null,
      addressLine1: "1 Analytical Way",
      addressLine2: null,
      city: "London",
      region: null,
      postalCode: "WC2N",
      countryCode: "GB",
      taxId: null,
      email: "buyer@example.com",
    },
    lineItem: { description: "Market data report" },
    invoice: { prefix: "INV", pricesIncludeTax: true },
    tax: {
      source: null,
      status: "receipt_required",
      reason: "seller_or_invoice_configuration_incomplete",
      taxRateBps: null,
      zeroTaxNote: null,
      rounding: null,
      settingsUpdatedAt: null,
    },
  },
};

function clientFor(fetchFn: ReturnType<typeof vi.fn>) {
  return new GenesisPay({
    apiKey: TEST_KEY,
    baseUrl: "http://localhost:3000",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
}

describe("checkoutDocuments", () => {
  it("retains v2 reviewed tax declarations and exact micro-amount line totals", async () => {
    const taxConfig = { version: 1, treatment: "taxable", rateBps: 10000, note: null };
    const taxRegistration = { status: "registered", registrations: [{ type: "vat", countryCode: "AT", value: "ATU12345678" }] };
    const line = { description: "Tiny item", quantity: 1, unitAmountMinor: "1", subtotalMinor: "0", discountMinor: "0", taxMinor: "1", totalMinor: "1", taxConfig };
    const v2 = { ...document, kind: "invoice", invoiceNumber: "INV-000001", totalMinor: "1",
      snapshot: { ...document.snapshot, version: 2, lines: [line],
        seller: { ...document.snapshot.seller, profileVersion: 2, taxRegistration },
        tax: { ...document.snapshot.tax, source: "seller_configured", status: "calculated", itemConfig: taxConfig } } };
    const client = clientFor(vi.fn(async () => Response.json({ document: v2 })));
    const parsed = await client.checkoutDocuments.get("doc_1");
    expect(parsed.snapshot.lines).toEqual([line]);
    expect(parsed.snapshot.tax.itemConfig).toEqual(taxConfig);
    expect(parsed.snapshot.seller.taxRegistration).toEqual(taxRegistration);
    expect(parsed.snapshot.seller.profileVersion).toBe(2);
  });
  it("lists immutable hosted checkout documents with exact minor-unit strings", async () => {
    const fetchFn = vi.fn(async () => Response.json({ documents: [document] }));
    const client = clientFor(fetchFn);

    const documents = await client.checkoutDocuments.list();

    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "http://localhost:3000/api/v1/checkout-documents",
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      publicId: "doc_1",
      kind: "enhanced_receipt",
      totalMinor: "2500000",
      invoiceNumber: null,
      snapshot: { invoice: { prefix: "INV", pricesIncludeTax: true } },
    });
  });

  it("treats a malformed response as a configuration error", async () => {
    const client = clientFor(vi.fn(async () => Response.json({ ok: true })));

    await expect(client.checkoutDocuments.list()).rejects.toBeInstanceOf(
      GenesisPayConfigError,
    );
  });

  it("retrieves one immutable document by public id", async () => {
    const fetchFn = vi.fn(async () => Response.json({ document }));
    const client = clientFor(fetchFn);

    await expect(client.checkoutDocuments.get("doc_1")).resolves.toMatchObject({
      publicId: "doc_1",
      totalMinor: "2500000",
    });
    const [url] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/checkout-documents/doc_1");
  });
});
