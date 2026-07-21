// What every PeerPay resource module (checkout, plans, mandates) is built on:
// one HTTP seam and one set of tolerant wire mappers.
//
// The seam exists so a resource module never touches `fetch`, the API key or
// the base URL — the client owns those and hands down a bound `PeerPayRequest`.
// That keeps the error mapping in exactly one place (`throwForErrorResponse`,
// see ./errors.ts): a resource that built its own request could quietly grow a
// second, divergent notion of what a 422 means.
//
// The mappers are deliberately forgiving. Every field arrives as `unknown`
// because an older backend — one that predates a column this SDK version knows
// about — must never be able to crash a caller's poll loop or webhook handler.
// Missing or wrong-typed values degrade to null/0/"" or a named default; they
// never throw.

export type PeerPayRequestOptions = {
  /** Defaults to GET. */
  method?: "GET" | "POST";
  /** Path starting with "/", already percent-encoded. */
  path: string;
  /** JSON request body. Omit entirely for a GET (no content-type is sent). */
  body?: unknown;
  /** Label used in error messages, e.g. `POST /api/v1/plans`. */
  operation: string;
  /** Replaces the generic 404 text — a 404 usually needs case-specific wording. */
  notFoundMessage?: string;
  /**
   * Next step for the caller, appended to the message. A function receives the
   * HTTP status so one call site can give, say, a 403 its own guidance without
   * hand-rolling an error class next to the shared mapper.
   */
  hint?: string | ((status: number) => string | undefined);
  /**
   * Filled into "Failed to reach PeerPay to <action>" when the transport itself
   * fails (DNS, connection refused, abort) — there is no response to map then.
   */
  action: string;
};

/** The client's bound request function, as a resource module sees it. */
export type PeerPayRequest = (options: PeerPayRequestOptions) => Promise<unknown>;

/** A non-null, non-array object, or null — the shape a mapper can read fields off. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function requiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Flat `Record<string, string>`; anything else (array, nested object) → null. */
export function optionalMetadata(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function toCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Like `toCount`, but a missing/unusable value stays `null` rather than 0. */
export function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Money crosses the wire as a decimal or minor-unit *string* so no precision is
 * lost. A number is accepted and stringified anyway (a hand-rolled proxy or an
 * older serializer may send one); anything else becomes "" rather than a
 * plausible-looking wrong amount.
 */
export function toAmountString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Same as `toAmountString`, but keeps "not set" distinguishable from "zero". */
export function optionalAmountString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
