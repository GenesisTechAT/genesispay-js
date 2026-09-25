import { getAddress, hashTypedData, type Hex, type TypedData } from "viem";
import { buildMandateChargeTypedData, buildMandateTermsTypedData, mandateTermsStructHash,
  type MandateContractTerms } from "@genesis-tech/genesispay-protocol";
import { GENESISPAY_ASSET_DEPLOYMENTS } from "@genesis-tech/genesispay-protocol/asset-deployments";
import type { ContractPerUseCreateResult } from "./contract-mandates.js";
import { GenesisPayConfigError } from "./errors.js";
import { asRecord, type GenesisPayRequest } from "./resource.js";

export type ContractUsageInput = { mandate: ContractPerUseCreateResult; amountMinor: string; idempotencyKey: string;
  resourceUrl?: string; description?: string };
export type ContractUsageCharge = { id: string; mandateId: string; protocol: "contract_mandate_v1";
  status: "pending" | "settled" | "failed"; authorityStatus: "proposed" | "submitted" | "confirmed" | "closed";
  operationId: string; amountMinor: string; feeMinor: string; txHash: Hex | null; resourceUrl: string | null; description: string | null;
  chargeTypedData: ReturnType<typeof buildMandateChargeTypedData> };
const fail = () => new GenesisPayConfigError("GenesisPay returned an inconsistent contract charge approval.");
function text(value: unknown): string { if (typeof value !== "string") throw fail(); return value; }
function uint(value: unknown): bigint { const raw = text(value); if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw fail(); return BigInt(raw); }
function bytes32(value: unknown): Hex { const raw = text(value); if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw fail(); return raw as Hex; }
function uuid(value: unknown): string { const raw = text(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw fail(); return raw; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }

function consent(result: ContractPerUseCreateResult) {
  const { mandate, approval } = result, m = approval.termsTypedData.message;
  if (mandate.kind !== "per_use" || mandate.protocol !== "contract_mandate_v1" ||
      (mandate.chainId !== 8453 && mandate.chainId !== 84532) || (mandate.asset !== "USDC" && mandate.asset !== "EURC") || m.kind !== "1") throw fail();
  const terms: MandateContractTerms = { mandateId: bytes32(m.mandateId), payer: getAddress(text(m.payer)), seller: getAddress(text(m.seller)),
    treasury: getAddress(text(m.treasury)), lifetimeCap: uint(m.lifetimeCap), perChargeCap: uint(m.perChargeCap), feeBps: uint(m.feeBps),
    kind: 1n, amount: uint(m.amount), interval: uint(m.interval), validAfter: uint(m.validAfter), validBefore: uint(m.validBefore),
    expectedOutstanding: uint(m.expectedOutstanding), permitNonce: uint(m.permitNonce), permitDeadline: uint(m.permitDeadline) };
  const deployment = { chainId: mandate.chainId, version: "1" as const, executor: getAddress(result.spender),
    token: GENESISPAY_ASSET_DEPLOYMENTS[mandate.chainId === 8453 ? "live" : "test"][mandate.asset].tokenAddress };
  if (hashTypedData(approval.termsTypedData) !== hashTypedData(buildMandateTermsTypedData(deployment, terms)) ||
      mandateTermsStructHash(deployment, terms).toLowerCase() !== approval.termsHash.toLowerCase() ||
      terms.payer !== getAddress(mandate.payerWallet) || terms.seller !== getAddress(mandate.destinationWallet) ||
      terms.lifetimeCap !== uint(mandate.allowanceMinor) || terms.perChargeCap !== uint(mandate.capPerChargeMinor)) throw fail();
  return { terms, deployment };
}

/** Closed wire parsing compares the server payload with an independently built EIP-712 message. */
function parseCharge(body: unknown, expected: { mandateId: string; amountMinor: string; feeMinor: string; resourceUrl: string | null;
  description: string | null; typed: (identity: Hex, deadline: bigint) => ReturnType<typeof buildMandateChargeTypedData>; id?: string }): ContractUsageCharge {
  try {
    const row = asRecord(asRecord(body)?.charge), rawTyped = asRecord(row?.chargeTypedData), message = asRecord(rawTyped?.message);
    if (!row || !rawTyped || !message || row.protocol !== "contract_mandate_v1" || row.mandateId !== expected.mandateId ||
        row.amountMinor !== expected.amountMinor || row.feeMinor !== expected.feeMinor || row.resourceUrl !== expected.resourceUrl ||
        row.description !== expected.description || expected.id && row.id !== expected.id) throw fail();
    const typed = expected.typed(bytes32(message.chargeId), uint(message.deadline));
    const types = asRecord(rawTyped.types), domain = asRecord(rawTyped.domain);
    if (!types || !domain || rawTyped.primaryType !== "MandateCharge" ||
      hashTypedData({ domain, types: types as TypedData, primaryType: "MandateCharge", message }) !== hashTypedData(typed)) throw fail();
    const status = row.status, authorityStatus = row.authorityStatus;
    if (status !== "pending" && status !== "settled" && status !== "failed" ||
      authorityStatus !== "proposed" && authorityStatus !== "submitted" && authorityStatus !== "confirmed" && authorityStatus !== "closed" ||
      (status === "settled") !== (authorityStatus === "confirmed") || status === "pending" && authorityStatus === "closed") throw fail();
    const txHash = row.txHash === null ? null : bytes32(row.txHash);
    if ((status === "settled") !== (txHash !== null)) throw fail();
    return { id: uuid(row.id), mandateId: uuid(row.mandateId), protocol: "contract_mandate_v1" as const, status, authorityStatus,
      operationId: uuid(row.operationId), amountMinor: expected.amountMinor, feeMinor: expected.feeMinor, txHash,
      resourceUrl: nullableText(row.resourceUrl), description: nullableText(row.description), chargeTypedData: typed };
  } catch { throw fail(); }
}

export async function proposeContractUsage(request: GenesisPayRequest, input: ContractUsageInput): Promise<ContractUsageCharge> {
  const { terms, deployment } = consent(input.mandate), gross = uint(input.amountMinor);
  if (gross === 0n || gross > terms.perChargeCap || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(input.idempotencyKey)) throw fail();
  const mandateId = uuid(input.mandate.mandate.id), path = `/api/v1/mandates/${mandateId}/charges/propose`;
  const body = await request({ method: "POST", path, operation: "POST /api/v1/mandates/:id/charges/propose", action: "propose a contract charge",
    headers: { "Idempotency-Key": input.idempotencyKey }, body: { protocol: "contract_mandate_v1", amountMinor: input.amountMinor,
      resourceUrl: input.resourceUrl, description: input.description } });
  return parseCharge(body, { mandateId, amountMinor: input.amountMinor, feeMinor: (gross*terms.feeBps/10000n).toString(),
    resourceUrl: input.resourceUrl ?? null, description: input.description?.trim() ?? null,
    typed: (chargeId, deadline) => buildMandateChargeTypedData(deployment, terms, { chargeId, gross, deadline }) });
}

async function retainedCharge(request: GenesisPayRequest, proposal: ContractUsageCharge, signature?: Hex) {
  const path = `/api/v1/mandates/${uuid(proposal.mandateId)}/charges/${uuid(proposal.id)}${signature ? "/submit" : ""}`;
  const body = await request({ method: signature ? "POST" : "GET", path, operation: `${signature ? "POST" : "GET"} /api/v1/mandates/:id/charges/:chargeId${signature ? "/submit" : ""}`,
    action: signature ? "submit a signed contract charge" : "retrieve a contract charge",
    ...(signature ? { body: { protocol: "contract_mandate_v1", signature } } : {}) });
  return parseCharge(body, { ...proposal, typed: (identity, deadline) => {
    if (identity.toLowerCase() !== proposal.chargeTypedData.message.chargeId.toLowerCase() || deadline !== proposal.chargeTypedData.message.deadline) throw fail();
    return proposal.chargeTypedData;
  } });
}
export function submitContractUsage(request: GenesisPayRequest, proposal: ContractUsageCharge, signature: Hex) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw fail();
  return retainedCharge(request, proposal, signature);
}
export function getContractUsage(request: GenesisPayRequest, proposal: ContractUsageCharge) { return retainedCharge(request, proposal); }
