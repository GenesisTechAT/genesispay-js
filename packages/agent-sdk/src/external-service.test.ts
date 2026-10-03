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

const activeFee = { active: true, bps: 100, minMinor: "5000", feeMinor: "5000", totalMinor: "12000" } as const;

it("MR-1013: include buyerFee sends the opt-in parameter on search and detail", async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ services: [{ ...service, buyerFee: activeFee }] }))
    .mockResolvedValueOnce(Response.json({ ...service, buyerFee: activeFee }));
  const agent = new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesis.test", fetchFn });

  expect(await agent.discoverExternalServices({ q: "search", include: ["buyerFee"] })).toEqual([{ ...service, buyerFee: activeFee }]);
  expect(await agent.describeExternalService(service.id, { include: ["buyerFee"] })).toEqual({ ...service, buyerFee: activeFee });

  expect(new URL(String(fetchFn.mock.calls[0][0])).searchParams.get("include")).toBe("buyerFee");
  expect(new URL(String(fetchFn.mock.calls[1][0])).searchParams.get("include")).toBe("buyerFee");
});

it("MR-1013: without include no parameter is sent and a response without the hint parses", async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ services: [service] }))
    .mockResolvedValueOnce(Response.json(service));
  const agent = new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesis.test", fetchFn });

  expect((await agent.discoverExternalServices({ q: "search" }))[0]).not.toHaveProperty("buyerFee");
  expect(await agent.describeExternalService(service.id)).not.toHaveProperty("buyerFee");
  expect(fetchFn.mock.calls.every(([url]) => !new URL(String(url)).searchParams.has("include"))).toBe(true);
});

it("MR-1013: parses the inactive hint and refuses one whose total is not price + fee", () => {
  const inactive = { active: false, bps: null, minMinor: null, feeMinor: "0", totalMinor: "7000" };
  expect(externalServiceSchema.safeParse({ ...service, buyerFee: inactive }).success).toBe(true);
  expect(externalServiceSchema.safeParse({ ...service, buyerFee: { ...activeFee, totalMinor: "7000" } }).success).toBe(false);
  expect(externalServiceSchema.safeParse({ ...service, buyerFee: { ...inactive, totalMinor: "1" } }).success).toBe(false);
  expect(externalServiceSchema.safeParse({ ...service, buyerFee: { ...inactive, feeMinor: "5" } }).success).toBe(false);
  expect(externalServiceSchema.safeParse({ ...service, buyerFee: { ...activeFee, currency: "USD" } }).success).toBe(false);
});

it("MR-1013: refuses an unknown include before any request", async () => {
  const fetchFn = vi.fn<typeof fetch>();
  const agent = new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesis.test", fetchFn });
  // @ts-expect-error only "buyerFee" exists
  await expect(agent.discoverExternalServices({ include: ["reviews"] })).rejects.toMatchObject({ code: "invalid_request" });
  // @ts-expect-error only "buyerFee" exists
  await expect(agent.describeExternalService(service.id, { include: ["reviews"] })).rejects.toMatchObject({ code: "invalid_request" });
  expect(fetchFn).not.toHaveBeenCalled();
});
