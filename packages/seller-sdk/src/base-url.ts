/**
 * Where a seller key may be sent (#947). Every public entry point that takes a
 * URL and then sends the seller key to it — the `GenesisPay` client
 * (`baseUrl`), the low-level `genesisPaySettlement` hook (`facilitatorBaseUrl`)
 * and `createMandateGate` (`baseUrl`) — validates it with `normalizeBaseUrl`
 * here, so none of them can send the key in cleartext to another host. The
 * client and the settlement hook also share the key-mode default
 * (`MODE_BASE_URLS`); the mandate gate has no default and requires `baseUrl`.
 * The client's internal resources (fulfillment, plans, mandates, …) only ever
 * receive the client's already-normalized base URL.
 */
import { GenesisPayConfigError } from "./errors.js";
import type { GenesisPayKeyMode } from "./client.js";

/**
 * The public development facilitator: where a test-mode key (`gp_sk_test_…`,
 * or a legacy `gp_sk_…`) goes when no URL is configured.
 *
 * The custom domain rather than the Railway-generated hostname: the generated
 * form encodes the service name and breaks when the service is renamed.
 */
export const DEFAULT_FACILITATOR_BASE_URL = "https://dev.genesispay.finance";

/**
 * Production GenesisPay facilitator: where a live key (`gp_sk_live_…`) goes
 * when no URL is configured.
 *
 * This is the custom domain, deliberately, not the Railway-generated hostname.
 * The generated form is derived from the service name, so it breaks the moment
 * the service is renamed — and `peerpay-app-production.up.railway.app`, which
 * this used to point at, never existed at all: production has exactly one
 * domain, `genesispay.finance`. Every zero-config live key resolved to a dead
 * host until this line was fixed. Point it at a domain we own, not at one
 * Railway generates for us.
 */
const PRODUCTION_FACILITATOR_BASE_URL = "https://genesispay.finance";

// Both facilitator URLs are hardcoded so the key mode alone routes to the right
// GenesisPay facilitator; an explicit URL still overrides for self-host/staging.
export const MODE_BASE_URLS: Record<GenesisPayKeyMode, string> = {
  test: DEFAULT_FACILITATOR_BASE_URL,
  live: PRODUCTION_FACILITATOR_BASE_URL,
};

/**
 * The mode a seller key's prefix declares, or `null` for a key that is not a
 * GenesisPay seller key. `gp_sk_live_…` is live; `gp_sk_test_…` and the legacy
 * `gp_sk_<32>` are test.
 */
export function keyModeOf(apiKey: string): GenesisPayKeyMode | null {
  if (apiKey.startsWith("gp_sk_live_")) return "live";
  if (apiKey.startsWith("gp_sk_")) return "test";
  return null;
}

/**
 * The seller key is a bearer credential, so it only travels over https. Plain
 * http is accepted for this machine alone (`localhost` / `127.0.0.1`), for local
 * development. A URL that carries userinfo (`user:secret@`) or that WHATWG
 * cannot parse is refused too (#976): fetch rejects a URL with credentials
 * with an error that quotes the URL whole, credential included, and that
 * error would surface in logs and error messages. Trailing slashes are removed.
 */
export function normalizeBaseUrl(url: string, field: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const isHttps = /^https:\/\/[^/]/i.test(trimmed);
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
  if (!isHttps && !isLocalHttp) {
    throw new GenesisPayConfigError(
      `${field} must be https; plain http is allowed only for localhost or 127.0.0.1 (got ${describeRefusedUrl(trimmed)}).`,
    );
  }
  const flaw = structuralFlaw(trimmed);
  if (flaw === "userinfo") {
    throw new GenesisPayConfigError(
      `${field} must not contain a username or password (got ${describeRefusedUrl(trimmed)}).`,
    );
  }
  if (flaw === "unparseable") {
    throw new GenesisPayConfigError(`${field} is not a valid URL (got ${describeRefusedUrl(trimmed)}).`);
  }
  return trimmed;
}

/**
 * Userinfo is looked for twice (#976): as a raw `@` in the authority before
 * parsing — after the scheme, any run of `/` or `\`, up to the next `/`, `\`,
 * `?` or `#`, which is how WHATWG reads an http(s) authority — and in what
 * `new URL` actually parsed. Either one refuses the URL.
 */
function structuralFlaw(url: string): "userinfo" | "unparseable" | null {
  const authority = /^[a-z][a-z0-9+.-]*:[\\/]*([^\\/?#]*)/i.exec(url)?.[1] ?? "";
  if (authority.includes("@")) return "userinfo";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unparseable";
  }
  return parsed.username || parsed.password ? "userinfo" : null;
}

/**
 * A refused value as it may appear in an error message, which ends up in logs
 * and on a CLI's stderr. A value that is not shaped like a URL (no `://`),
 * that looks like a GenesisPay key (`gp_…_`, e.g. the key and URL variables
 * swapped), or that `new URL` cannot parse is not quoted at all (#976): an
 * unparseable value can hide a credential behind a spelling the redaction
 * does not recognise (`user:secret＠host`, `user%3Asecret%40host`,
 * `https://user:secret`).
 */
function describeRefusedUrl(value: string): string {
  if (!value.includes("://") || /\bgp_[a-z]+_/i.test(value) || !isParseableUrl(value)) {
    return "a value that is not a URL";
  }
  return `"${redactUrlForMessage(value)}"`;
}

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whenever an `@` appears anywhere in the value, everything after the scheme
 * is replaced by `//***` (#976): WHATWG also reads `http:///user:pw@host`,
 * `http:/\user:pw@host` and `http:\/user:pw@host` as userinfo, and a `#`, `?`
 * or `/` inside a password moves where a parser thinks the authority ends, so
 * the only spelling-proof redaction is to show none of it. Otherwise the query
 * and fragment are dropped. Works on strings that are not valid URLs too.
 */
function redactUrlForMessage(url: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? "";
  const shown = url.includes("@") ? `${scheme}//***` : url.replace(/[?#][\s\S]*$/, "?…");
  return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
}
