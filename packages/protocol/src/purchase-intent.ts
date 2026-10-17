import { sha256 } from "viem";

import { requireRecord } from "./field-validation.js";

export const PURCHASE_INTENT_VERSION = 1;
/** UTF-16 code units; at most 1,500 UTF-8 bytes for well-formed Unicode. */
export const PURCHASE_INTENT_APPROVAL_QUOTE_MAX_LENGTH = 500;

export type PurchaseDigest = `sha256:${string}`;

export type PurchaseIntentItem =
  | { kind: "x402_resource"; url: string }
  | {
      kind: "commerce_product";
      productId: string;
      quantity: number;
      shippingOptionId: string;
    };

export type PurchaseIntentMaxTotal = {
  asset: "USDC" | "EURC";
  /** Positive int8 minor units (six decimals), bounding price + buyer fee (MR-1013). */
  amountMinor: string;
};

export type PurchaseIntent = {
  version: typeof PURCHASE_INTENT_VERSION;
  maxTotal: PurchaseIntentMaxTotal;
  approvalQuote: string;
  conversationDigest: PurchaseDigest;
} & (
  | { item: Extract<PurchaseIntentItem, { kind: "x402_resource" }>; delivery: null }
  | {
      item: Extract<PurchaseIntentItem, { kind: "commerce_product" }>;
      delivery: { kind: "saved_shipping_profile" };
    }
);

export type PurchaseConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

// ES2022 has no String.prototype.isWellFormed. Paired surrogates are allowed.
const LONE_SURROGATE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;
const INT8_MAX = 9_223_372_036_854_775_807n;
// The approval quote must display as the bytes it carries, so it is an
// allow-list, not a deny-list, and leaves no carrier-free hidden channel:
//   - it is NFC, so decomposed and reordered combining marks cannot differ;
//   - every code point is a visible letter, mark, number, punctuation or
//     symbol, or the ASCII space — never a control, separator, private-use,
//     unassigned or default-ignorable code point, no look-alike blank (NBSP,
//     U+2000–U+200A, U+3000, U+2800 Braille blank), no U+FFFC, which
//     renders as nothing, and no blank-drawn symbol (U+303F, U+13441,
//     U+13442, U+1D159, U+1DA7F, U+1DA80);
//   - combining marks sit on a letter or number, at most three in a row, never
//     the same mark twice in a row, and enclosing marks appear only inside an emoji;
//   - a grapheme with ZWJ, U+FE0F or the keycap U+20E3 must be one
//     recommended (RGI) emoji; U+FE0E only directly follows a pictograph;
//   - no run of spaces (HTML and Markdown show it as one space);
//   - ZWNJ only separates two letters of the same joining script (in the
//     Indic scripts, after a vowel sign or virama).
// What remains needs a visible character per bit (homoglyphs, bidi order of
// visible letters): consumers show amounts from maxTotal, never the quote.
// Validity follows the engine's Unicode tables; the server's verdict is
// authoritative, and the digest never depends on them.
const QUOTE_VISIBLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
const QUOTE_HIDDEN = /^[\p{Default_Ignorable_Code_Point}\u2800\u303F\uFFFC\u{13441}\u{13442}\u{1D159}\u{1DA7F}\u{1DA80}]$/u;
const MARK = /^\p{M}$/u;
const ENCLOSING_MARK = /^\p{Me}$/u;
const MARK_CARRIER = /^[\p{L}\p{N}]$/u;
const LETTER = /^\p{L}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const EMOJI_SEQUENCE_PART = /[\u200D\uFE0F\u20E3]/u;
const MAX_CONSECUTIVE_MARKS = 3;
const ZWJ = "\u200D";
const ZWNJ = "\u200C";
const TEXT_SELECTOR = "\uFE0E";
const JOINING_SCRIPTS = [
  /^\p{Script=Arabic}$/u, /^\p{Script=Syriac}$/u, /^\p{Script=Nko}$/u, /^\p{Script=Mongolian}$/u,
];
const INDIC_SCRIPTS = [
  /^\p{Script=Devanagari}$/u, /^\p{Script=Bengali}$/u, /^\p{Script=Gurmukhi}$/u, /^\p{Script=Gujarati}$/u,
  /^\p{Script=Oriya}$/u, /^\p{Script=Tamil}$/u, /^\p{Script=Telugu}$/u, /^\p{Script=Kannada}$/u,
  /^\p{Script=Malayalam}$/u, /^\p{Script=Sinhala}$/u,
];
// The `v` flag is ES2024; an engine without it refuses every emoji sequence
// (fail closed) instead of failing to load the package.
const RGI_EMOJI: RegExp | null = (() => {
  try {
    return new RegExp("^\\p{RGI_Emoji}$", "v");
  } catch {
    return null;
  }
})();
// Created on first use: an engine without Intl.Segmenter refuses quotes
// instead of failing to load the package.
let graphemes: Intl.Segmenter | null | undefined;
function graphemeSegmenter(): Intl.Segmenter | null {
  if (graphemes === undefined) {
    graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  return graphemes;
}

function isAllowedZwnj(before: string, after: string): boolean {
  if (JOINING_SCRIPTS.some((script) => script.test(before) && script.test(after))) {
    return LETTER.test(before) && LETTER.test(after);
  }
  return INDIC_SCRIPTS.some((script) => script.test(before) && script.test(after)) &&
    MARK.test(before) && LETTER_OR_MARK.test(after);
}

function isDisplayFaithfulQuote(quote: string): boolean {
  // HTML and Markdown collapse a run of spaces into one: its length would be a free variable.
  if (quote !== quote.normalize("NFC") || quote.includes("  ")) return false;
  const segmenter = graphemeSegmenter();
  if (segmenter === null) return false;
  for (const { segment } of segmenter.segment(quote)) {
    if (EMOJI_SEQUENCE_PART.test(segment)) {
      if (!RGI_EMOJI?.test(segment)) return false;
    }
  }
  const points = Array.from(quote);
  let marks = 0;
  return points.every((point, index) => {
    const before = points[index - 1] ?? "";
    const after = points[index + 1] ?? "";
    if (point === ZWJ || point === "\uFE0F" || point === "\u20E3") return true; // checked as an RGI emoji above
    if (point === TEXT_SELECTOR) return PICTOGRAPH.test(before) && !EMOJI_SEQUENCE_PART.test(after);
    if (point === ZWNJ) return isAllowedZwnj(before, after);
    if (!QUOTE_VISIBLE.test(point) || QUOTE_HIDDEN.test(point)) return false;
    if (!MARK.test(point)) {
      marks = 0;
      return true;
    }
    marks += 1;
    if (ENCLOSING_MARK.test(point) || marks > MAX_CONSECUTIVE_MARKS || point === before) return false;
    const carrier = points[index - marks] ?? "";
    return MARK_CARRIER.test(carrier);
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  const record = requireRecord(value, field);
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      throw new Error(`${field}.${key} is required`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new Error(`${field}.${key} is not allowed`);
    }
  }
  return record;
}

function verbatimText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (LONE_SURROGATE.test(value)) {
    throw new Error(`${field} must be well-formed Unicode`);
  }
  return value;
}

export function isPurchaseDigest(value: unknown): value is PurchaseDigest {
  return typeof value === "string" && value.length === 71 && /^sha256:[0-9a-f]{64}$/.test(value);
}

function parseItem(value: unknown): PurchaseIntentItem {
  const field = "purchaseIntent.item";
  const record = requireRecord(value, field);
  if (record.kind === "x402_resource") {
    exactRecord(record, ["kind", "url"], field);
    if (typeof record.url !== "string" || record.url.length > 2048) {
      throw new Error(`${field}.url must be an HTTP(S) URL of at most 2048 code units without credentials`);
    }
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      throw new Error(`${field}.url must be an HTTP(S) URL without credentials`);
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username || url.password || url.href.length > 2048
    ) {
      throw new Error(`${field}.url must be an HTTP(S) URL of at most 2048 code units without credentials`);
    }
    // The canonical bytes are the caller's bytes: a URL parser's rewriting
    // (whitespace, case, IDNA, dot segments) never happens inside the digest.
    if (record.url !== url.href) {
      throw new Error(`${field}.url must be in canonical form (new URL(url).href): ${JSON.stringify(url.href)}`);
    }
    return { kind: "x402_resource", url: url.href };
  }
  if (record.kind === "commerce_product") {
    exactRecord(record, ["kind", "productId", "quantity", "shippingOptionId"], field);
    const { productId, quantity, shippingOptionId } = record;
    if (
      typeof productId !== "string" || productId !== productId.trim() ||
      !/^prod_[A-Za-z0-9_-]{8,187}$/.test(productId)
    ) {
      throw new Error(`${field}.productId must be prod_ followed by 8-187 letters, digits, underscores or hyphens`);
    }
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new Error(`${field}.quantity must be an integer from 1 to 20`);
    }
    if (
      typeof shippingOptionId !== "string" || shippingOptionId.length < 1 || shippingOptionId.length > 300 ||
      LONE_SURROGATE.test(shippingOptionId)
    ) {
      throw new Error(`${field}.shippingOptionId must be a well-formed string of 1-300 code units`);
    }
    return { kind: "commerce_product", productId, quantity, shippingOptionId };
  }
  throw new Error(`${field}.kind must be "x402_resource" or "commerce_product"`);
}

/** Strict version-1 wire parser. Returns fresh objects in canonical key order. */
export function parsePurchaseIntent(value: unknown): PurchaseIntent {
  const record = exactRecord(value, [
    "version", "item", "maxTotal", "delivery", "approvalQuote", "conversationDigest",
  ], "purchaseIntent");
  if (record.version !== PURCHASE_INTENT_VERSION) {
    throw new Error("purchaseIntent.version must be 1");
  }
  const item = parseItem(record.item);
  const total = exactRecord(record.maxTotal, ["asset", "amountMinor"], "purchaseIntent.maxTotal");
  const asset = total.asset;
  if (asset !== "USDC" && asset !== "EURC") {
    throw new Error('purchaseIntent.maxTotal.asset must be "USDC" or "EURC"');
  }
  const amountMinor = total.amountMinor;
  if (
    typeof amountMinor !== "string" || amountMinor !== amountMinor.trim() ||
    !/^[1-9][0-9]{0,18}$/.test(amountMinor) || BigInt(amountMinor) > INT8_MAX
  ) {
    throw new Error("purchaseIntent.maxTotal.amountMinor must be a positive decimal integer string at most 9223372036854775807, without leading zeros");
  }
  const maxTotal: PurchaseIntentMaxTotal = { asset, amountMinor };
  const approvalQuote = verbatimText(record.approvalQuote, "purchaseIntent.approvalQuote");
  if (
    approvalQuote.length > PURCHASE_INTENT_APPROVAL_QUOTE_MAX_LENGTH ||
    approvalQuote !== approvalQuote.trim() || !isDisplayFaithfulQuote(approvalQuote)
  ) {
    throw new Error("purchaseIntent.approvalQuote must be 1-500 code units of visible letters, marks, numbers, punctuation, symbols and ASCII spaces, without leading/trailing spaces (ZWJ only inside emoji sequences, emoji selectors only after an emoji, ZWNJ only between joining-script letters)");
  }
  const conversationDigest = record.conversationDigest;
  if (!isPurchaseDigest(conversationDigest)) {
    throw new Error("purchaseIntent.conversationDigest must be sha256: followed by 64 lowercase hex characters");
  }
  if (item.kind === "x402_resource") {
    if (record.delivery !== null) {
      throw new Error("purchaseIntent.delivery must be null for x402_resource");
    }
    return { version: PURCHASE_INTENT_VERSION, item, maxTotal, delivery: null, approvalQuote, conversationDigest };
  }
  const delivery = exactRecord(record.delivery, ["kind"], "purchaseIntent.delivery");
  if (delivery.kind !== "saved_shipping_profile") {
    throw new Error('purchaseIntent.delivery.kind must be "saved_shipping_profile" for commerce_product');
  }
  return {
    version: PURCHASE_INTENT_VERSION, item, maxTotal,
    delivery: { kind: "saved_shipping_profile" }, approvalQuote, conversationDigest,
  };
}

/** Frozen canonical JSON; neither caller key order nor caller toJSON is used. */
export function serializePurchaseIntent(intent: PurchaseIntent): string {
  return JSON.stringify({ type: "genesispay.purchase_intent", ...parsePurchaseIntent(intent) });
}

export function digestPurchaseIntent(intent: PurchaseIntent): PurchaseDigest {
  return digest(serializePurchaseIntent(intent));
}

/** Validates visible turns, preserving their content verbatim, without a size cap. */
export function serializePurchaseConversation(messages: readonly PurchaseConversationMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("purchaseConversation.messages must be a non-empty array");
  }
  const parsed: PurchaseConversationMessage[] = [];
  for (const [index, value] of messages.entries()) {
    const field = `purchaseConversation.messages[${index}]`;
    const message = exactRecord(value, ["role", "content"], field);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`${field}.role must be "user" or "assistant"`);
    }
    parsed.push({ role: message.role, content: verbatimText(message.content, `${field}.content`) });
  }
  if (!parsed.some((message) => message.role === "user")) {
    throw new Error("purchaseConversation.messages must include at least one user message");
  }
  return JSON.stringify({ type: "genesispay.purchase_conversation", version: PURCHASE_INTENT_VERSION, messages: parsed });
}

export function digestPurchaseConversation(messages: readonly PurchaseConversationMessage[]): PurchaseDigest {
  return digest(serializePurchaseConversation(messages));
}

function digest(serialized: string): PurchaseDigest {
  return `sha256:${sha256(new TextEncoder().encode(serialized)).slice(2)}`;
}
