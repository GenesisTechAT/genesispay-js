// `genesispay.checkoutDocuments.*` — documents created after hosted human checkout.
//
// These are intentionally read-only. They are not the seller-authored invoice
// lifecycle (`genesispay.invoices.*`): a hosted checkout document is produced
// only after a confirmed, non-simulated payment and is immutable thereafter.

import { GenesisPayConfigError } from "./errors.js";
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

export type CheckoutDocumentKind = "invoice" | "enhanced_receipt";

/** The commercial snapshot frozen before the buyer signs the hosted checkout. */
export type CheckoutDocumentSnapshot = {
  version: number;
  seller: {
    userId: string;
    legalName: string;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    countryCode: string | null;
    taxId: string | null;
    profileVersion?: number;
    taxRegistration?: CheckoutTaxRegistration;
  };
  buyer: {
    legalName: string;
    companyName: string | null;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    region: string | null;
    postalCode: string;
    countryCode: string;
    taxId: string | null;
    email: string;
  };
  lineItem: {
    description: string;
  };
  lines?: Array<{ description: string; quantity: number; unitAmountMinor: string;
    subtotalMinor: string; discountMinor: string; taxMinor: string; totalMinor: string; taxConfig: ItemTax }>;
  invoice: {
    prefix: string;
    pricesIncludeTax: true;
  };
  tax: {
    source: "seller_configured" | null;
    status: "receipt_required" | "calculated";
    reason: string | null;
    taxRateBps: number | null;
    zeroTaxNote: string | null;
    rounding: "half_up_asset_minor_unit" | null;
    settingsUpdatedAt: string | null;
    itemConfig?: ItemTax;
  };
};

export type CheckoutTaxRegistration =
  | { status: "not_registered"; reason: string }
  | { status: "registered"; registrations: Array<{ type: "vat" | "gst" | "tax_id" | "business_number"; countryCode: string; value: string }> };

/** A formal invoice or enhanced receipt issued for a hosted human checkout. */
export type CheckoutDocument = {
  id: string;
  publicId: string;
  kind: CheckoutDocumentKind;
  /** Present only when the seller's tax configuration supported a formal invoice. */
  invoiceNumber: string | null;
  asset: "USDC" | "EURC";
  chainId: number;
  subtotalMinor: string;
  discountMinor: string;
  taxMinor: string;
  totalMinor: string;
  txHash: string | null;
  confirmedAt: string;
  issuedAt: string;
  retainUntil: string;
  recipientEmail: string;
  snapshot: CheckoutDocumentSnapshot;
};

export interface CheckoutDocumentsResource {
  /** Lists the latest 100 immutable documents from hosted human checkout. */
  list(): Promise<CheckoutDocument[]>;
  /** Retrieves one seller-owned document by its public `doc_…` id. */
  get(publicId: string): Promise<CheckoutDocument>;
}

export function createCheckoutDocumentsResource(
  request: GenesisPayRequest,
): CheckoutDocumentsResource {
  return {
    list: async () => {
      const body = await request({
        path: "/api/v1/checkout-documents",
        operation: "GET /api/v1/checkout-documents",
        action: "list hosted checkout documents",
      });
      const rows = asRecord(body)?.documents;
      if (!Array.isArray(rows)) {
        throw new GenesisPayConfigError(
          `GenesisPay GET /api/v1/checkout-documents returned no documents array: ${JSON.stringify(body)}`,
        );
      }
      return rows
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => Boolean(row?.publicId))
        .map(toCheckoutDocument);
    },
    get: async (publicId) => {
      const body = await request({
        path: `/api/v1/checkout-documents/${encodeURIComponent(publicId)}`,
        operation: "GET /api/v1/checkout-documents/:publicId",
        notFoundMessage: `Checkout document ${publicId} was not found.`,
        action: "retrieve a hosted checkout document",
      });
      const row = asRecord(asRecord(body)?.document);
      if (!row) {
        throw new GenesisPayConfigError(
          `GenesisPay GET /api/v1/checkout-documents/:publicId returned no document: ${JSON.stringify(body)}`,
        );
      }
      return toCheckoutDocument(row);
    },
  };
}

export function toCheckoutDocument(raw: Record<string, unknown>): CheckoutDocument {
  return {
    id: requiredString(raw.id),
    publicId: requiredString(raw.publicId),
    kind: oneOf(raw.kind, ["invoice", "enhanced_receipt"] as const, "enhanced_receipt"),
    invoiceNumber: optionalString(raw.invoiceNumber),
    asset: oneOf(raw.asset, ["USDC", "EURC"] as const, "USDC"),
    chainId: toCount(raw.chainId),
    subtotalMinor: toAmountString(raw.subtotalMinor),
    discountMinor: toAmountString(raw.discountMinor),
    taxMinor: toAmountString(raw.taxMinor),
    totalMinor: toAmountString(raw.totalMinor),
    txHash: optionalString(raw.txHash),
    confirmedAt: requiredString(raw.confirmedAt),
    issuedAt: requiredString(raw.issuedAt),
    retainUntil: requiredString(raw.retainUntil),
    recipientEmail: requiredString(raw.recipientEmail),
    snapshot: toCheckoutDocumentSnapshot(asRecord(raw.snapshot) ?? {}),
  };
}

function toCheckoutDocumentSnapshot(raw: Record<string, unknown>): CheckoutDocumentSnapshot {
  const seller = asRecord(raw.seller) ?? {};
  const buyer = asRecord(raw.buyer) ?? {};
  const lineItem = asRecord(raw.lineItem) ?? {};
  const invoice = asRecord(raw.invoice) ?? {};
  const tax = asRecord(raw.tax) ?? {};
  const v2 = raw.version === 2;
  return {
    version: toCount(raw.version),
    seller: {
      userId: requiredString(seller.userId),
      legalName: requiredString(seller.legalName),
      email: optionalString(seller.email),
      addressLine1: optionalString(seller.addressLine1),
      addressLine2: optionalString(seller.addressLine2),
      city: optionalString(seller.city),
      postalCode: optionalString(seller.postalCode),
      countryCode: optionalString(seller.countryCode),
      taxId: optionalString(seller.taxId),
      ...(v2 ? { profileVersion: toCount(seller.profileVersion), taxRegistration: parseCheckoutTaxRegistration(seller.taxRegistration) } : {}),
    },
    buyer: {
      legalName: requiredString(buyer.legalName),
      companyName: optionalString(buyer.companyName),
      addressLine1: requiredString(buyer.addressLine1),
      addressLine2: optionalString(buyer.addressLine2),
      city: requiredString(buyer.city),
      region: optionalString(buyer.region),
      postalCode: requiredString(buyer.postalCode),
      countryCode: requiredString(buyer.countryCode),
      taxId: optionalString(buyer.taxId),
      email: requiredString(buyer.email),
    },
    lineItem: {
      description: requiredString(lineItem.description),
    },
    ...(v2 ? { lines: parseCheckoutLines(raw.lines) } : {}),
    invoice: {
      prefix: requiredString(invoice.prefix),
      pricesIncludeTax: true,
    },
    tax: {
      source: nullableOneOf(tax.source, ["seller_configured"] as const),
      status: oneOf(tax.status, ["receipt_required", "calculated"] as const, "receipt_required"),
      reason: optionalString(tax.reason),
      taxRateBps: optionalFiniteNumber(tax.taxRateBps),
      zeroTaxNote: optionalString(tax.zeroTaxNote),
      rounding: nullableOneOf(tax.rounding, ["half_up_asset_minor_unit"] as const),
      settingsUpdatedAt: optionalString(tax.settingsUpdatedAt),
      ...(v2 ? { itemConfig: requiredItemTax(tax.itemConfig) } : {}),
    },
  };
}

function requiredItemTax(raw: unknown): ItemTax {
  const tax = parseItemTax(raw);
  if (!tax) throw new GenesisPayConfigError("A v2 document requires explicit item tax.");
  return tax;
}

function parseCheckoutLines(raw: unknown): NonNullable<CheckoutDocumentSnapshot["lines"]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new GenesisPayConfigError("A v2 document requires line totals.");
  return raw.map((value) => {
    const line = asRecord(value) ?? {};
    return { description: requiredString(line.description), quantity: toCount(line.quantity),
      unitAmountMinor: toAmountString(line.unitAmountMinor), subtotalMinor: toAmountString(line.subtotalMinor),
      discountMinor: toAmountString(line.discountMinor), taxMinor: toAmountString(line.taxMinor),
      totalMinor: toAmountString(line.totalMinor), taxConfig: requiredItemTax(line.taxConfig) };
  });
}

function parseCheckoutTaxRegistration(value: unknown): CheckoutTaxRegistration {
  const tax = asRecord(value);
  if (tax?.status === "not_registered" && typeof tax.reason === "string") return { status: "not_registered", reason: tax.reason };
  if (tax?.status !== "registered" || !Array.isArray(tax.registrations) || !tax.registrations.length) throw new GenesisPayConfigError("A v2 document requires the issuer tax declaration.");
  return { status: "registered", registrations: tax.registrations.map((value) => {
    const entry = asRecord(value);
    if (!entry || !["vat", "gst", "tax_id", "business_number"].includes(String(entry.type)) || typeof entry.countryCode !== "string" || typeof entry.value !== "string") throw new GenesisPayConfigError("Invalid issuer tax declaration.");
    return { type: entry.type as "vat" | "gst" | "tax_id" | "business_number", countryCode: entry.countryCode, value: entry.value };
  }) };
}

function nullableOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
