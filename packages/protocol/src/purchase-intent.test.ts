import { describe, expect, it, vi } from "vitest";

import {
  PURCHASE_INTENT_APPROVAL_QUOTE_MAX_LENGTH,
  PURCHASE_INTENT_VERSION,
  digestPurchaseConversation,
  digestPurchaseIntent,
  isPurchaseDigest,
  parsePurchaseIntent,
  serializePurchaseConversation,
  serializePurchaseIntent,
  type PurchaseConversationMessage,
  type PurchaseDigest,
  type PurchaseIntent,
} from "./index.js";

// Frozen version-1 vectors, independently computed with Python hashlib SHA-256
// over UTF-8 compact JSON. Changing these bytes changes the public contract.
const CONVERSATION_DIGEST: PurchaseDigest = "sha256:01da82ee719aac4b539de8b60592ac5584e5329abb4e8776601161860e7859c6";
const X402_DIGEST: PurchaseDigest = "sha256:c909f122bc3ee2242afeb91441f78f5a43092498a0bfe5809d588aae17a5a3bd";
const COMMERCE_DIGEST: PurchaseDigest = "sha256:c2202050fd4603f987d498d7d4f8299c54233bce0f31adec565cb9e561a58a83";

function messages(): PurchaseConversationMessage[] {
  return [
    { role: "user", content: "Buy the café report ☕." },
    { role: "assistant", content: "The report costs 1 USDC." },
  ];
}

function x402Intent(): PurchaseIntent {
  return {
    version: 1,
    item: { kind: "x402_resource", url: "https://example.com/report" },
    maxTotal: { asset: "USDC", amountMinor: "1010000" },
    delivery: null,
    approvalQuote: "Buy the café report ☕.",
    conversationDigest: CONVERSATION_DIGEST,
  };
}

function commerceIntent(): PurchaseIntent {
  return {
    version: 1,
    item: { kind: "commerce_product", productId: "prod_12345678", quantity: 2, shippingOptionId: "flat_rate:1" },
    maxTotal: { asset: "EURC", amountMinor: "12500000" },
    delivery: { kind: "saved_shipping_profile" },
    approvalQuote: "Buy two notebooks.",
    conversationDigest: CONVERSATION_DIGEST,
  };
}

function alteredIntent(intent: PurchaseIntent, path: string[], value: unknown, remove = false): unknown {
  const copy = structuredClone(intent);
  let parent = copy as unknown as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string, unknown>;
  }
  const key = path[path.length - 1];
  if (remove) delete parent[key];
  else parent[key] = value;
  return copy;
}

describe("purchase intent", () => {
  it("exports the version and quote bound", () => {
    expect(PURCHASE_INTENT_VERSION).toBe(1);
    expect(PURCHASE_INTENT_APPROVAL_QUOTE_MAX_LENGTH).toBe(500);
  });

  it.each([x402Intent(), commerceIntent()])("returns fresh objects for $item.kind", (intent) => {
    const parsed = parsePurchaseIntent(intent);
    expect(parsed).toEqual(intent);
    expect(parsed).not.toBe(intent);
    expect(parsed.item).not.toBe(intent.item);
    expect(parsed.maxTotal).not.toBe(intent.maxTotal);
    if (intent.delivery) expect(parsed.delivery).not.toBe(intent.delivery);
  });

  const objectCases = [
    { name: "root", intent: x402Intent(), path: [], keys: Object.keys(x402Intent()) },
    { name: "x402 item", intent: x402Intent(), path: ["item"], keys: ["kind", "url"] },
    { name: "commerce item", intent: commerceIntent(), path: ["item"], keys: ["kind", "productId", "quantity", "shippingOptionId"] },
    { name: "maxTotal", intent: x402Intent(), path: ["maxTotal"], keys: ["asset", "amountMinor"] },
    { name: "delivery", intent: commerceIntent(), path: ["delivery"], keys: ["kind"] },
  ];
  describe.each(objectCases)("exact keys: $name", ({ intent, path, keys }) => {
    it("refuses extra keys", () => {
      expect(() => parsePurchaseIntent(alteredIntent(intent, [...path, "extra"], true)))
        .toThrow(`purchaseIntent.${[...path, "extra"].join(".")}`);
    });
    it.each(keys)("refuses missing %s", (key) => {
      expect(() => parsePurchaseIntent(alteredIntent(intent, [...path, key], undefined, true)))
        .toThrow(`purchaseIntent.${[...path, key].join(".")}`);
    });
  });

  it.each([null, [], "intent", 1, undefined])("refuses a non-object root: %s", (value) => {
    expect(() => parsePurchaseIntent(value)).toThrow("purchaseIntent");
  });

  it.each([
    ["approvalQuote", ""], ["approvalQuote", "\ud800"], ["approvalQuote", "\udfff"],
    ["approvalQuote", "a\ud800b"], ["approvalQuote", "a\udfff\ud800b"],
    ["approvalQuote", "a\nb"], ["approvalQuote", "a\tb"], ["approvalQuote", "a\u0000b"],
    ["approvalQuote", "a\u007fb"], ["approvalQuote", "a\u0085b"],
    ["approvalQuote", "a".repeat(501)], ["approvalQuote", " Buy it"], ["approvalQuote", "Buy it "],
    ["approvalQuote", "\u00a0Buy it"], ["approvalQuote", 123],
    ["approvalQuote", "Buy\u2028it"], ["approvalQuote", "Buy\u2029it"], ["approvalQuote", "\u200BBuy it"],
    ["approvalQuote", "Buy\u200Bit"], ["approvalQuote", "Buy \u202ECDSU 1"], ["approvalQuote", "Buy\u202Ait"],
    ["approvalQuote", "Buy\u200Eit"], ["approvalQuote", "Buy\u200Fit"], ["approvalQuote", "Buy\u2066it\u2069"],
    ["approvalQuote", "Buy\uFEFFit"], ["approvalQuote", "Pay 10 \u061C5 USDC"], ["approvalQuote", "Buy\u{E0041}it"],
    ["approvalQuote", "Buy\u2060it"], ["approvalQuote", "Buy\u00ADit"], ["approvalQuote", "Buy\u3164it"],
    ["approvalQuote", "Buy\u034Fit"], ["approvalQuote", "Buy\uFFF9it"],
    ["approvalQuote", "Buy\uFE00it"], ["approvalQuote", "Buy\u{E0100}it"], ["approvalQuote", "Buy\u180Bit"],
    ["approvalQuote", "Buy\u17B4it"], ["approvalQuote", "Buy\u2065it"], ["approvalQuote", "Buy\u{E0080}it"],
    ["approvalQuote", "Buy\uFFF0it"], ["approvalQuote", "\uFE0FBuy it"], ["approvalQuote", "Buy \u2764\uFE0F\uFE0F"],
    ["approvalQuote", "Buy\uFE0E\uFE0Fit"],
    ["approvalQuote", "Buy" + "\u200C\u200D".repeat(20) + "it"], ["approvalQuote", "\u200CBuy it"], ["approvalQuote", "Buy it\u200D"],
    ["approvalQuote", "B\u200Cuy it"], ["approvalQuote", "Buy" + "\u200D\uFE0F".repeat(10) + "it"],
    ["approvalQuote", "B\uFE0Fu\uFE0Ey it"], ["approvalQuote", "Buy \u{1F600}\u200Dit"], ["approvalQuote", "Buy\uE000it"],
    ["approvalQuote", "Buy\u0378it"], ["approvalQuote", "Buy\uFFFFit"], ["approvalQuote", "Buy\u00A0it"],
    ["approvalQuote", "Buy\u2003it"], ["approvalQuote", "Buy\u3000it"], ["approvalQuote", "Buy\u2800it"],
    ["approvalQuote", "\uFFFC"], ["approvalQuote", "Buy\uFFFCit"], ["approvalQuote", "Buy it\uFFFC"],
    ["approvalQuote", "Buy the cafe\u0301"], ["approvalQuote", "Buy \u0301it"], ["approvalQuote", "\u0301Buy it"],
    ["approvalQuote", "Buy a\u0301\u0301\u0301\u0301"], ["approvalQuote", "Buy a\u20DD"], ["approvalQuote", "Buy 1\u20E3"],
    ["approvalQuote", "Buy \u{1F600}\u200D\u{1F600}"], ["approvalQuote", "\u0915\u200C\u0915"],
    ["approvalQuote", "\u0915\u200C\u0628"], ["approvalQuote", "\u0628\u200C1"],
    ["approvalQuote", "Buy  it"], ["approvalQuote", "Buy" + " ".repeat(200) + "it"],
    ["approvalQuote", "Pay 1\uFE0E USDC"], ["approvalQuote", "Buy a\u0338\u0338"],
    ["approvalQuote", "Buy it" + "\u{1D159}".repeat(100)], ["approvalQuote", "\u{1D159}"],
    ["approvalQuote", "Buy \u{1D159} it"], ["approvalQuote", "Buy\u303Fit"], ["approvalQuote", "Buy\u{1DA7F}it"],
    ["approvalQuote", "Buy\u{1DA80}it"],
    ["approvalQuote", "Buy it" + "\u{13441}\u{13442}".repeat(100)], ["approvalQuote", "\u{13441}"], ["approvalQuote", "\u2800Buy it"], ["approvalQuote", "Buy it\u2800"],
    ["maxTotal.amountMinor", "0"], ["maxTotal.amountMinor", "01"], ["maxTotal.amountMinor", "-1"],
    ["maxTotal.amountMinor", "1.5"], ["maxTotal.amountMinor", "9223372036854775808"],
    ["maxTotal.amountMinor", "10000000000000000000"], ["maxTotal.amountMinor", "1\n"],
    ["maxTotal.amountMinor", " 1"], ["maxTotal.amountMinor", 1],
    ["maxTotal.asset", "USD"], ["maxTotal.asset", "usdc"],
    ["maxTotal", null], ["item", []], ["item.kind", "unknown"],
    ["conversationDigest", `sha256:${"A".repeat(64)}`],
    ["conversationDigest", `sha256:${"a".repeat(63)}`],
    ["conversationDigest", `sha256:${"a".repeat(65)}`],
    ["conversationDigest", `${CONVERSATION_DIGEST}\n`],
    ["conversationDigest", 123], ["version", 2], ["version", "1"],
    ["item.url", "https://user:password@example.com/report"],
    ["item.url", "https://user@example.com/report"],
    ["item.url", "ftp://example.com/report"], ["item.url", "javascript:alert(1)"],
    ["item.url", "not a url"], ["item.url", "https://example.com/" + "a".repeat(2048)],
    ["item.url", 1], ["delivery", { kind: "saved_shipping_profile" }],
  ])("refuses %s = %j", (path, value) => {
    expect(() => parsePurchaseIntent(alteredIntent(x402Intent(), path.split("."), value)))
      .toThrow(`purchaseIntent.${path}`);
  });

  it.each([
    ["delivery", null], ["delivery", {}], ["delivery.kind", "other"],
    ["item.productId", "prod_short"], ["item.productId", `prod_${"a".repeat(188)}`],
    ["item.productId", "prod_12345678\n"], ["item.productId", "prod_1234567!"],
    ["item.productId", 1], ["item.quantity", 0], ["item.quantity", 21],
    ["item.quantity", 1.5], ["item.quantity", "1"], ["item.quantity", NaN],
    ["item.shippingOptionId", ""], ["item.shippingOptionId", "a".repeat(301)],
    ["item.shippingOptionId", 1], ["item.shippingOptionId", "a\ud800"],
  ])("refuses commerce %s = %j", (path, value) => {
    expect(() => parsePurchaseIntent(alteredIntent(commerceIntent(), path.split("."), value)))
      .toThrow(`purchaseIntent.${path}`);
  });

  it("MR-101/MR-102: accepts int8 max and both assets, without amount conversion", () => {
    for (const asset of ["USDC", "EURC"] as const) {
      const maxTotal = { asset, amountMinor: "9223372036854775807" };
      expect(parsePurchaseIntent({ ...x402Intent(), maxTotal }).maxTotal).toEqual(maxTotal);
    }
    expect(parsePurchaseIntent({ ...x402Intent(), maxTotal: { asset: "USDC", amountMinor: "1" } }).maxTotal.amountMinor).toBe("1");
  });

  it.each(["a".repeat(500), "界".repeat(500), "😀".repeat(250), "A", "Buy it 👩\u200D💻", "Buy it \u2764\uFE0F", "Buy it \u{1F44D}\u{1F3FD}", "Buy \u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "Buy 1\uFE0F\u20E3 \u{1F1E6}\u{1F1F9}", "Kauf es für 10 €.", "Buy q\u0323\u0301", "\u0915\u094D\u200C\u0937", "Buy \u2764\uFE0E", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"].map((approvalQuote) => ({ approvalQuote, length: approvalQuote.length })))("accepts a valid quote of $length code units", ({ approvalQuote }) => {
    expect(parsePurchaseIntent({ ...x402Intent(), approvalQuote }).approvalQuote).toBe(approvalQuote);
  });

  it.each([1, 20])("accepts quantity %i and identifier length bounds", (quantity) => {
    for (const length of [8, 187]) {
      const item = { kind: "commerce_product", productId: `prod_${"a".repeat(length)}`, quantity, shippingOptionId: "a".repeat(300) };
      expect(parsePurchaseIntent({ ...commerceIntent(), item }).item).toEqual(item);
    }
  });

  it.each(["HTTPS://EXAMPLE.COM:443/a/../report", " https://example.com/report ", "https://exa\tmple.com/report",
    "https://example.com", "https://bücher.example/report"])("refuses the non-canonical URL %j", (url) => {
    expect(() => parsePurchaseIntent({ ...x402Intent(), item: { kind: "x402_resource", url } }))
      .toThrow("purchaseIntent.item.url must be in canonical form");
  });

  it("accepts a canonical HTTP(S) URL up to the length bound", () => {
    const url = "http://example.com/" + "a".repeat(2048 - "http://example.com/".length);
    expect(parsePurchaseIntent({ ...x402Intent(), item: { kind: "x402_resource", url } }).item).toEqual({ kind: "x402_resource", url });
  });

  it("recognizes only lowercase 32-byte purchase digests", () => {
    expect(isPurchaseDigest(CONVERSATION_DIGEST)).toBe(true);
    for (const value of [null, 1, "", `SHA256:${"a".repeat(64)}`, `sha256:${"g".repeat(64)}`, `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, `${CONVERSATION_DIGEST}\n`]) {
      expect(isPurchaseDigest(value)).toBe(false);
    }
  });

  it("freezes the x402 canonical JSON and digest", () => {
    expect(serializePurchaseIntent(x402Intent())).toBe('{"type":"genesispay.purchase_intent","version":1,"item":{"kind":"x402_resource","url":"https://example.com/report"},"maxTotal":{"asset":"USDC","amountMinor":"1010000"},"delivery":null,"approvalQuote":"Buy the café report ☕.","conversationDigest":"sha256:01da82ee719aac4b539de8b60592ac5584e5329abb4e8776601161860e7859c6"}');
    expect(digestPurchaseIntent(x402Intent())).toBe(X402_DIGEST);
  });

  it("freezes the commerce canonical JSON and digest", () => {
    expect(serializePurchaseIntent(commerceIntent())).toBe('{"type":"genesispay.purchase_intent","version":1,"item":{"kind":"commerce_product","productId":"prod_12345678","quantity":2,"shippingOptionId":"flat_rate:1"},"maxTotal":{"asset":"EURC","amountMinor":"12500000"},"delivery":{"kind":"saved_shipping_profile"},"approvalQuote":"Buy two notebooks.","conversationDigest":"sha256:01da82ee719aac4b539de8b60592ac5584e5329abb4e8776601161860e7859c6"}');
    expect(digestPurchaseIntent(commerceIntent())).toBe(COMMERCE_DIGEST);
  });

  it.each([x402Intent(), commerceIntent()])("ignores caller key order at every level for $item.kind", (intent) => {
    function reverseKeys(value: unknown): unknown {
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]));
    }
    const reordered = reverseKeys(intent) as PurchaseIntent;
    expect(serializePurchaseIntent(reordered)).toBe(serializePurchaseIntent(intent));
    expect(digestPurchaseIntent(reordered)).toBe(digestPurchaseIntent(intent));
    expect(JSON.stringify(parsePurchaseIntent(reordered))).toBe(JSON.stringify(intent));
  });

  it("validates before serializing or hashing an intent", () => {
    const invalid = { ...x402Intent(), approvalQuote: " no trimming " };
    expect(() => serializePurchaseIntent(invalid)).toThrow("purchaseIntent.approvalQuote");
    expect(() => digestPurchaseIntent(invalid)).toThrow("purchaseIntent.approvalQuote");
  });
});

describe("purchase intent without Intl.Segmenter", () => {
  it("still loads and digests, but refuses every approval quote", async () => {
    const original = Intl.Segmenter;
    Reflect.deleteProperty(Intl, "Segmenter");
    try {
      vi.resetModules();
      const reloaded = await import("./purchase-intent.js");
      expect(() => reloaded.parsePurchaseIntent(x402Intent())).toThrow("purchaseIntent.approvalQuote");
      expect(reloaded.digestPurchaseConversation(messages())).toBe(CONVERSATION_DIGEST);
    } finally {
      Object.defineProperty(Intl, "Segmenter", { value: original, writable: true, configurable: true });
      vi.resetModules();
    }
  });
});

describe("purchase conversation", () => {
  it("freezes canonical JSON and digest", () => {
    expect(serializePurchaseConversation(messages())).toBe('{"type":"genesispay.purchase_conversation","version":1,"messages":[{"role":"user","content":"Buy the café report ☕."},{"role":"assistant","content":"The report costs 1 USDC."}]}');
    expect(digestPurchaseConversation(messages())).toBe(CONVERSATION_DIGEST);
  });

  it.each([
    null, {}, "messages", [], [{ role: "assistant", content: "No user" }],
    [{ role: "system", content: "hidden" }], [{ role: "tool", content: "hidden" }],
    [{ role: "user", content: "Buy it" }, { role: "system", content: "hidden" }],
    [{ role: "user", content: "Buy it" }, { role: "tool", content: "hidden" }],
    [{ role: "user", content: "" }], [{ role: "user", content: 1 }],
    [{ role: "user", content: "a\ud800b" }], [{ role: "user", content: "a\udfffb" }],
    [{ role: "user", content: "a\udfff\ud800b" }],
    [{ role: "user", content: "Buy it", extra: true }],
    [{ role: "user" }], [{ content: "Buy it" }], [null], new Array(1),
  ].map((value) => ({ value })))("refuses invalid messages: $value", ({ value }) => {
    const input = value as unknown as PurchaseConversationMessage[];
    expect(() => serializePurchaseConversation(input)).toThrow("purchaseConversation.messages");
    expect(() => digestPurchaseConversation(input)).toThrow("purchaseConversation.messages");
  });

  it("freezes JSON escaping of quotes, backslashes, controls and U+2028", () => {
    // Independently computed with Python json.dumps(ensure_ascii=False, separators=(",", ":")) + hashlib.
    const input = [{ role: "user", content: '"q\\"\n\u0000\u2028😀' }] as const;
    expect(serializePurchaseConversation(input)).toBe('{"type":"genesispay.purchase_conversation","version":1,"messages":[{"role":"user","content":"\\"q\\\\\\"\\n\\u0000\u2028😀"}]}');
    expect(digestPurchaseConversation(input)).toBe("sha256:21f32bafeac81c42fbcc84d3db1b6fd93e61450b9943fd23318ed0e10afeea85");
  });

  it("names the invalid message field and index", () => {
    expect(() => serializePurchaseConversation([...messages(), { role: "user", content: "\ud800" }]))
      .toThrow("purchaseConversation.messages[2].content");
  });

  it("binds message order, role and a single trailing space", () => {
    const original = messages();
    expect(digestPurchaseConversation([...original].reverse())).not.toBe(CONVERSATION_DIGEST);
    expect(digestPurchaseConversation([original[0], { ...original[1], role: "user" }])).not.toBe(CONVERSATION_DIGEST);
    expect(digestPurchaseConversation([{ ...original[0], content: original[0].content + " " }, original[1]])).not.toBe(CONVERSATION_DIGEST);
  });

  it("preserves whitespace, controls and Unicode without NFC normalization", () => {
    const input = [{ role: "user", content: " \n\t\u0000e\u0301😀 " }] as const;
    expect(JSON.parse(serializePurchaseConversation(input)).messages).toEqual(input);
    expect(digestPurchaseConversation(input)).not.toBe(digestPurchaseConversation([{ role: "user", content: input[0].content.normalize("NFC") }]));
    expect(() => serializePurchaseConversation([{ role: "user", content: " " }])).not.toThrow();
  });

  it("has no protocol message-count or content-size cap", () => {
    const input: PurchaseConversationMessage[] = Array.from({ length: 25 }, () => ({ role: "user", content: "a".repeat(40_000) }));
    expect(JSON.parse(serializePurchaseConversation(input)).messages).toEqual(input);
  });

  it("ignores message key order and leaves caller objects intact", () => {
    const input = messages().map(({ role, content }) => Object.freeze({ content, role }));
    Object.freeze(input);
    expect(serializePurchaseConversation(input)).toBe(serializePurchaseConversation(messages()));
    expect(digestPurchaseConversation(input)).toBe(CONVERSATION_DIGEST);
  });
});
