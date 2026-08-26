// The query parameters GenesisPay appends to a merchant's `returnUrl` after a
// confirmed payment, and the helper that reads them back.
//
// These names are part of a cross-side contract: the server's hosted-checkout
// URL builder (`src/features/payments/checkout-return-url.ts`) writes them and
// this SDK reads them. A parity test lives on the server side (the only place
// that can import both) and fails if either side renames one without the other.
//
// The parser below performs **no verification**. The parameters are unsigned —
// anyone who knows a `publicId` can construct that URL without paying — so a
// hint it returns is a UI convenience, never proof of payment.

/** The `returnUrl` query parameter carrying the checkout link's `publicId`. */
export const CHECKOUT_RETURN_LINK_ID_PARAM = "genesispay_link_id";

/** The `returnUrl` query parameter carrying the checkout status. */
export const CHECKOUT_RETURN_STATUS_PARAM = "genesispay_status";

/** The only status the parser accepts — and the only status GenesisPay writes. */
const PAID_STATUS = "paid";

/** Hostnames for which `http` is accepted (local development only). */
const LOCAL_REDIRECT_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * The result parameters GenesisPay appends to a merchant's `returnUrl`, as
 * read back by {@link parseCheckoutReturnHint}.
 *
 * **This is a UI hint, not proof of payment.** The values are unsigned and a
 * payer can open that URL without paying. Gate fulfilment on a verified
 * `payment.confirmed` webhook or on `checkout.retrieve(publicId).paid` — never
 * on these fields.
 */
export type CheckoutReturnHint = {
  /** The checkout link's `publicId` — the value in `genesispay_link_id`. */
  linkId: string;
  /** Always `"paid"` — the parser returns nothing else. */
  status: "paid";
};

/**
 * Reads the return parameters off a `returnUrl`.
 *
 * Returns a hint only when the URL carries a non-empty `genesispay_link_id` and
 * an exact `genesispay_status=paid`. A missing id, any other status, or an
 * unparseable URL returns `null`. Accepts a string or an already-parsed `URL`.
 *
 * Performs **no verification**: it does not check that the link exists, that it
 * was paid, or that the parameters came from GenesisPay. Call
 * `checkout.retrieve(hint.linkId)` (authenticated with your seller key) before
 * acting on it.
 */
export function parseCheckoutReturnHint(url: string | URL): CheckoutReturnHint | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }

  const linkId = parsed.searchParams.get(CHECKOUT_RETURN_LINK_ID_PARAM);
  const status = parsed.searchParams.get(CHECKOUT_RETURN_STATUS_PARAM);

  if (!linkId || status !== PAID_STATUS) {
    return null;
  }

  return { linkId, status: PAID_STATUS };
}

/**
 * The payer-facing redirect scheme allowlist for `returnUrl`/`cancelUrl`,
 * mirroring the server. `https` is always accepted; `http` is accepted only for
 * the exact loopback hostnames above — a `javascript:`/`data:` value, a remote
 * `http` host, or a deceptive `localhost.example` name is rejected, because
 * these values are rendered as links in the payer's browser.
 */
export function isPayerRedirectUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }

  if (parsed.protocol === "https:") {
    return true;
  }

  return parsed.protocol === "http:" && LOCAL_REDIRECT_HOSTNAMES.has(parsed.hostname);
}
