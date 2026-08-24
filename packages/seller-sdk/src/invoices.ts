// `genesispay.invoices.*` — one-off invoice lifecycle over `/api/v1/invoices`.

import { GenesisPayConfigError } from "./errors.js";
import { toCustomer, type Customer } from "./customers.js";
import {
  asRecord,
  oneOf,
  optionalString,
  requiredString,
  toAmountString,
  toCount,
  type GenesisPayRequest,
} from "./resource.js";

export type InvoiceStatus =
  | "draft"
  | "open"
  | "past_due"
  | "paid"
  | "void"
  | "uncollectible";

export type InvoiceLineInput = {
  description: string;
  quantity: number;
  /** Decimal amount in the invoice asset, as a string with up to 6 decimals. */
  unitAmount: string;
};

export type InvoiceDraftInput = {
  customerId: string;
  asset?: "USDC" | "EURC";
  /** ISO-8601 timestamp with an offset. */
  dueAt: string;
  discountBps?: number;
  taxBps?: number;
  memo?: string;
  footer?: string;
  lineItems: InvoiceLineInput[];
};

export type Invoice = {
  id: string;
  publicId: string;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  asset: "USDC" | "EURC";
  chainId: number;
  customer: Customer;
  lineItems: Array<{
    id: string;
    position: number;
    description: string;
    quantity: number;
    unitAmountMinor: string;
    amountMinor: string;
  }>;
  subtotalMinor: string;
  discountBps: number;
  discountMinor: string;
  taxBps: number;
  taxMinor: string;
  totalMinor: string;
  memo: string | null;
  footer: string | null;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  uncollectibleAt: string | null;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  payment: {
    payUrl: string | null;
    txHash: string | null;
    payerWallet: string | null;
  };
};

export type InvoiceEmailDelivery = {
  id: string;
  status: "sent";
  providerMessageId: string | null;
  sentAt: string | null;
};

export interface InvoicesResource {
  create(input: InvoiceDraftInput): Promise<Invoice>;
  list(): Promise<Invoice[]>;
  retrieve(publicId: string): Promise<Invoice>;
  update(publicId: string, input: InvoiceDraftInput): Promise<Invoice>;
  finalize(publicId: string): Promise<Invoice>;
  send(publicId: string, options: { idempotencyKey: string }): Promise<InvoiceEmailDelivery>;
  void(publicId: string): Promise<Invoice>;
  markUncollectible(publicId: string): Promise<Invoice>;
}

export function createInvoicesResource(request: GenesisPayRequest): InvoicesResource {
  return {
    create: async (input) =>
      invoiceRequest(request, "POST", "/api/v1/invoices", input, "create an invoice"),
    list: async () => {
      const body = await request({
        path: "/api/v1/invoices",
        operation: "GET /api/v1/invoices",
        action: "list invoices",
      });
      const rows = asRecord(body)?.invoices;
      if (!Array.isArray(rows)) {
        throw new GenesisPayConfigError(
          `GenesisPay GET /api/v1/invoices returned no invoices array: ${JSON.stringify(body)}`,
        );
      }
      return rows
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => Boolean(row?.publicId))
        .map(toInvoice);
    },
    retrieve: async (publicId) => {
      const id = requirePublicId(publicId, "invoices.retrieve");
      return invoiceRequest(
        request,
        "GET",
        `/api/v1/invoices/${encodeURIComponent(id)}`,
        undefined,
        `retrieve invoice "${id}"`,
      );
    },
    update: async (publicId, input) => {
      const id = requirePublicId(publicId, "invoices.update");
      return invoiceRequest(
        request,
        "PATCH",
        `/api/v1/invoices/${encodeURIComponent(id)}`,
        input,
        `update invoice "${id}"`,
      );
    },
    finalize: async (publicId) =>
      transition(request, publicId, "finalize", "finalize an invoice"),
    void: async (publicId) =>
      transition(request, publicId, "void", "void an invoice"),
    markUncollectible: async (publicId) =>
      transition(
        request,
        publicId,
        "mark-uncollectible",
        "mark an invoice uncollectible",
      ),
    send: async (publicId, options) => {
      const id = requirePublicId(publicId, "invoices.send");
      const idempotencyKey = options?.idempotencyKey?.trim();
      if (!idempotencyKey) {
        throw new GenesisPayConfigError(
          "invoices.send requires a non-empty idempotencyKey.",
        );
      }
      const path = `/api/v1/invoices/${encodeURIComponent(id)}/send`;
      const response = await request({
        method: "POST",
        path,
        operation: `POST ${path}`,
        action: `send invoice "${id}"`,
        headers: { "idempotency-key": idempotencyKey },
      });
      const delivery = asRecord(asRecord(response)?.delivery);
      if (!delivery?.id) {
        throw new GenesisPayConfigError(
          `GenesisPay POST ${path} returned no delivery: ${JSON.stringify(response)}`,
        );
      }
      return {
        id: requiredString(delivery.id),
        status: "sent",
        providerMessageId: optionalString(delivery.providerMessageId),
        sentAt: optionalString(delivery.sentAt),
      };
    },
  };
}

async function transition(
  request: GenesisPayRequest,
  publicId: string,
  transitionName: "finalize" | "void" | "mark-uncollectible",
  action: string,
): Promise<Invoice> {
  const id = requirePublicId(publicId, `invoices.${transitionName}`);
  return invoiceRequest(
    request,
    "POST",
    `/api/v1/invoices/${encodeURIComponent(id)}/${transitionName}`,
    undefined,
    action,
  );
}

async function invoiceRequest(
  request: GenesisPayRequest,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: unknown,
  action: string,
): Promise<Invoice> {
  const response = await request({
    method,
    path,
    operation: `${method} ${path}`,
    action,
    ...(body === undefined ? {} : { body }),
  });
  const raw = asRecord(asRecord(response)?.invoice);
  if (!raw?.publicId) {
    throw new GenesisPayConfigError(
      `GenesisPay ${method} ${path} returned no invoice: ${JSON.stringify(response)}`,
    );
  }
  return toInvoice(raw);
}

function requirePublicId(publicId: string, method: string): string {
  const id = publicId?.trim();
  if (!id) {
    throw new GenesisPayConfigError(
      `${method}(publicId) requires the publicId returned by invoices.create().`,
    );
  }
  return id;
}

export function toInvoice(raw: Record<string, unknown>): Invoice {
  const customer = asRecord(raw.customer) ?? {};
  const payment = asRecord(raw.payment) ?? {};
  const lines = Array.isArray(raw.lineItems) ? raw.lineItems : [];

  return {
    id: requiredString(raw.id),
    publicId: requiredString(raw.publicId),
    invoiceNumber: optionalString(raw.invoiceNumber),
    status: oneOf(
      raw.status,
      ["draft", "open", "past_due", "paid", "void", "uncollectible"] as const,
      "draft",
    ),
    asset: oneOf(raw.asset, ["USDC", "EURC"] as const, "USDC"),
    chainId: toCount(raw.chainId),
    customer: toCustomer(customer),
    lineItems: lines
      .map(asRecord)
      .filter((line): line is Record<string, unknown> => Boolean(line?.id))
      .map((line) => ({
        id: requiredString(line.id),
        position: toCount(line.position),
        description: requiredString(line.description),
        quantity: toCount(line.quantity),
        unitAmountMinor: toAmountString(line.unitAmountMinor),
        amountMinor: toAmountString(line.amountMinor),
      })),
    subtotalMinor: toAmountString(raw.subtotalMinor),
    discountBps: toCount(raw.discountBps),
    discountMinor: toAmountString(raw.discountMinor),
    taxBps: toCount(raw.taxBps),
    taxMinor: toAmountString(raw.taxMinor),
    totalMinor: toAmountString(raw.totalMinor),
    memo: optionalString(raw.memo),
    footer: optionalString(raw.footer),
    dueAt: requiredString(raw.dueAt),
    createdAt: requiredString(raw.createdAt),
    updatedAt: requiredString(raw.updatedAt),
    finalizedAt: optionalString(raw.finalizedAt),
    paidAt: optionalString(raw.paidAt),
    voidedAt: optionalString(raw.voidedAt),
    uncollectibleAt: optionalString(raw.uncollectibleAt),
    hostedInvoiceUrl: optionalString(raw.hostedInvoiceUrl),
    pdfUrl: optionalString(raw.pdfUrl),
    payment: {
      payUrl: optionalString(payment.payUrl),
      txHash: optionalString(payment.txHash),
      payerWallet: optionalString(payment.payerWallet),
    },
  };
}
