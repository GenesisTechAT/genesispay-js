// `genesispay.invoices.*` — one-off invoice lifecycle over `/api/v1/invoices`.

import { GenesisPayConfigError } from "./errors.js";
import { toCustomer, type Customer } from "./customers.js";
import { parseItemTax, type ItemTax } from "./item-tax.js";
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
  /** Required for new v2 invoices; absent only when editing a legacy v1 draft. */
  taxConfig?: ItemTax;
  description: string;
  quantity: number;
  /** Decimal amount in the invoice asset, as a string with up to 6 decimals. */
  unitAmount: string;
};

export type InvoiceDraftInput = {
  /** New invoices are v2 (inclusive per-line tax); v1 is retained drafts only. */
  calculationVersion?: 1 | 2;
  customerId: string;
  asset?: "USDC" | "EURC";
  /** ISO-8601 timestamp with an offset. */
  dueAt: string;
  discountBps?: number;
  /** Legacy v1 only. New invoices use lineItems[].taxConfig and taxBps=0. */
  taxBps?: number;
  memo?: string;
  footer?: string;
  lineItems: InvoiceLineInput[];
};

export type Invoice = {
  calculationVersion: 1 | 2;
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
    taxConfig: ItemTax | null;
    subtotalMinor: string | null;
    discountMinor: string | null;
    taxMinor: string | null;
    totalMinor: string | null;
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

/** Small list projection; retrieve the full invoice for line items and payment evidence. */
export type InvoiceSummary = Pick<Invoice, "id" | "publicId" | "invoiceNumber" | "status" | "asset" | "chainId" | "totalMinor" | "dueAt" | "createdAt" | "paidAt"> & {
  customer: { name: string; companyName: string | null };
};
export type InvoiceSummaryPage = { invoices: InvoiceSummary[]; limit: number; nextCursor: string | null };
export type InvoiceSummaryListOptions = { limit?: number; after?: string };

export interface InvoicesResource {
  create(input: InvoiceDraftInput): Promise<Invoice>;
  /** Legacy full resources: at most the newest 100 invoices. */
  list(): Promise<Invoice[]>;
  /** Bounded summaries, default 25/max 100; follow nextCursor for older invoices. */
  listSummaries(options?: InvoiceSummaryListOptions): Promise<InvoiceSummaryPage>;
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
      invoiceRequest(request, "POST", "/api/v1/invoices", validateInvoiceTax(input, true), "create an invoice"),
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
    listSummaries: async (options = {}) => {
      const limit = options.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new GenesisPayConfigError("invoices.listSummaries limit must be an integer from 1 to 100.");
      }
      if (options.after !== undefined && (typeof options.after !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(options.after))) {
        throw new GenesisPayConfigError("invoices.listSummaries after must be the opaque nextCursor from a previous page.");
      }
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.after) query.set("after", options.after);
      const body = asRecord(await request({ path: `/api/v1/invoices/summaries?${query}`, operation: "GET /api/v1/invoices/summaries", action: "list invoice summaries" }));
      if (!body || !Array.isArray(body.invoices) || body.invoices.length > limit || body.limit !== limit ||
        !(body.nextCursor === null || typeof body.nextCursor === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(body.nextCursor))) {
        throw new GenesisPayConfigError("GenesisPay returned an invalid invoice summary page.");
      }
      return { invoices: body.invoices.map(toInvoiceSummary), limit, nextCursor: body.nextCursor };
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
        validateInvoiceTax(input, false),
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
    calculationVersion: raw.calculationVersion === 2 ? 2 : 1,
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
        taxConfig: parseItemTax(line.taxConfig),
        subtotalMinor: optionalString(line.subtotalMinor),
        discountMinor: optionalString(line.discountMinor),
        taxMinor: optionalString(line.taxMinor),
        totalMinor: optionalString(line.totalMinor),
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

function validateInvoiceTax(input: InvoiceDraftInput, creating: boolean): InvoiceDraftInput {
  const version = input.calculationVersion ?? (creating ? 2 : undefined);
  if (creating && version !== 2) throw new GenesisPayConfigError("New invoices require calculationVersion 2 and per-line inclusive tax.");
  if (version === 2 && (input.taxBps ?? 0) !== 0) throw new GenesisPayConfigError("New invoices use line taxConfig, not invoice-wide taxBps.");
  const lineItems = input.lineItems.map((line) => {
    const taxConfig = parseItemTax(line.taxConfig);
    if (version === 2 && !taxConfig) throw new GenesisPayConfigError("Choose taxConfig for every invoice line.");
    return { ...line, ...(taxConfig ? { taxConfig } : {}) };
  });
  return { ...input, ...(version ? { calculationVersion: version } : {}), lineItems };
}

/** This new endpoint has no older partial shape: missing rows must never silently disappear. */
function toInvoiceSummary(value: unknown): InvoiceSummary {
  const raw = asRecord(value), customer = asRecord(raw?.customer);
  const statuses = ["draft", "open", "past_due", "paid", "void", "uncollectible"] as const;
  if (!raw || !customer || typeof raw.id !== "string" || !raw.id || typeof raw.publicId !== "string" || !raw.publicId ||
    !(raw.invoiceNumber === null || typeof raw.invoiceNumber === "string") ||
    typeof raw.status !== "string" || !(statuses as readonly string[]).includes(raw.status) ||
    !(raw.asset === "USDC" || raw.asset === "EURC") || typeof raw.chainId !== "number" || !Number.isInteger(raw.chainId) || raw.chainId <= 0 ||
    typeof raw.totalMinor !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw.totalMinor) ||
    typeof customer.name !== "string" || !(customer.companyName === null || typeof customer.companyName === "string") ||
    typeof raw.dueAt !== "string" || !Number.isFinite(Date.parse(raw.dueAt)) ||
    typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) ||
    !(raw.paidAt === null || typeof raw.paidAt === "string" && Number.isFinite(Date.parse(raw.paidAt)))) {
    throw new GenesisPayConfigError("GenesisPay returned an invalid invoice summary.");
  }
  return { id: raw.id, publicId: raw.publicId, invoiceNumber: raw.invoiceNumber,
    status: raw.status as InvoiceStatus, asset: raw.asset, chainId: raw.chainId, totalMinor: raw.totalMinor,
    customer: { name: customer.name, companyName: customer.companyName },
    dueAt: raw.dueAt, createdAt: raw.createdAt, paidAt: raw.paidAt };
}
