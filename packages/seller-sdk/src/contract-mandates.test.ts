import { describe, expect, it, vi } from "vitest";
import { buildMandateChargeTypedData, buildMandatePermitTypedData, buildMandateTermsTypedData, mandateTermsStructHash,
  type ContractDeployment, type MandateContractTerms } from "@genesis-tech/genesispay-protocol";
import { GENESISPAY_ASSET_DEPLOYMENTS } from "@genesis-tech/genesispay-protocol/asset-deployments";
import { createContractSubscription, parseContractPerUseResult, parseContractSubscriptionResult } from "./contract-mandates.js";
import { createMandatesResource } from "./mandates.js";

const asset = GENESISPAY_ASSET_DEPLOYMENTS.test.USDC;
const deployment: ContractDeployment = { chainId: 84532, token: asset.tokenAddress, executor: `0x${"44".repeat(20)}`, version: "1" };
const terms: MandateContractTerms = { mandateId: `0x${"11".repeat(32)}`, payer: `0x${"22".repeat(20)}`, seller: `0x${"33".repeat(20)}`,
  treasury: `0x${"55".repeat(20)}`, lifetimeCap: 20000000n, perChargeCap: 1000000n, feeBps: 100n, kind: 0n,
  amount: 1000000n, interval: 86400n, validAfter: 1800000000n, validBefore: 1893456000n,
  expectedOutstanding: 4000000n, permitNonce: 3n, permitDeadline: 1800000300n };
type Wire<T> = T extends bigint ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
const wire = <T>(value: T): Wire<T> => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)) as Wire<T>;
function response() {
  return { mandate: { id: "mandate-1", protocol: "contract_mandate_v1", kind: "subscription", status: "pending_permit", asset: "USDC",
    chainId: 84532, payerWallet: terms.payer, destinationWallet: terms.seller, treasury: terms.treasury, executor: deployment.executor,
    contractVersion: "1", allowanceMinor: "20000000", capPerChargeMinor: "1000000", amountPerPeriodMinor: "1000000", periodDays: 1,
    spentMinor: "0", remainingMinor: "20000000", feeBps: "100", validBefore: "1893456000", activationStatus: "proposed", revocationStatus: "none" },
  spender: deployment.executor, approval: { protocol: "contract_mandate_v1", termsHash: mandateTermsStructHash(deployment, terms),
    expiresAt: new Date(Number(terms.permitDeadline*1000n)).toISOString(), termsTypedData: wire(buildMandateTermsTypedData(deployment, terms)),
    permitTypedData: wire(buildMandatePermitTypedData(deployment, terms, asset.eip712)) } };
}
const input = { payerWallet: terms.payer, allowance: "20", capPerCharge: "1", amountPerPeriod: "1", periodDays: 1, validUntil: "2030-01-01T00:00:00.000Z" };

describe("explicit SDK contract mandate protocol", () => {
  it("MR-408: per-use consent has no recurring amount and cannot be substituted for a subscription", async () => {
    const usage: MandateContractTerms = {...terms,kind:1n,amount:0n,interval:0n};
    const body = {...response(),mandate:{...response().mandate,kind:"per_use",amountPerPeriodMinor:null,periodDays:null},
      approval:{...response().approval,termsHash:mandateTermsStructHash(deployment,usage),
        termsTypedData:wire(buildMandateTermsTypedData(deployment,usage)),permitTypedData:wire(buildMandatePermitTypedData(deployment,usage,asset.eip712))}};
    const request=vi.fn().mockResolvedValue(body);
    const result=await createMandatesResource(request).createContractPerUse({payerWallet:input.payerWallet,allowance:input.allowance,
      capPerCharge:input.capPerCharge,validUntil:input.validUntil});
    expect(result.mandate.kind).toBe("per_use");
    expect(result.approval.termsTypedData.message).toMatchObject({kind:"1",amount:"0",interval:"0"});
    expect(()=>parseContractSubscriptionResult(body)).toThrow();
    expect(()=>parseContractPerUseResult(response())).toThrow();
    expect(()=>parseContractPerUseResult({...body,mandate:{...body.mandate,periodDays:1}})).toThrow();
    body.approval.termsTypedData.message.amount="1";
    expect(()=>parseContractPerUseResult(body)).toThrow();
  });
  it("MR-408: usage SDK checks the approved mandate and exact request before returning a charge signature payload", async () => {
    const usage: MandateContractTerms = { ...terms, kind: 1n, amount: 0n, interval: 0n };
    const mandateId = "11111111-1111-4111-8111-111111111111", chargeId = "22222222-2222-4222-8222-222222222222";
    const body = { ...response(), mandate: { ...response().mandate, id: mandateId, kind: "per_use", amountPerPeriodMinor: null, periodDays: null },
      approval: { ...response().approval, termsHash: mandateTermsStructHash(deployment, usage),
        termsTypedData: wire(buildMandateTermsTypedData(deployment, usage)), permitTypedData: wire(buildMandatePermitTypedData(deployment, usage, asset.eip712)) } };
    const mandate = parseContractPerUseResult(body);
    const typed = buildMandateChargeTypedData(deployment, usage, { chargeId: `0x${"66".repeat(32)}`, gross: 100000n, deadline: 1800000300n });
    const charge = { id: chargeId, mandateId, protocol: "contract_mandate_v1", status: "pending", authorityStatus: "proposed",
      operationId: "33333333-3333-4333-8333-333333333333", amountMinor: "100000", feeMinor: "1000", txHash: null,
      resourceUrl: "https://example.com/resource", description: "A request", chargeTypedData: wire(typed) };
    const request = vi.fn().mockResolvedValue({ charge });
    const sdk = createMandatesResource(request);
    const input = { mandate, amountMinor: "100000", idempotencyKey: "sdk-usage-proposal", resourceUrl: charge.resourceUrl, description: " A request " };
    const proposed = await sdk.proposeContractUsage(input);
    expect(proposed.chargeTypedData).toEqual(typed);
    expect(request.mock.calls[0]![0]).toMatchObject({ headers: { "Idempotency-Key": input.idempotencyKey },
      body: { protocol: "contract_mandate_v1", amountMinor: "100000" } });
    for (const changed of [ { ...charge, amountMinor: "99999" }, { ...charge, feeMinor: "0" },
      { ...charge, mandateId: chargeId }, { ...charge, resourceUrl: "https://example.com/other" },
      { ...charge, chargeTypedData: { ...charge.chargeTypedData, domain: { ...charge.chargeTypedData.domain, chainId: 8453 } } },
      { ...charge, chargeTypedData: { ...charge.chargeTypedData, message: { ...charge.chargeTypedData.message, gross: "99999" } } },
      { ...charge, chargeTypedData: { ...charge.chargeTypedData, message: { ...charge.chargeTypedData.message, mandateId: `0x${"77".repeat(32)}` } } },
    ]) {
      request.mockResolvedValue({ charge: changed });
      await expect(sdk.proposeContractUsage(input)).rejects.toThrow("inconsistent contract charge");
    }
    request.mockResolvedValue({ charge: { ...charge, authorityStatus: "submitted" } });
    expect((await sdk.submitContractUsage(proposed, `0x${"88".repeat(65)}`)).authorityStatus).toBe("submitted");
    expect(request.mock.lastCall![0].body).toEqual({ protocol: "contract_mandate_v1", signature: `0x${"88".repeat(65)}` });
    request.mockResolvedValue({ charge: { ...charge, chargeTypedData: { ...charge.chargeTypedData,
      message: { ...charge.chargeTypedData.message, deadline: "1800000301" } } } });
    await expect(sdk.getContractUsage(proposed)).rejects.toThrow("inconsistent contract charge");
    request.mockResolvedValue({ charge: { ...charge, status: "settled", authorityStatus: "confirmed", txHash: `0x${"99".repeat(32)}` } });
    expect((await sdk.getContractUsage(proposed)).status).toBe("settled");
  });
  it("MR-408: preserves both independently checked payloads and aggregated bounded permit", async () => {
    const body = response(); const request = vi.fn().mockResolvedValue(body);
    const result = await createMandatesResource(request).createContractSubscription(input);
    expect(request.mock.calls[0]![0].body).toMatchObject({ protocol: "contract_mandate_v1", kind: "subscription", validUntil: input.validUntil });
    expect(result.approval.termsTypedData).toEqual(body.approval.termsTypedData);
    expect(result.approval.permitTypedData).toEqual(body.approval.permitTypedData);
    expect(result.approval.permitTypedData.message.value).toBe("24000000");
  });
  it.each(["seller", "treasury", "amount", "feeBps", "permitNonce", "validBefore"] as const)("MR-408: rejects tampered signed %s", (field) => {
    const body = response();
    if (field === "seller" || field === "treasury") body.approval.termsTypedData.message[field] = `0x${"99".repeat(20)}`;
    else body.approval.termsTypedData.message[field] = "999";
    expect(() => parseContractSubscriptionResult(body)).toThrow("inconsistent contract mandate");
  });
  it.each(["chainId", "verifyingContract", "name"])("MR-103: rejects a changed permit domain %s", (field) => {
    const body = response();
    if (field === "chainId") body.approval.permitTypedData.domain.chainId = 8453;
    else if (field === "name") body.approval.permitTypedData.domain.name = "Wrong token";
    else body.approval.permitTypedData.domain.verifyingContract = terms.seller;
    expect(() => parseContractSubscriptionResult(body)).toThrow("inconsistent contract mandate");
  });
  it("MR-301: rejects a self-consistent proposal for a different requested payer", async () => {
    await expect(createContractSubscription(vi.fn().mockResolvedValue(response()), { ...input, payerWallet: terms.seller })).rejects.toThrow("inconsistent contract mandate");
  });
  it("MR-408: does not interpret a legacy one-signature result as contract approval", () => {
    expect(() => parseContractSubscriptionResult({ mandate: { id: "old" }, permitTypedData: {} })).toThrow("inconsistent contract mandate");
  });
});
