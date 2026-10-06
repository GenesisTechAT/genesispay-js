import { describe, expect, it, vi } from "vitest";
import { serviceContractSchema } from "./service-contract.js";
import { discoveredServiceSchema } from "./schemas.js";
import { GenesisPayAgent } from "./client.js";

const contract = {
  schemaVersion: 1, revision: "test-1", method: "POST",
  resourceUrl: "https://forecast.example/run",
  input: { contentType: "application/json", bodySchema: {
    type: "object", required: ["series"], properties: { series: { type: "array", items: { type: "number" } } },
  } },
  output: { contentType: "application/json", delivery: "inline_json", description: "Predicted values." },
  constraints: ["Use actual user observations."],
  examples: [{ label: "Synthetic input", synthetic: true, body: { series: [1, 2, 3] } }],
  provenance: { source: "curated", checkedAt: "2026-09-27T00:00:00Z" },
};
const listing = {
  id: "prod_abcdefgh", title: "Forecast", description: null, kind: "product", category: null,
  priceUsdc: "0.05", asset: "USDC", method: "POST", resourceUrl: contract.resourceUrl,
  serviceContract: { schemaVersion: 1, revision: contract.revision },
};

describe("bounded advisory service contracts", () => {
  it("accepts a data-only contract, while old and future search responses remain readable", () => {
    expect(serviceContractSchema.parse(contract)).toEqual(contract);
    expect(discoveredServiceSchema.parse({ ...listing, serviceContract: undefined }).title).toBe("Forecast");
    expect(discoveredServiceSchema.parse({ ...listing, serviceContract: { schemaVersion: 2 } }).serviceContract).toBeUndefined();
  });

  it.each([
    { ...contract, schemaVersion: 2 },
    { ...contract, resourceUrl: "https://user:secret@forecast.example/run" },
    { ...contract, method: "GET" },
    { ...contract, input: { ...contract.input, bodySchema: { type: "object", $ref: "https://remote.example/schema" } } },
    { ...contract, examples: [{ label: "Large", synthetic: true, body: { value: "€".repeat(6000) } }] },
    { ...contract, constraints: ["x".repeat(1001)] },
  ])("rejects unsupported or unsafe contract data (%#)", (input) => {
    expect(serviceContractSchema.safeParse(input).success).toBe(false);
  });

  it("refuses excessive schema depth without following references or executing anything", () => {
    let node: unknown = { type: "number" };
    for (let depth = 0; depth < 8; depth++) node = { type: "array", items: node };
    expect(serviceContractSchema.safeParse({ ...contract, input: { ...contract.input, bodySchema: node } }).success).toBe(false);
  });
});

describe("describeService", () => {
  function agentFor(body: unknown, status = 200) {
    const fetchFn = vi.fn(async () => Response.json(body, { status }));
    return { fetchFn, agent: new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: "https://genesispay.example", fetchFn }) };
  }

  it("reads once from GenesisPay and never calls the paid resource", async () => {
    const { agent, fetchFn } = agentFor({ listing, contract });
    expect(await agent.describeService(listing.id)).toMatchObject({ listing, contract });
    expect(fetchFn.mock.calls).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledWith("https://genesispay.example/api/v1/discovery/services/prod_abcdefgh", expect.objectContaining({ method: "GET" }));
  });

  it.each([
    { listing: { ...listing, id: "prod_otherone" }, contract },
    { listing: { ...listing, method: "GET" }, contract },
    { listing: { ...listing, resourceUrl: "https://other.example/run" }, contract },
    { listing, contract: { ...contract, schemaVersion: 2 } },
    { listing, contract: { ...contract, revision: "stale" } },
  ])("rejects mismatched or unsupported detail responses (%#)", async (body) => {
    await expect(agentFor(body).agent.describeService(listing.id)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("propagates unavailable descriptions and refuses invalid ids without network I/O", async () => {
    await expect(agentFor({ error: "Unavailable", code: "not_found" }, 404).agent.describeService(listing.id))
      .rejects.toMatchObject({ status: 404, code: "not_found" });
    const { agent, fetchFn } = agentFor({ listing, contract });
    await expect(agent.describeService("../../agent/pay")).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
