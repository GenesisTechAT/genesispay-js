// Version negotiation for the strict, versioned seller surface.
//
// Sending `GENESISPAY-Version` is a REQUEST. It is not negotiation: a backend
// that predates the strict surface — or one that was rolled back — ignores the
// header, answers in its tolerant 0.x dialect, and looks successful. Everything
// that follows from such a response (a payable link, a 402 challenge) is money
// this SDK can never establish strict evidence for, so every strict path checks
// the RESPONSE before it acts on it.
//
// The check is deliberately symmetric: both the header and the JSON body carry
// the version and the request ID, and they must agree. An intermediary that
// strips one of them leaves a response this SDK cannot vouch for, and a
// response it cannot vouch for is never treated as strict.

import {
  GenesisPayEvidenceError,
  GenesisPayVersionError,
  type GenesisPayResponseMetadata,
} from "./errors.js";
import {
  GENESISPAY_API_VERSION,
  GENESISPAY_REQUEST_ID_HEADER,
  GENESISPAY_VERSION_HEADER,
  type ApiVersion,
} from "./fulfillment.js";
import { asRecord } from "./resource.js";

export type StrictResponseMetadata = {
  requestId: string;
  apiVersion: ApiVersion;
};

type RawMetadata = {
  headerRequestId: string | null;
  headerVersion: string | null;
  bodyRequestId: string | null;
  bodyVersion: string | null;
};

function readRawMetadata(response: Response, body: unknown): RawMetadata {
  const root = asRecord(body);
  return {
    headerRequestId: response.headers.get(GENESISPAY_REQUEST_ID_HEADER),
    headerVersion: response.headers.get(GENESISPAY_VERSION_HEADER),
    bodyRequestId: typeof root?.requestId === "string" ? root.requestId : null,
    bodyVersion: typeof root?.apiVersion === "string" ? root.apiVersion : null,
  };
}

/** Best-effort metadata for an error's context — never throws. */
export function strictResponseContext(
  response: Response,
  body: unknown,
): GenesisPayResponseMetadata {
  const raw = readRawMetadata(response, body);
  return {
    requestId: raw.headerRequestId ?? raw.bodyRequestId,
    apiVersion: raw.headerVersion ?? raw.bodyVersion,
  };
}

/**
 * True when the response is provably an answer from a backend speaking THIS
 * strict API version. Non-throwing, for the paths that must degrade to a
 * compatibility failure rather than raise.
 */
export function isStrictVersionedResponse(
  response: Response,
  body: unknown,
): boolean {
  const raw = readRawMetadata(response, body);
  return (
    raw.headerVersion === GENESISPAY_API_VERSION &&
    raw.bodyVersion === GENESISPAY_API_VERSION &&
    raw.headerRequestId !== null &&
    raw.headerRequestId.length > 0 &&
    raw.headerRequestId === raw.bodyRequestId
  );
}

/**
 * The throwing form: the response must carry this API version and one agreed
 * request ID, or it is not a strict response and the caller must not act on it.
 * `subject` names the surface in the error message ("product", "checkout link").
 */
export function requireStrictResponseMetadata(
  response: Response,
  body: unknown,
  subject: string,
): StrictResponseMetadata {
  const raw = readRawMetadata(response, body);
  const metadata = strictResponseContext(response, body);

  if (
    raw.headerVersion !== GENESISPAY_API_VERSION ||
    raw.bodyVersion !== GENESISPAY_API_VERSION
  ) {
    throw new GenesisPayVersionError(
      "unsupported_api_version",
      `Unsupported GenesisPay API version "${raw.headerVersion ?? raw.bodyVersion ?? "missing"}" ` +
        `on the ${subject} response. This GenesisPay backend does not speak ${GENESISPAY_API_VERSION}.`,
      metadata,
    );
  }
  if (!raw.headerRequestId || !raw.bodyRequestId) {
    throw new GenesisPayEvidenceError(
      "malformed_evidence",
      `Versioned ${subject} response omitted requestId metadata.`,
      metadata,
    );
  }
  if (raw.headerRequestId !== raw.bodyRequestId) {
    throw new GenesisPayEvidenceError(
      "inconsistent_evidence",
      `The ${subject} response headers and body carry different request IDs.`,
      metadata,
    );
  }

  return { requestId: raw.headerRequestId, apiVersion: GENESISPAY_API_VERSION };
}
