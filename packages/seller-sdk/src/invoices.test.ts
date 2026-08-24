import { describe, expect, it, vi } from "vitest";

import { GenesisPay } from "./client.js";
import { GenesisPayConfigError } from "./errors.js";

const TEST_KEY = `gp_sk_test_${"a".repeat(32)}`;

const customer = {
  id: "customer-internal",
  publicId: "cus_1",
  name: "Ada",
  email: "ada@example.com",
  companyName: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  postalCode: null,
  countryCode: "GB",
  taxId: null,
  metadata: null,
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
  archivedAt: null,
};

const invoice = {
  id: "invoice-internal",
  publicId: "inv_1",
  invoiceNumber: "INV-000001",
  status: "open",
  asset: "EURC",
  chainId: 84532,
  customer,
  lineItems: [
    {
      id: "line_1",
      position: 0,
      description: "Consulting",
      quantity: 2,
      unitAmountMinor: "450000000",
      amountMinor: "900000000",
    },
  ],
  subtotalMinor: "900000000",
  discountBps: 0,
  discountMinor: "0",
  taxBps: 2300,
  taxMinor: "207000000",
  totalMinor: "1107000000",
  memo: null,
  footer: null,
  dueAt: "2026-08-31T23:59:59.999Z",
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
  finalizedAt: "2026-07-28T10:01:00.000Z",
  paidAt: null,
  voidedAt: null,
  uncollectibleAt: null,
  hostedInvoiceUrl: "https://pay.example/invoice/inv_1",
  pdfUrl: "https://pay.example/invoice/inv_1/pdf",
  payment: {
    payUrl: "https://pay.example/pay/link_1",
    txHash: null,
    payerWallet: null,
  },
};

function clientFor(fetchFn: ReturnType<typeof vi.fn>) {
  return new GenesisPay({
    apiKey: TEST_KEY,
    baseUrl: "http://localhost:3000",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
}

describe("invoices", () => {
  it("creates a draft with decimal string amounts", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ invoice }, { status: 201 }),
    );
    const client = clientFor(fetchFn);

    const created = await client.invoices.create({
      customerId: "cus_1",
      asset: "EURC",
      dueAt: "2026-08-31T23:59:59.999Z",
      taxBps: 2300,
      lineItems: [
        { description: "Consulting", quantity: 2, unitAmount: "450.00" },
      ],
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/invoices");
    expect(JSON.parse(init.body as string)).toMatchObject({
      customerId: "cus_1",
      lineItems: [{ unitAmount: "450.00" }],
    });
    expect(created.totalMinor).toBe("1107000000");
    expect(created.asset).toBe("EURC");
  });

  it("sends a caller idempotency key in the header", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        delivery: {
          id: "delivery_1",
          status: "sent",
          providerMessageId: "resend_1",
          sentAt: "2026-07-28T10:02:00.000Z",
        },
      }),
    );
    const client = clientFor(fetchFn);

    await client.invoices.send("inv_1", { idempotencyKey: "order-42-invoice" });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/invoices/inv_1/send");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "order-42-invoice",
    );
  });

  it("refuses a send without an idempotency key before making a request", async () => {
    const fetchFn = vi.fn();
    const client = clientFor(fetchFn);

    await expect(
      client.invoices.send("inv_1", { idempotencyKey: " " }),
    ).rejects.toBeInstanceOf(GenesisPayConfigError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("customers", () => {
  it("updates a reusable customer with PATCH", async () => {
    const fetchFn = vi.fn(async () => Response.json({ customer }));
    const client = clientFor(fetchFn);

    await client.customers.update("cus_1", { companyName: "Engines Ltd" });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/customers/cus_1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      companyName: "Engines Ltd",
    });
  });
});
