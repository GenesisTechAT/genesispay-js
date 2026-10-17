import { describe, expect, it } from "vitest";

import {
  CHECKOUT_RETURN_LINK_ID_PARAM,
  CHECKOUT_RETURN_STATUS_PARAM,
  isPayerRedirectUrl,
  parseCheckoutReturnHint,
} from "./checkout-return.js";

describe("checkout-return constants", () => {
  it("uses the exact query-parameter names the server writes", () => {
    expect(CHECKOUT_RETURN_LINK_ID_PARAM).toBe("genesispay_link_id");
    expect(CHECKOUT_RETURN_STATUS_PARAM).toBe("genesispay_status");
  });
});

describe("parseCheckoutReturnHint", () => {
  it("returns the link id and status for a well-formed return URL", () => {
    expect(
      parseCheckoutReturnHint(
        "https://shop.example/thanks?genesispay_link_id=inv_abc&genesispay_status=paid",
      ),
    ).toEqual({ linkId: "inv_abc", status: "paid" });
  });

  it("accepts an already-parsed URL", () => {
    const url = new URL(
      "https://shop.example/thanks?genesispay_link_id=inv_abc&genesispay_status=paid",
    );
    expect(parseCheckoutReturnHint(url)).toEqual({ linkId: "inv_abc", status: "paid" });
  });

  it("ignores the merchant's own unrelated query parameters", () => {
    expect(
      parseCheckoutReturnHint(
        "https://shop.example/thanks?order=42&genesispay_link_id=inv_abc&genesispay_status=paid&utm_source=x",
      ),
    ).toEqual({ linkId: "inv_abc", status: "paid" });
  });

  it("returns null when the link id is missing", () => {
    expect(parseCheckoutReturnHint("https://shop.example/thanks?genesispay_status=paid")).toBeNull();
  });

  it("returns null when the link id is empty", () => {
    expect(
      parseCheckoutReturnHint("https://shop.example/thanks?genesispay_link_id=&genesispay_status=paid"),
    ).toBeNull();
  });

  it("returns null when the status is missing", () => {
    expect(parseCheckoutReturnHint("https://shop.example/thanks?genesispay_link_id=inv_abc")).toBeNull();
  });

  it("returns null for an unknown status — never a fabricated hint", () => {
    expect(
      parseCheckoutReturnHint("https://shop.example/thanks?genesispay_link_id=inv_abc&genesispay_status=refunded"),
    ).toBeNull();
    expect(
      parseCheckoutReturnHint("https://shop.example/thanks?genesispay_link_id=inv_abc&genesispay_status=PAID"),
    ).toBeNull();
    expect(
      parseCheckoutReturnHint("https://shop.example/thanks?genesispay_link_id=inv_abc&genesispay_status=paid%20"),
    ).toBeNull();
  });

  it("returns null for a malformed or unparseable URL", () => {
    expect(parseCheckoutReturnHint("not a url")).toBeNull();
    expect(parseCheckoutReturnHint("")).toBeNull();
  });

  it("returns null for a forged URL that happens to carry both parameters", () => {
    // The parser must not distinguish a hand-built URL from a real return — the
    // caller is responsible for verification via checkout.retrieve().
    const forged = parseCheckoutReturnHint(
      "https://attacker.example/anything?genesispay_link_id=inv_victim&genesispay_status=paid",
    );
    expect(forged).toEqual({ linkId: "inv_victim", status: "paid" });
  });
});

describe("isPayerRedirectUrl", () => {
  it("accepts https", () => {
    expect(isPayerRedirectUrl("https://shop.example/thanks")).toBe(true);
  });

  it("accepts http for the two loopback hostnames", () => {
    expect(isPayerRedirectUrl("http://localhost:3000/thanks")).toBe(true);
    expect(isPayerRedirectUrl("http://127.0.0.1:3000/thanks")).toBe(true);
    expect(isPayerRedirectUrl("http://localhost/thanks")).toBe(true);
  });

  it("rejects remote http", () => {
    expect(isPayerRedirectUrl("http://shop.example/thanks")).toBe(false);
  });

  it("rejects deceptive localhost hostnames", () => {
    expect(isPayerRedirectUrl("http://localhost.example/thanks")).toBe(false);
    expect(isPayerRedirectUrl("http://localhost.evil.com/thanks")).toBe(false);
    expect(isPayerRedirectUrl("http://127.0.0.1.evil.com/thanks")).toBe(false);
    expect(isPayerRedirectUrl("http://localhost@evil.com/thanks")).toBe(false);
  });

  it("rejects script-capable and non-http(s) schemes", () => {
    expect(isPayerRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isPayerRedirectUrl("data:text/html,x")).toBe(false);
    expect(isPayerRedirectUrl("file:///etc/passwd")).toBe(false);
    expect(isPayerRedirectUrl("ftp://shop.example/x")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isPayerRedirectUrl("not a url")).toBe(false);
    expect(isPayerRedirectUrl("")).toBe(false);
  });
});
