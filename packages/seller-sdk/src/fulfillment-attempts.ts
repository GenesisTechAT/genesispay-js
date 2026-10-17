import { GenesisPayConfigError, GenesisPayEvidenceError, GenesisPayValidationError, throwForErrorResponse } from "./errors.js";
import { GENESISPAY_API_VERSION, GENESISPAY_VERSION_HEADER, type ApiVersion } from "./fulfillment.js";
import { asRecord } from "./resource.js";
import { requireStrictResponseMetadata, strictResponseContext } from "./strict-response.js";

export type FulfillmentAttemptsQuery = {
  clientReferenceId?: string;
  confirmedAfter?: string;
  confirmedBefore?: string;
  cursor?: string;
  limit?: number;
};

/** Discovery hint, NOT payment authority. Always call fulfillment.verify. */
export type FulfillmentAttemptCandidate = {
  attemptId: string;
  linkId: string;
  linkType: "single" | "reusable";
  clientReferenceId: string | null;
  confirmedAt: string;
  authorityVersion: string | null;
};

export type FulfillmentAttemptList = {
  data: FulfillmentAttemptCandidate[];
  nextCursor: string | null;
  requestId: string;
  apiVersion: ApiVersion;
};

export function createFulfillmentAttemptsLister(options: {
  baseUrl: string;
  apiKey: string;
  fetchFn: typeof fetch;
}) {
  return async (input: FulfillmentAttemptsQuery = {}): Promise<FulfillmentAttemptList> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (key === "limit") {
        if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 100) {
          throw new GenesisPayValidationError("limit must be an integer between 1 and 100.", []);
        }
      } else if (!["clientReferenceId", "confirmedAfter", "confirmedBefore", "cursor"].includes(key) ||
        typeof value !== "string" || !value.trim()) {
        throw new GenesisPayValidationError("Invalid fulfillment attempt filter.", []);
      }
      params.set(key, String(value));
    }
    let response: Response;
    try {
      response = await options.fetchFn(`${options.baseUrl}/api/v1/fulfillment/attempts?${params}`, {
        method: "GET",
        headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json", [GENESISPAY_VERSION_HEADER]: GENESISPAY_API_VERSION },
        cache: "no-store",
      });
    } catch {
      throw new GenesisPayConfigError("Could not reach GenesisPay to discover fulfillment attempts.");
    }
    if (!response.ok) {
      return throwForErrorResponse(response, { operation: "fulfillment attempt listing", metadata: strictResponseContext(response, null) });
    }
    let body: string;
    try { body = await response.text(); } catch {
      throw new GenesisPayConfigError("Could not read GenesisPay fulfillment attempt listing.", strictResponseContext(response, null));
    }
    let raw: unknown;
    try { raw = JSON.parse(body); } catch {
      throw new GenesisPayEvidenceError("malformed_evidence", "Fulfillment attempt listing is not JSON.", strictResponseContext(response, null));
    }
    const metadata = requireStrictResponseMetadata(response, raw, "fulfillment attempt listing");
    const invalid = (): never => { throw new GenesisPayEvidenceError("malformed_evidence", "Invalid fulfillment attempt listing.", metadata); };
    const root = asRecord(raw);
    if (root?.object !== "fulfillment_attempt_list" || !Array.isArray(root.data) ||
      !(root.nextCursor === null || (typeof root.nextCursor === "string" && root.nextCursor.length > 0))) return invalid();
    const data = root.data.map((value): FulfillmentAttemptCandidate => {
      const row = asRecord(value);
      if (!row || typeof row.attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.attemptId) ||
        typeof row.linkId !== "string" || !row.linkId ||
        (row.linkType !== "single" && row.linkType !== "reusable") ||
        !(row.clientReferenceId === null || typeof row.clientReferenceId === "string") ||
        typeof row.confirmedAt !== "string" || !Number.isFinite(Date.parse(row.confirmedAt)) ||
        !(row.authorityVersion === null || typeof row.authorityVersion === "string")) return invalid();
      return { attemptId: row.attemptId, linkId: row.linkId, linkType: row.linkType,
        clientReferenceId: row.clientReferenceId, confirmedAt: row.confirmedAt, authorityVersion: row.authorityVersion };
    });
    return { data, nextCursor: root.nextCursor, ...metadata };
  };
}
