/** Covered by packages/agent-sdk/src/client.test.ts ("GenesisPayAgent constructor"), which reaches it through the constructor. */

/**
 * The agent key (`gp_ag_…`) is a bearer credential that can spend, so it only
 * travels over https (#947). Plain http is accepted for this machine alone —
 * `localhost` / `127.0.0.1` — for local development and for the hosted remote
 * MCP, which calls its own app over `http://127.0.0.1:<PORT>`. Trailing slashes
 * are removed. A URL that carries userinfo (`user:secret@`) or that WHATWG
 * cannot parse is refused too (#976): fetch rejects a URL with credentials
 * with an error that quotes the URL whole, and that text would reach the
 * MCP CLI's stderr and, through an outcome-unknown error, the chat model.
 *
 * Both places in this package that send the key — the JSON request seam and
 * the product-image fetch in `client.ts` — build their URL from the base URL
 * normalized here; the MCP server's stdio CLI and remote handler reach the
 * network only through this client.
 *
 * The same rule as the seller SDK's `normalizeBaseUrl`
 * (`packages/seller-sdk/src/base-url.ts`). It is duplicated rather than shared
 * because this package depends on neither the seller SDK nor the protocol
 * package, and a dependency added only for one regex is a worse trade than
 * two small copies each pinned by its own test.
 */
export function normalizeAgentBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const isHttps = /^https:\/\/[^/]/i.test(trimmed);
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
  if (!isHttps && !isLocalHttp) {
    throw new Error(
      `GenesisPayAgent base URL must be https; plain http is allowed only for localhost or 127.0.0.1 (got ${describeRefusedUrl(trimmed)}).`,
    );
  }
  const flaw = structuralFlaw(trimmed);
  if (flaw === "userinfo") {
    throw new Error(
      `GenesisPayAgent base URL must not contain a username or password (got ${describeRefusedUrl(trimmed)}).`,
    );
  }
  if (flaw === "unparseable") {
    throw new Error(`GenesisPayAgent base URL is not a valid URL (got ${describeRefusedUrl(trimmed)}).`);
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
 * and on the MCP CLI's stderr. A value that is not shaped like a URL (no `://`),
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
 * Same as the seller SDK's copy.
 */
function redactUrlForMessage(url: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? "";
  const shown = url.includes("@") ? `${scheme}//***` : url.replace(/[?#][\s\S]*$/, "?…");
  return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
}
