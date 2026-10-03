import { describe, expect, it, vi } from "vitest";
import { GenesisPay } from "./client.js";
import { GENESISPAY_API_VERSION } from "./fulfillment.js";
import { GenesisPayConfigError, GenesisPayEvidenceError, GenesisPayValidationError, GenesisPayVersionError } from "./errors.js";

const candidate = { attemptId: "00000000-0000-4000-8000-000000000001", linkId: "inv_1", linkType: "single", clientReferenceId: "pint_1", confirmedAt: "2026-08-28T12:00:00.000123Z", authorityVersion: GENESISPAY_API_VERSION };
const body = { object: "fulfillment_attempt_list", data: [candidate], nextCursor: null, requestId: "req_list_1", apiVersion: GENESISPAY_API_VERSION };
function response(value: unknown = body, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { headers: { "GENESISPAY-Version": GENESISPAY_API_VERSION, "GENESISPAY-Request-Id": "req_list_1", ...headers } });
}
function client(fetchFn: typeof fetch) {
  return new GenesisPay({ apiKey: `gp_sk_test_${"a".repeat(32)}`, fetchFn });
}

describe("fulfillment.listAttempts", () => {
  it("retrieves scoped candidates without making a verified payment claim", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await client(fetchFn).fulfillment.listAttempts({ clientReferenceId: "pint_1", limit: 5 });
    expect(result.data).toEqual([candidate]);
    expect(result).not.toHaveProperty("verified");
    expect(result.data[0]).not.toHaveProperty("payment");
    const [url, options] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("clientReferenceId=pint_1&limit=5");
    expect(options?.cache).toBe("no-store");
    expect(options?.headers).toMatchObject({ "GENESISPAY-Version": GENESISPAY_API_VERSION });
  });
  it("rejects missing authority metadata and malformed candidate fields without defaults", async () => {
    await expect(client(vi.fn().mockResolvedValue(response(body, { "GENESISPAY-Version": "old" }))).fulfillment.listAttempts()).rejects.toBeInstanceOf(GenesisPayVersionError);
    for (const field of ["attemptId", "linkId", "linkType", "confirmedAt", "authorityVersion", "clientReferenceId"]) {
      const row = { ...candidate, [field]: undefined };
      await expect(client(vi.fn().mockResolvedValue(response({ ...body, data: [row] }))).fulfillment.listAttempts()).rejects.toBeInstanceOf(GenesisPayEvidenceError);
    }
  });
  it("accepts explicit historical provenance and additive fields", async () => {
    const historical = { ...candidate, authorityVersion: null, future: "ignored" };
    const result = await client(vi.fn().mockResolvedValue(response({ ...body, data: [historical], future: true }))).fulfillment.listAttempts();
    expect(result.data[0].authorityVersion).toBeNull();
  });
  it("bounds request size before any network call", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      await expect(client(fetchFn).fulfillment.listAttempts({ limit })).rejects.toBeInstanceOf(GenesisPayValidationError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("keeps an interrupted response body retriable as a transport failure", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("connection reset after headers")); },
    });
    const interrupted = new Response(stream, { headers: {
      "GENESISPAY-Version": GENESISPAY_API_VERSION,
      "GENESISPAY-Request-Id": "req_list_1",
    } });
    await expect(client(vi.fn().mockResolvedValue(interrupted)).fulfillment.listAttempts())
      .rejects.toBeInstanceOf(GenesisPayConfigError);
  });

});
