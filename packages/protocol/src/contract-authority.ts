import { encodeAbiParameters, getAddress, hashStruct, hashTypedData, keccak256, stringToHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import { buildTransferAuthorizationTypedData, type Eip3009Domain } from "./eip3009.js";
import type { TransferAuthorization } from "./types.js";

export type ContractDeployment = { chainId: number; token: Address; executor: Address; version: "1" };
export type AtomicPaymentTerms = {
  paymentId: Hex; salt: Hex; payer: Address; seller: Address; treasury: Address;
  gross: bigint; sellerAmount: bigint; feeAmount: bigint;
};

export const ATOMIC_PAYMENT_TYPE = "GenesisPayAtomicPayment(uint256 chainId,address token,address executor,uint256 version,bytes32 paymentId,bytes32 salt,address payer,address seller,address treasury,uint256 gross,uint256 sellerAmount,uint256 feeAmount)";
const UINT256_MAX = (1n << 256n) - 1n;

function uint(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > UINT256_MAX) throw new Error("Invalid uint256 authority.");
}
function bytes32(value: Hex): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new Error("Invalid authority identity.");
}
function deployment(value: ContractDeployment): void {
  if (![8453, 84532].includes(value.chainId) || value.version !== "1" ||
      getAddress(value.executor) === zeroAddress || getAddress(value.token) === zeroAddress) {
    throw new Error("Invalid contract deployment.");
  }
}

/** Recompute locally from the displayed terms; never sign a server-supplied nonce blindly. */
export function atomicPaymentCommitment(target: ContractDeployment, terms: AtomicPaymentTerms): Hex {
  deployment(target);
  bytes32(terms.paymentId); bytes32(terms.salt);
  uint(terms.gross); uint(terms.sellerAmount); uint(terms.feeAmount);
  const payer = getAddress(terms.payer);
  const seller = getAddress(terms.seller);
  const treasury = getAddress(terms.treasury);
  const executor = getAddress(target.executor);
  if (terms.sellerAmount === 0n || terms.sellerAmount + terms.feeAmount !== terms.gross ||
      payer === zeroAddress || payer === executor || seller === zeroAddress || seller === executor || seller === payer ||
      (terms.feeAmount > 0n && [zeroAddress, executor, payer].includes(treasury))) {
    throw new Error("Invalid atomic payment terms.");
  }
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" },
    { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" },
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], [keccak256(stringToHex(ATOMIC_PAYMENT_TYPE)), BigInt(target.chainId), getAddress(target.token), executor, 1n,
    terms.paymentId, terms.salt, payer, seller, treasury, terms.gross, terms.sellerAmount, terms.feeAmount]));
}

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;

export function buildAtomicPaymentTypedData(input: {
  deployment: ContractDeployment; terms: AtomicPaymentTerms;
  validAfter: bigint; validBefore: bigint; tokenDomain: Eip3009Domain;
}) {
  uint(input.validAfter); uint(input.validBefore);
  if (input.validBefore <= input.validAfter) throw new Error("Invalid authorization window.");
  const nonce = atomicPaymentCommitment(input.deployment, input.terms);
  const authorization: TransferAuthorization = {
    from: input.terms.payer, to: input.deployment.executor, value: input.terms.gross.toString(),
    validAfter: input.validAfter.toString(), validBefore: input.validBefore.toString(), nonce,
  };
  const direct = buildTransferAuthorizationTypedData({ authorization,
    usdc: { chainId: input.deployment.chainId, address: input.deployment.token }, domain: input.tokenDomain });
  return { ...direct, types: receiveWithAuthorizationTypes, primaryType: "ReceiveWithAuthorization" as const };
}

export const mandateTermsTypes = {
  MandateTerms: [
    { name: "mandateId", type: "bytes32" }, { name: "payer", type: "address" },
    { name: "seller", type: "address" }, { name: "treasury", type: "address" },
    { name: "lifetimeCap", type: "uint256" }, { name: "perChargeCap", type: "uint256" },
    { name: "feeBps", type: "uint256" }, { name: "kind", type: "uint256" },
    { name: "amount", type: "uint256" }, { name: "interval", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
    { name: "expectedOutstanding", type: "uint256" }, { name: "permitNonce", type: "uint256" },
    { name: "permitDeadline", type: "uint256" },
  ],
} as const;
export type MandateContractTerms = {
  mandateId: Hex; payer: Address; seller: Address; treasury: Address;
  lifetimeCap: bigint; perChargeCap: bigint; feeBps: bigint; kind: 0n | 1n;
  amount: bigint; interval: bigint; validAfter: bigint; validBefore: bigint;
  expectedOutstanding: bigint; permitNonce: bigint; permitDeadline: bigint;
};

export function mandateContractDomain(target: ContractDeployment) {
  deployment(target);
  return { name: "GenesisPay MandateExecutor", version: target.version,
    chainId: target.chainId, verifyingContract: getAddress(target.executor) };
}

export function buildMandateTermsTypedData(target: ContractDeployment, terms: MandateContractTerms) {
  deployment(target); bytes32(terms.mandateId);
  for (const value of [terms.lifetimeCap, terms.perChargeCap, terms.feeBps, terms.kind, terms.amount,
    terms.interval, terms.validAfter, terms.validBefore, terms.expectedOutstanding, terms.permitNonce, terms.permitDeadline]) uint(value);
  uint(terms.expectedOutstanding + terms.lifetimeCap);
  if (terms.expectedOutstanding + terms.lifetimeCap === UINT256_MAX) throw new Error("Unlimited permit is forbidden.");
  const payer = getAddress(terms.payer); const seller = getAddress(terms.seller);
  const treasury = getAddress(terms.treasury); const executor = getAddress(target.executor);
  if (payer === zeroAddress || seller === zeroAddress || seller === executor || seller === payer ||
      terms.lifetimeCap === 0n || terms.perChargeCap === 0n || terms.perChargeCap > terms.lifetimeCap ||
      terms.feeBps >= 10_000n || terms.validAfter >= terms.validBefore ||
      (terms.kind !== 0n && terms.kind !== 1n) ||
      (terms.feeBps > 0n && [zeroAddress, executor, payer].includes(treasury)) ||
      (terms.kind === 0n && (terms.amount === 0n || terms.amount > terms.perChargeCap || terms.interval === 0n)) ||
      (terms.kind === 1n && (terms.amount !== 0n || terms.interval !== 0n))) {
    throw new Error("Invalid mandate terms.");
  }
  return { domain: mandateContractDomain(target), types: mandateTermsTypes,
    primaryType: "MandateTerms" as const, message: { ...terms, payer, seller, treasury } };
}

export function mandateTermsDigest(target: ContractDeployment, terms: MandateContractTerms): Hex {
  return hashTypedData(buildMandateTermsTypedData(target, terms));
}

/** Contract storage/events carry the struct hash; signatures use the full domain digest. */
export function mandateTermsStructHash(target: ContractDeployment, terms: MandateContractTerms): Hex {
  const typed = buildMandateTermsTypedData(target, terms);
  return hashStruct({ data: typed.message, primaryType: typed.primaryType, types: typed.types });
}

export function mandateSubscriptionChargeId(mandateId: Hex, expectedSequence: bigint): Hex {
  bytes32(mandateId); uint(expectedSequence);
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [mandateId, expectedSequence]));
}

export function buildMandatePermitTypedData(target: ContractDeployment, terms: MandateContractTerms, tokenDomain: Eip3009Domain) {
  buildMandateTermsTypedData(target, terms);
  return {
    domain: { ...tokenDomain, chainId: target.chainId, verifyingContract: getAddress(target.token) },
    types: { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] } as const,
    primaryType: "Permit" as const,
    message: { owner: getAddress(terms.payer), spender: getAddress(target.executor),
      value: terms.expectedOutstanding + terms.lifetimeCap, nonce: terms.permitNonce, deadline: terms.permitDeadline },
  };
}

export function buildMandateChargeTypedData(target: ContractDeployment, terms: MandateContractTerms,
  charge: { chargeId: Hex; gross: bigint; deadline: bigint }) {
  buildMandateTermsTypedData(target, terms); bytes32(charge.chargeId); uint(charge.gross); uint(charge.deadline);
  if (terms.kind !== 1n || charge.gross === 0n || charge.gross > terms.perChargeCap || charge.deadline > terms.validBefore) {
    throw new Error("Invalid mandate charge.");
  }
  return { domain: mandateContractDomain(target),
    types: { MandateCharge: [
      { name: "mandateId", type: "bytes32" }, { name: "chargeId", type: "bytes32" },
      { name: "gross", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] } as const,
    primaryType: "MandateCharge" as const, message: { mandateId: terms.mandateId, ...charge } };
}

export function buildMandateRevocationTypedData(target: ContractDeployment, payer: Address, mandateId: Hex) {
  bytes32(mandateId);
  if (getAddress(payer) === zeroAddress) throw new Error("Invalid payer.");
  return { domain: mandateContractDomain(target), types: { RevokeMandate: [
    { name: "payer", type: "address" }, { name: "mandateId", type: "bytes32" },
  ] } as const, primaryType: "RevokeMandate" as const, message: { payer: getAddress(payer), mandateId } };
}
