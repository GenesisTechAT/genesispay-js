// Typed errors for every PeerPay HTTP call.
//
// One rule, one place: `throwForErrorResponse` is the single mapper from a
// non-OK `Response` to an error class, so every method (checkout today, plans
// and mandates tomorrow) fails the same way. A method that hand-rolls its own
// `throw new PeerPayConfigError(...)` for a non-OK status is a bug — 422 and
// 429 carry information (which field is wrong, how long to wait) that a generic
// config error throws away.

/** Missing/invalid key, unresolvable prod URL, or unreachable backend. */
export class PeerPayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerPayConfigError";
  }
}

/**
 * The requested resource does not exist (HTTP 404). Kept separate from
 * `PeerPayConfigError` on purpose: polling `checkout.retrieve()` for an unknown
 * publicId is an ordinary application case and must stay distinguishable from
 * "the key is broken / the backend is unreachable".
 */
export class PeerPayNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerPayNotFoundError";
  }
}

/** Asset-integrity, mode↔network, or expectedPayTo-pin mismatch — a money-safety stop. */
export class PeerPayNetworkSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerPayNetworkSafetyError";
  }
}

/** One rejected field, as the API reports it. `path` is dot-joined ("metadata.orderId"). */
export type PeerPayValidationIssue = {
  path: string;
  message: string;
};

/**
 * The request was well-formed but the input was rejected — HTTP 422 for a body,
 * or HTTP 400 with field `issues` for a query string.
 *
 * `issues` is the server's structured list — the whole point of the class: 21
 * metadata keys and a malformed wallet must not look the same to a caller that
 * wants to surface the offending field back to its own user.
 */
export class PeerPayValidationError extends Error {
  readonly issues: PeerPayValidationIssue[];

  constructor(message: string, issues: PeerPayValidationIssue[] = []) {
    super(message);
    this.name = "PeerPayValidationError";
    this.issues = issues;
  }
}

/**
 * The API key exceeded its rate limit (HTTP 429).
 *
 * `retryAfterSeconds` mirrors the server's `Retry-After` header. It is `null`
 * when the header is missing or unparseable — never a guessed default, because
 * a caller sleeping on a made-up number is worse than one that backs off with
 * its own policy.
 */
export class PeerPayRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "PeerPayRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ThrowForErrorResponseOptions = {
  /** Operation label used in messages, e.g. `POST /api/v1/links`. */
  operation: string;
  /** Replaces the generic 404 message with a case-specific hint. */
  notFoundMessage?: string;
  /** Appended to the message — a next step for the caller, not error detail. */
  hint?: string;
};

type ParsedErrorBody = {
  /** Raw body text, trimmed; "" when the body could not be read. */
  text: string;
  /** `error`/`message` string from a JSON body, if present. */
  message: string | null;
  issues: PeerPayValidationIssue[];
};

/**
 * Maps a non-OK response onto the right error class and throws it.
 *
 * Consumes the response body exactly once (as text, then optimistically as
 * JSON) so a non-JSON error page still ends up in the message instead of
 * blowing up the mapper.
 */
export async function throwForErrorResponse(
  response: Response,
  options: ThrowForErrorResponseOptions,
): Promise<never> {
  const body = await readErrorBody(response);
  const detail = body.message ?? body.text;
  const suffix = detail ? `: ${detail}` : "";
  const hint = options.hint ? ` ${options.hint}` : "";

  if (response.status === 404) {
    throw new PeerPayNotFoundError(
      options.notFoundMessage ??
        `PeerPay ${options.operation} returned 404 (not found)${suffix}${hint}`,
    );
  }

  // 422 is a rejected *body*; 400 with `issues[]` is a rejected *query string*
  // (`GET /api/v1/mandates` answers that way). Both mean "your input was wrong,
  // here are the fields", so both become PeerPayValidationError — a caller that
  // wants to show the offending parameter must not have to branch on status.
  //
  // The `issues.length` gate is what keeps this narrow: a 400 without structured
  // detail ("Request body must be JSON.", "startingAfter is not a mandate of this
  // account.") stays a PeerPayConfigError exactly as before, so nothing that was
  // a config error yesterday changes class today.
  if (response.status === 422 || (response.status === 400 && body.issues.length > 0)) {
    throw new PeerPayValidationError(
      `PeerPay ${options.operation} rejected the input (${response.status})${suffix}`,
      body.issues,
    );
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers?.get("retry-after") ?? null,
    );
    const wait =
      retryAfterSeconds === null ? "" : ` Retry after ${retryAfterSeconds}s.`;
    throw new PeerPayRateLimitError(
      `PeerPay ${options.operation} was rate limited (429)${suffix}${wait}`,
      retryAfterSeconds,
    );
  }

  throw new PeerPayConfigError(
    `PeerPay ${options.operation} failed: ${response.status}${suffix}${hint}`.trim(),
  );
}

async function readErrorBody(response: Response): Promise<ParsedErrorBody> {
  const text = (await response.text().catch(() => "")).trim();
  if (!text) return { text: "", message: null, issues: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, message: null, issues: [] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text, message: null, issues: [] };
  }

  const record = parsed as { error?: unknown; message?: unknown; issues?: unknown };
  const message =
    typeof record.error === "string" && record.error
      ? record.error
      : typeof record.message === "string" && record.message
        ? record.message
        : null;

  return { text, message, issues: toValidationIssues(record.issues) };
}

/** Tolerant: anything that is not a `{path, message}` object is dropped, never thrown on. */
function toValidationIssues(value: unknown): PeerPayValidationIssue[] {
  if (!Array.isArray(value)) return [];

  const issues: PeerPayValidationIssue[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const issue = entry as { path?: unknown; message?: unknown };
    if (typeof issue.message !== "string") continue;
    issues.push({
      path: typeof issue.path === "string" ? issue.path : "",
      message: issue.message,
    });
  }
  return issues;
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date (RFC 9110). PeerPay
 * sends seconds; the date form is parsed anyway so a proxy that rewrites the
 * header does not degrade the value to `null`.
 */
function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1_000));
}
