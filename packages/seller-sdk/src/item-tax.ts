import { GenesisPayConfigError } from "./errors.js";

/** Seller-provided inclusive item tax. This is not automatic tax determination. */
export type ItemTax = {
  version: 1;
  treatment: "taxable" | "zero_rated" | "exempt" | "not_collected";
  /** Integer basis points: 2000 = 20%. Taxable requires 1..10000, others 0. */
  rateBps: number;
  /** Required nonempty explanation for zero_rated, exempt and not_collected. */
  note: string | null;
};

export function parseItemTax(value: unknown): ItemTax | null {
  // Old servers/entries are unconfigured, never silently zero-rated.
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new GenesisPayConfigError("Invalid item tax configuration.");
  const tax = value as Record<string, unknown>;
  const treatment = tax.treatment;
  const note = typeof tax.note === "string" ? tax.note.trim() : tax.note;
  if (tax.version !== 1 || !["taxable", "zero_rated", "exempt", "not_collected"].includes(String(treatment)) ||
      typeof tax.rateBps !== "number" || !Number.isInteger(tax.rateBps) || tax.rateBps < 0 || tax.rateBps > 10000 ||
      !(note === null || typeof note === "string") || (typeof note === "string" && note.length > 1000) ||
      (treatment === "taxable" ? tax.rateBps === 0 : tax.rateBps !== 0 || !note)) {
    throw new GenesisPayConfigError("Invalid item tax configuration. Supply a positive taxable rate or an explicit zero-tax treatment with a reason.");
  }
  return { version: 1, treatment: treatment as ItemTax["treatment"], rateBps: tax.rateBps, note };
}

export type ItemTaxUpdate = { taxConfig: ItemTax; expectedTaxConfig: ItemTax | null };

export type ExternalOrderTax = {
  version: 2;
  calculation: "external";
  source: "woocommerce";
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
};

export type PaymentLinkTax = ItemTax | ExternalOrderTax;

export function parsePaymentLinkTax(value: unknown): PaymentLinkTax | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new GenesisPayConfigError("Invalid payment tax configuration.");
  const tax = value as Record<string, unknown>;
  if (tax.version === 1) return parseItemTax(value);
  const canonical = (entry: unknown) => typeof entry === "string" && /^(0|[1-9][0-9]*)$/.test(entry);
  if (tax.version !== 2 || tax.calculation !== "external" || tax.source !== "woocommerce" ||
      !canonical(tax.subtotalMinor) || !canonical(tax.taxMinor) || !canonical(tax.totalMinor) ||
      BigInt(tax.totalMinor as string) <= 0n ||
      BigInt(tax.subtotalMinor as string) + BigInt(tax.taxMinor as string) !== BigInt(tax.totalMinor as string)) {
    throw new GenesisPayConfigError("Invalid externally calculated order tax.");
  }
  return {
    version: 2,
    calculation: "external",
    source: "woocommerce",
    subtotalMinor: tax.subtotalMinor as string,
    taxMinor: tax.taxMinor as string,
    totalMinor: tax.totalMinor as string,
  };
}
