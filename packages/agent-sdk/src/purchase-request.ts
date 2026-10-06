import { GenesisPayPaymentRejectedError } from "./errors.js";
import type { PayOptions, PurchaseContentType } from "./types.js";

/**
 * The purchase request half of a `pay()` call: which HTTP method GenesisPay
 * buys the resource with and, for POST, the exact body bytes.
 *
 * Validation mirrors the server's v2 rules (`docs/05_API_SURFACE.md`, "POST
 * purchases with a body") so a caller learns about a bad body before anything
 * is sent. The server re-checks everything; this is a fast, local refusal, not
 * the authority.
 */

/** Largest purchase body the server accepts, in UTF-8 bytes. */
export const PURCHASE_BODY_MAX_BYTES = 256 * 1024;

const PURCHASE_CONTENT_TYPE: PurchaseContentType = "application/json";

export type PurchaseRequest =
  | { method: "GET" }
  | {
      method: "POST";
      contentType: PurchaseContentType;
      /** The caller's string, untouched — never parsed and re-serialized. */
      body: string;
      /** Lowercase hex SHA-256 of the body's UTF-8 bytes; the server echoes it. */
      bodySha256: string;
    };

/**
 * Validates the method/body/contentType options and hashes a POST body.
 * Throws `GenesisPayPaymentRejectedError` (nothing was sent) on any violation.
 *
 * Reads the options as `unknown`: a JavaScript caller is not held to the
 * TypeScript types, and a wrong-typed body must be refused here rather than
 * stringified by `JSON.stringify` into a different purchase.
 */
export async function preparePurchaseRequest(options: PayOptions): Promise<PurchaseRequest> {
  const method: unknown = options.method;
  const body: unknown = options.body;
  const contentType: unknown = options.contentType;

  if (method !== undefined && method !== "GET" && method !== "POST") {
    throw rejected("request_body_invalid", 'method must be "GET" or "POST".');
  }

  if (method !== "POST") {
    if (body !== undefined) {
      throw rejected("request_body_invalid", 'A body is only sent with method "POST".');
    }
    if (contentType !== undefined) {
      throw rejected("request_body_invalid", 'contentType is only sent with method "POST".');
    }
    return { method: "GET" };
  }

  if (contentType !== undefined && contentType !== PURCHASE_CONTENT_TYPE) {
    throw rejected("unsupported_content_type", `Only ${PURCHASE_CONTENT_TYPE} purchase bodies are supported.`);
  }
  if (typeof body !== "string") {
    throw rejected("request_body_invalid", 'A POST purchase requires its exact JSON body as a string.');
  }
  if (!isWellFormedUnicode(body)) {
    throw rejected("request_body_invalid", "The body must be well-formed Unicode text (no lone surrogates).");
  }

  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > PURCHASE_BODY_MAX_BYTES) {
    throw rejected("request_body_too_large", `The body exceeds ${PURCHASE_BODY_MAX_BYTES} UTF-8 bytes.`);
  }
  if (!isJsonText(body)) {
    throw rejected("request_body_invalid", "The body must be valid JSON text.");
  }

  return {
    method: "POST",
    contentType: PURCHASE_CONTENT_TYPE,
    body,
    bodySha256: await sha256Hex(bytes),
  };
}

/**
 * Why a v2 envelope does not confirm the purchase request this client sent, or
 * null when it does.
 *
 * A server that predates POST purchases drops `method`/`body` without an error
 * and buys the URL with GET, so for a POST the echo is REQUIRED — its absence
 * is not "older server, fine", it is "a different request may have been paid".
 * For a GET an absent echo is the old contract; only a contradicting one counts.
 */
export function purchaseEchoMismatch(
  echo: { requestMethod?: string; bodySha256?: string },
  purchase: PurchaseRequest,
): string | null {
  if (purchase.method === "POST") {
    if (echo.requestMethod !== "POST") {
      return echo.requestMethod === undefined
        ? 'the response does not confirm requestMethod "POST"'
        : `the response confirms requestMethod ${JSON.stringify(echo.requestMethod)}, not "POST"`;
    }
    if (echo.bodySha256 !== purchase.bodySha256) {
      return "the response's bodySha256 does not match the body this client sent";
    }
    return null;
  }

  if (echo.requestMethod !== undefined && echo.requestMethod !== "GET") {
    return `the response confirms requestMethod ${JSON.stringify(echo.requestMethod)} for a GET purchase`;
  }
  if (echo.bodySha256 !== undefined) {
    return "the response carries a bodySha256 for a GET purchase";
  }
  return null;
}

function rejected(code: string, message: string): GenesisPayPaymentRejectedError {
  // status 0: raised client-side, before any request was sent.
  return new GenesisPayPaymentRejectedError(message, { status: 0, code });
}

/** `String.prototype.isWellFormed` without depending on an ES2024 runtime. */
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isJsonText(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * WebCrypto, as the seller SDK does: present on Node >= 20 (this package's
 * `engines` floor), browsers, Deno, Bun and edge runtimes, so no `node:crypto`
 * import is needed. Without it the echo cannot be checked, so the purchase is
 * refused before sending rather than sent unverifiable.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw rejected(
      "webcrypto_unavailable",
      "WebCrypto (globalThis.crypto.subtle) is unavailable in this runtime; a POST purchase needs it to verify the body hash.",
    );
  }
  // Copy into a fresh ArrayBuffer: the DOM typings reject a possibly shared buffer view.
  const digest = await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
