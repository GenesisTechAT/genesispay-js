import { getAddress, hashTypedData, parseUnits, type Address, type Hex, type TypedData } from "viem";
import { buildMandatePermitTypedData, buildMandateTermsTypedData, mandateTermsStructHash,
  type MandateContractTerms } from "@genesis-tech/genesispay-protocol";
import { GENESISPAY_ASSET_DEPLOYMENTS } from "@genesis-tech/genesispay-protocol/asset-deployments";
import { GenesisPayConfigError } from "./errors.js";
import { asRecord, type GenesisPayRequest } from "./resource.js";
import { toMandate, type Mandate, type MandateCreateInput } from "./mandates.js";

export type ContractSubscriptionCreateInput = Omit<MandateCreateInput, "kind" | "amountPerPeriod" | "periodDays"> & {
  amountPerPeriod: string; periodDays: number; validUntil: string;
};
export type ContractPerUseCreateInput = Omit<MandateCreateInput, "kind" | "amountPerPeriod" | "periodDays"> & { validUntil: string };
export type ContractMandateTypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: TypedData; primaryType: "MandateTerms" | "Permit"; message: Record<string, string>;
};
export type ContractSubscriptionCreateResult = {
  mandate: Mandate; spender: string;
  approval: { protocol: "contract_mandate_v1"; termsHash: Hex; expiresAt: string;
    termsTypedData: ContractMandateTypedData; permitTypedData: ContractMandateTypedData };
};
const fail = () => new GenesisPayConfigError("GenesisPay returned an inconsistent contract mandate approval.");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function string(value: unknown): string { if (typeof value !== "string" || !value) throw fail(); return value; }
function uint(value: unknown): bigint { const text = string(value); if (!/^(0|[1-9][0-9]*)$/.test(text)) throw fail(); return BigInt(text); }
function address(value: unknown): Address { return getAddress(string(value)); }
function typed(value: unknown, primaryType: ContractMandateTypedData["primaryType"]): ContractMandateTypedData {
  const raw = asRecord(value), domain = asRecord(raw?.domain), message = asRecord(raw?.message), types = asRecord(raw?.types);
  if (!raw || !domain || !message || !types || raw.primaryType !== primaryType ||
    !Number.isSafeInteger(domain.chainId) || Object.values(message).some((item) => typeof item !== "string") ||
    Object.values(types).some((fields) => !Array.isArray(fields) || fields.some((field: unknown) => {
      const pair = asRecord(field); return !pair || typeof pair.name !== "string" || typeof pair.type !== "string";
    }))) throw fail();
  return { domain: { name: string(domain.name), version: string(domain.version), chainId: domain.chainId as number,
    verifyingContract: address(domain.verifyingContract) }, primaryType, types: types as TypedData, message: message as Record<string, string> };
}

/** Compare independently constructed protocol hashes; never silently repair the server's signing payload. */
function parseContractMandateResult(body: unknown, kind: "subscription" | "per_use"): ContractSubscriptionCreateResult {
  try {
    const raw = asRecord(body), row = asRecord(raw?.mandate), approval = asRecord(raw?.approval);
    if (!row || row.protocol !== "contract_mandate_v1" || row.kind !== kind || !approval || approval.protocol !== "contract_mandate_v1") throw fail();
    const termsTypedData = typed(approval.termsTypedData, "MandateTerms"), permitTypedData = typed(approval.permitTypedData, "Permit");
    const m = termsTypedData.message;
    if (m.kind !== (kind === "subscription" ? "0" : "1") || !/^0x[0-9a-fA-F]{64}$/.test(string(m.mandateId))) throw fail();
    const terms: MandateContractTerms = { mandateId: m.mandateId as Hex, payer: address(m.payer), seller: address(m.seller), treasury: address(m.treasury),
      lifetimeCap: uint(m.lifetimeCap), perChargeCap: uint(m.perChargeCap), feeBps: uint(m.feeBps), kind: kind === "subscription" ? 0n : 1n,
      amount: uint(m.amount), interval: uint(m.interval), validAfter: uint(m.validAfter), validBefore: uint(m.validBefore),
      expectedOutstanding: uint(m.expectedOutstanding), permitNonce: uint(m.permitNonce), permitDeadline: uint(m.permitDeadline) };
    if ((row.chainId !== 8453 && row.chainId !== 84532) || (row.asset !== "USDC" && row.asset !== "EURC")) throw fail();
    const asset = GENESISPAY_ASSET_DEPLOYMENTS[row.chainId === 8453 ? "live" : "test"][row.asset];
    if (row.contractVersion !== "1") throw fail();
    const deployment = { chainId: row.chainId, token: asset.tokenAddress, executor: address(row.executor), version: "1" as const };
    const expectedTerms = buildMandateTermsTypedData(deployment, terms);
    const expectedPermit = buildMandatePermitTypedData(deployment, terms, asset.eip712);
    const termsHash = mandateTermsStructHash(deployment, terms);
    if (hashTypedData(termsTypedData) !== hashTypedData(expectedTerms) || hashTypedData(permitTypedData) !== hashTypedData(expectedPermit) ||
      !same(termsHash, string(approval.termsHash)) || !same(deployment.executor, string(raw?.spender)) ||
      !same(terms.payer, string(row.payerWallet)) || !same(terms.seller, string(row.destinationWallet)) ||
      !same(terms.treasury, string(row.treasury)) || terms.lifetimeCap !== uint(row.allowanceMinor) ||
      terms.perChargeCap !== uint(row.capPerChargeMinor) ||
      terms.feeBps !== uint(row.feeBps) || terms.validBefore !== uint(row.validBefore)) throw fail();
    if (kind === "subscription" ? terms.amount !== uint(row.amountPerPeriodMinor) || !Number.isSafeInteger(row.periodDays) ||
      terms.interval !== BigInt(row.periodDays as number)*86400n : row.amountPerPeriodMinor !== null || row.periodDays !== null) throw fail();
    return { mandate: toMandate(row), spender: deployment.executor, approval: { protocol: "contract_mandate_v1", termsHash,
      expiresAt: string(approval.expiresAt), termsTypedData, permitTypedData } };
  } catch { throw fail(); }
}

export function parseContractSubscriptionResult(body: unknown) { return parseContractMandateResult(body, "subscription"); }
export function parseContractPerUseResult(body: unknown) { return parseContractMandateResult(body, "per_use"); }
export type ContractPerUseCreateResult = ContractSubscriptionCreateResult;

export async function createContractSubscription(request: GenesisPayRequest, input: ContractSubscriptionCreateInput) {
  const body = await request({ method: "POST", path: "/api/v1/mandates", operation: "POST /api/v1/mandates",
    action: "create a contract subscription", body: { ...input, kind: "subscription", protocol: "contract_mandate_v1" } });
  const result = parseContractSubscriptionResult(body);
  const amount = (value: string) => { if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(value)) throw fail(); return parseUnits(value, 6); };
  const terms = result.approval.termsTypedData.message;
  if (!same(result.mandate.payerWallet, input.payerWallet) ||
    input.destinationWallet && !same(result.mandate.destinationWallet, input.destinationWallet) ||
    result.mandate.asset !== (input.asset ?? "USDC") || BigInt(result.mandate.allowanceMinor) !== amount(input.allowance) ||
    BigInt(result.mandate.capPerChargeMinor) !== amount(input.capPerCharge) ||
    BigInt(result.mandate.amountPerPeriodMinor!) !== amount(input.amountPerPeriod) || result.mandate.periodDays !== input.periodDays ||
    Number(BigInt(terms.validBefore!)) !== Math.floor(Date.parse(input.validUntil) / 1000)) throw fail();
  return result;
}

export async function createContractPerUse(request: GenesisPayRequest, input: ContractPerUseCreateInput) {
  const body = await request({ method: "POST", path: "/api/v1/mandates", operation: "POST /api/v1/mandates",
    action: "create a contract per-use mandate", body: { ...input, kind: "per_use", protocol: "contract_mandate_v1" } });
  const result = parseContractPerUseResult(body);
  const amount = (value: string) => { if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(value)) throw fail(); return parseUnits(value, 6); };
  if (!same(result.mandate.payerWallet, input.payerWallet) ||
    input.destinationWallet && !same(result.mandate.destinationWallet, input.destinationWallet) ||
    result.mandate.asset !== (input.asset ?? "USDC") || BigInt(result.mandate.allowanceMinor) !== amount(input.allowance) ||
    BigInt(result.mandate.capPerChargeMinor) !== amount(input.capPerCharge) ||
    Number(BigInt(result.approval.termsTypedData.message.validBefore!)) !== Math.floor(Date.parse(input.validUntil)/1000)) throw fail();
  return result;
}
