// Typed errors for every GenesisPay HTTP call.
//
// One rule, one place: `throwForErrorResponse` is the single mapper from a
// non-OK `Response` to an error class, so every method (checkout today, plans
// and mandates tomorrow) fails the same way. A method that hand-rolls its own
// `throw new GenesisPayConfigError(...)` for a non-OK status is a bug — 422 and
// 429 carry information (which field is wrong, how long to wait) that a generic
// config error throws away.

/** Correlation metadata carried by versioned GenesisPay API responses. */
export type GenesisPayResponseMetadata = {
  requestId?: string | null;
  apiVersion?: string | null;
};

function responseMetadata(metadata: GenesisPayResponseMetadata = {}): {
  requestId: string | null;
  apiVersion: string | null;
} {
  return {
    requestId: metadata.requestId ?? null,
    apiVersion: metadata.apiVersion ?? null,
  };
}

/** Missing/invalid key, unresolvable prod URL, or unreachable backend. */
export class GenesisPayConfigError extends Error {
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(message: string, metadata: GenesisPayResponseMetadata = {}) {
    super(message);
    this.name = "GenesisPayConfigError";
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

export type GenesisPayMandateChargeLocator = {
  id: string;
  status: "pending" | "submitted" | "settled" | "failed";
  amountMinor: string;
  txHash: string | null;
};

/**
 * A mandate pull has durable broadcast authority but no definitive receipt yet.
 * Reuse the original Idempotency-Key; never create a replacement charge.
 */
export class GenesisPayMandateChargePendingError extends Error {
  readonly status = 503 as const;
  readonly code = "charge_submitted_awaiting_confirmation" as const;
  readonly charge: GenesisPayMandateChargeLocator;
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(
    message: string,
    charge: GenesisPayMandateChargeLocator,
    metadata: GenesisPayResponseMetadata = {},
  ) {
    super(message);
    this.name = "GenesisPayMandateChargePendingError";
    this.charge = charge;
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

/**
 * The requested resource does not exist (HTTP 404). Kept separate from
 * `GenesisPayConfigError` on purpose: polling `checkout.retrieve()` for an unknown
 * publicId is an ordinary application case and must stay distinguishable from
 * "the key is broken / the backend is unreachable".
 */
export class GenesisPayNotFoundError extends Error {
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(message: string, metadata: GenesisPayResponseMetadata = {}) {
    super(message);
    this.name = "GenesisPayNotFoundError";
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

/** Asset-integrity, mode↔network, or expectedPayTo-pin mismatch — a money-safety stop. */
export class GenesisPayNetworkSafetyError extends Error {
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(message: string, metadata: GenesisPayResponseMetadata = {}) {
    super(message);
    this.name = "GenesisPayNetworkSafetyError";
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

/** One rejected field, as the API reports it. `path` is dot-joined ("metadata.orderId"). */
export type GenesisPayValidationIssue = {
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
export class GenesisPayValidationError extends Error {
  readonly issues: GenesisPayValidationIssue[];
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(
    message: string,
    issues: GenesisPayValidationIssue[] = [],
    metadata: GenesisPayResponseMetadata = {},
  ) {
    super(message);
    this.name = "GenesisPayValidationError";
    this.issues = issues;
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
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
export class GenesisPayRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(
    message: string,
    retryAfterSeconds: number | null,
    metadata: GenesisPayResponseMetadata = {},
  ) {
    super(message);
    this.name = "GenesisPayRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

/** Expected immutable contract and server evidence disagreed. Never fulfil. */
export class GenesisPayContractMismatchError extends Error {
  readonly code = "contract_mismatch" as const;
  readonly requestId: string | null;
  readonly apiVersion: string | null;
  readonly mismatches: readonly string[];

  constructor(
    message: string,
    mismatches: readonly string[],
    metadata: GenesisPayResponseMetadata = {},
  ) {
    super(message);
    this.name = "GenesisPayContractMismatchError";
    this.mismatches = [...mismatches];
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

/** More than one authority locator was supplied or resolved to one request. */
export class GenesisPayAmbiguousLocatorError extends Error {
  readonly code = "ambiguous_locator" as const;
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(message: string, metadata: GenesisPayResponseMetadata = {}) {
    super(message);
    this.name = "GenesisPayAmbiguousLocatorError";
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

export type GenesisPayEvidenceErrorCode =
  | "malformed_evidence"
  | "inconsistent_evidence"
  | "historical_evidence_unavailable"
  | "unsupported_payment_channel";

/** Missing, malformed, contradictory, or historically unavailable authority evidence. */
export class GenesisPayEvidenceError extends Error {
  readonly code: GenesisPayEvidenceErrorCode;
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(
    code: GenesisPayEvidenceErrorCode,
    message: string,
    metadata: GenesisPayResponseMetadata = {},
  ) {
    super(message);
    this.name = "GenesisPayEvidenceError";
    this.code = code;
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

export type GenesisPayVersionErrorCode =
  | "unsupported_api_version"
  | "unsupported_evidence_version";

/** The server or evidence uses a protocol version this SDK cannot safely interpret. */
export class GenesisPayVersionError extends Error {
  readonly code: GenesisPayVersionErrorCode;
  readonly requestId: string | null;
  readonly apiVersion: string | null;

  constructor(
    code: GenesisPayVersionErrorCode,
    message: string,
    metadata: GenesisPayResponseMetadata = {},
  ) {
    super(message);
    this.name = "GenesisPayVersionError";
    this.code = code;
    ({ requestId: this.requestId, apiVersion: this.apiVersion } = responseMetadata(metadata));
  }
}

export type ThrowForErrorResponseOptions = {
  /** Operation label used in messages, e.g. `POST /api/v1/links`. */
  operation: string;
  /** Replaces the generic 404 message with a case-specific hint. */
  notFoundMessage?: string;
  /** Appended to the message — a next step for the caller, not error detail. */
  hint?: string;
  /** Best-effort correlation metadata from a versioned response. */
  metadata?: GenesisPayResponseMetadata;
};

type ParsedErrorBody = {
  /** Raw body text, trimmed; "" when the body could not be read. */
  text: string;
  /** `error`/`message` string from a JSON body, if present. */
  message: string | null;
  issues: GenesisPayValidationIssue[];
  record: Record<string, unknown> | null;
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

  const pendingMandateCharge = parsePendingMandateCharge(
    response.status,
    body.record,
  );
  if (pendingMandateCharge) {
    throw new GenesisPayMandateChargePendingError(
      detail || "The mandate charge is awaiting confirmation.",
      pendingMandateCharge,
      options.metadata,
    );
  }

  if (response.status === 404) {
    throw new GenesisPayNotFoundError(
      options.notFoundMessage ??
        `GenesisPay ${options.operation} returned 404 (not found)${suffix}${hint}`,
      options.metadata,
    );
  }

  // 422 is a rejected *body*; 400 with `issues[]` is a rejected *query string*
  // (`GET /api/v1/mandates` answers that way). Both mean "your input was wrong,
  // here are the fields", so both become GenesisPayValidationError — a caller that
  // wants to show the offending parameter must not have to branch on status.
  //
  // The `issues.length` gate is what keeps this narrow: a 400 without structured
  // detail ("Request body must be JSON.", "startingAfter is not a mandate of this
  // account.") stays a GenesisPayConfigError exactly as before, so nothing that was
  // a config error yesterday changes class today.
  if (response.status === 422 || (response.status === 400 && body.issues.length > 0)) {
    throw new GenesisPayValidationError(
      `GenesisPay ${options.operation} rejected the input (${response.status})${suffix}`,
      body.issues,
      options.metadata,
    );
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers?.get("retry-after") ?? null,
    );
    const wait =
      retryAfterSeconds === null ? "" : ` Retry after ${retryAfterSeconds}s.`;
    throw new GenesisPayRateLimitError(
      `GenesisPay ${options.operation} was rate limited (429)${suffix}${wait}`,
      retryAfterSeconds,
      options.metadata,
    );
  }

  throw new GenesisPayConfigError(
    `GenesisPay ${options.operation} failed: ${response.status}${suffix}${hint}`.trim(),
    options.metadata,
  );
}

async function readErrorBody(response: Response): Promise<ParsedErrorBody> {
  const text = (await response.text().catch(() => "")).trim();
  if (!text) return { text: "", message: null, issues: [], record: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, message: null, issues: [], record: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text, message: null, issues: [], record: null };
  }

  const record = parsed as { error?: unknown; message?: unknown; issues?: unknown };
  const message =
    typeof record.error === "string" && record.error
      ? record.error
      : typeof record.message === "string" && record.message
        ? record.message
        : null;

  return { text, message, issues: toValidationIssues(record.issues), record };
}

function parsePendingMandateCharge(
  status: number,
  record: Record<string, unknown> | null,
): GenesisPayMandateChargeLocator | null {
  if (
    status !== 503 ||
    record?.code !== "charge_submitted_awaiting_confirmation" ||
    !record.charge ||
    typeof record.charge !== "object" ||
    Array.isArray(record.charge)
  ) return null;

  const charge = record.charge as Record<string, unknown>;
  if (
    typeof charge.id !== "string" ||
    !charge.id ||
    !["pending", "submitted", "settled", "failed"].includes(
      typeof charge.status === "string" ? charge.status : "",
    ) ||
    typeof charge.amountMinor !== "string" ||
    !(typeof charge.txHash === "string" || charge.txHash === null)
  ) return null;

  return {
    id: charge.id,
    status: charge.status as GenesisPayMandateChargeLocator["status"],
    amountMinor: charge.amountMinor,
    txHash: charge.txHash,
  };
}

/** Tolerant: anything that is not a `{path, message}` object is dropped, never thrown on. */
function toValidationIssues(value: unknown): GenesisPayValidationIssue[] {
  if (!Array.isArray(value)) return [];

  const issues: GenesisPayValidationIssue[] = [];
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
 * `Retry-After` is either delta-seconds or an HTTP date (RFC 9110). GenesisPay
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
