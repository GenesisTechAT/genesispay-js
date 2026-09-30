import { expect, it, vi } from "vitest";
import { GenesisPayAgent } from "./client.js";
import { externalServiceSchema } from "./external-service.js";
const service = {
  id: "ext_test_service", origin: "external_x402", provider: "Independent test provider",
  title: "Test service", description: "Synthetic fixture", resourceUrl: "https://provider.test/search", method: "POST",
  sources: ["https://provider.test/docs"], checkedAt: "2026-09-27T12:00:00Z",
  priceHint: { asset: "USDC", amountMinor: "7000", network: "eip155:8453" },
  evidence: { kind: "unsigned_402", maxTimeoutSeconds: 300, purchaseTested: false },
  contract: { schemaVersion: 1, revision: "test-1", method: "POST", resourceUrl: "https://provider.test/search",
    input: { contentType: "application/json", bodySchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    output: { contentType: "application/json", delivery: "inline_json", description: "Unverified JSON output" },
    constraints: [], examples: [{ label: "Synthetic", synthetic: true, body: { query: "coffee" } }],
    provenance: { source: "curated", checkedAt: "2026-09-27T12:00:00Z" } },
};
it("preserves external evidence and binds detail identity over read-only SDK requests", async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ services: [service] }))
    .mockResolvedValueOnce(Response.json(service)).mockResolvedValueOnce(Response.json({ ...service, id: "ext_foreign_service" }));
  const agent = new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesis.test", fetchFn });
  expect(await agent.discoverExternalServices({ q: "coffee & research", limit: 2 })).toEqual([service]);
  expect(await agent.describeExternalService(service.id)).toEqual(service);
  await expect(agent.describeExternalService(service.id)).rejects.toMatchObject({ code: "invalid_response" });
  expect(fetchFn.mock.calls[0][0]).toBe("https://genesis.test/api/v1/discovery/external-services?q=coffee+%26+research&limit=2");
  expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});
it("rejects malformed requests locally and inconsistent or oversized remote contracts", async () => {
  const fetchFn = vi.fn<typeof fetch>();
  const agent = new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesis.test", fetchFn });
  await expect(agent.describeExternalService("prod_abcdefgh")).rejects.toMatchObject({ code: "invalid_request" });
  await expect(agent.discoverExternalServices({ limit: 21 })).rejects.toMatchObject({ code: "invalid_request" });
  expect(fetchFn).not.toHaveBeenCalled();
  expect(externalServiceSchema.safeParse({ ...service, resourceUrl: "https://foreign.test/search" }).success).toBe(false);
  expect(externalServiceSchema.safeParse({ ...service, contract: { ...service.contract, examples: [{ label: "Synthetic", synthetic: true, body: { text: "x".repeat(17000) } }] } }).success).toBe(false);
  expect(externalServiceSchema.safeParse({ ...service, shop: { verified: true } }).success).toBe(false);
});
