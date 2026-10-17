import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { atomicPaymentCommitment, buildAtomicPaymentTypedData, buildMandateChargeTypedData,
  buildMandatePermitTypedData, buildMandateRevocationTypedData, mandateTermsDigest, mandateTermsStructHash, mandateSubscriptionChargeId,
  type ContractDeployment, type MandateContractTerms } from "./contract-authority.js";

const target: ContractDeployment = { chainId: 84532, token: "0x1111111111111111111111111111111111111111",
  executor: "0x2222222222222222222222222222222222222222", version: "1" };
const terms: MandateContractTerms = { mandateId: `0x${"01".repeat(32)}`,
  payer: "0x3333333333333333333333333333333333333333", seller: "0x4444444444444444444444444444444444444444",
  treasury: "0x5555555555555555555555555555555555555555", lifetimeCap: 100000n, perChargeCap: 10000n,
  feeBps: 100n, kind: 1n, amount: 0n, interval: 0n, validAfter: 900n, validBefore: 10000n,
  expectedOutstanding: 0n, permitNonce: 0n, permitDeadline: 2000n };
const chargeId = `0x${"02".repeat(32)}` as const;
const payment = { paymentId: terms.mandateId, salt: chargeId, payer: terms.payer, seller: terms.seller,
  treasury: terms.treasury, gross: 10000n, sellerAmount: 9900n, feeAmount: 100n };

describe("contract authority", () => {
  it("MR-408: distinguishes stored struct hash from signed domain digest and binds subscription sequence", () => {
    expect(mandateTermsStructHash(target, terms)).toBe("0xc13e2d99f22c0603e3430bfee27b461039bba7375c00a18209a9b7c9813cc158");
    expect(mandateSubscriptionChargeId(terms.mandateId, 0n)).toBe("0xc9c2b9c48fb9c3ca9e71817fb01e907be3e0eda4d950bbdcb6dcc4c1a73a6537");
    expect(mandateTermsStructHash(target, terms)).not.toBe(mandateTermsDigest(target, terms));
    expect(mandateTermsStructHash(target, terms)).toBe(mandateTermsStructHash({ ...target, chainId: 8453 }, terms));
    expect(mandateTermsDigest(target, terms)).not.toBe(mandateTermsDigest({ ...target, chainId: 8453 }, terms));
    expect(mandateSubscriptionChargeId(terms.mandateId, 0n)).not.toBe(mandateSubscriptionChargeId(terms.mandateId, 1n));
    expect(() => mandateSubscriptionChargeId(terms.mandateId, -1n)).toThrow();
  });
  it("MR-301: matches independent Solidity golden vectors", () => {
    expect(mandateTermsDigest(target, terms)).toBe("0x013759105da5b917f52cbcb2174921bdceadc8b23af8436fe846ec216c48aa5e");
    expect(hashTypedData(buildMandatePermitTypedData(target, terms, { name: "USDC", version: "1" })))
      .toBe("0xa75ebc9df89aed75b962736ec60649b9b8a24a4607b637926df265fa87d8e085");
    expect(hashTypedData(buildMandateChargeTypedData(target, terms, { chargeId, gross: 10000n, deadline: 2000n })))
      .toBe("0x4d36ef7a523054dc0584159b0d9b03ab7bab0a5eff5e3ae95ac4fcc5a7f265e2");
    expect(hashTypedData(buildMandateRevocationTypedData(target, terms.payer, terms.mandateId)))
      .toBe("0xb3e8b8d5e6b68f7e1b2b97d7901868fa60faac97f03fbe1b3f44a397bcf2532d");
    expect(atomicPaymentCommitment(target, payment)).toBe("0x701c2df603e44de255ecd6d6cdc79c14794c0256cc901aa78293402d568482c1");
  });
  it("MR-301: binds recipient, fees, payment identity, asset and contract deployment", () => {
    const original = atomicPaymentCommitment(target, payment);
    for (const modified of [{ ...payment, seller: target.token }, { ...payment, treasury: target.token },
      { ...payment, feeAmount: 101n, sellerAmount: 9899n }, { ...payment, paymentId: chargeId }]) {
      expect(atomicPaymentCommitment(target, modified)).not.toBe(original);
    }
    expect(atomicPaymentCommitment({ ...target, chainId: 8453 }, payment)).not.toBe(original);
    expect(atomicPaymentCommitment({ ...target, token: terms.seller }, payment)).not.toBe(original);
    expect(atomicPaymentCommitment({ ...target, executor: target.token }, payment)).not.toBe(original);
  });
  it("MR-401: never emits unlimited aggregate allowances", () => {
    const max = (1n << 256n) - 1n;
    for (const modified of [{ ...terms, lifetimeCap: max },
      { ...terms, expectedOutstanding: max - terms.lifetimeCap }]) {
      expect(() => buildMandatePermitTypedData(target, modified, { name: "USDC", version: "2" })).toThrow("Unlimited");
    }
  });
  it("MR-101/MR-301: validates sums, integer bounds and signed windows", () => {
    expect(() => atomicPaymentCommitment(target, { ...payment, gross: 10001n })).toThrow();
    expect(() => atomicPaymentCommitment(target, { ...payment, feeAmount: -1n })).toThrow();
    expect(() => buildAtomicPaymentTypedData({ deployment: target, terms: payment,
      validAfter: 100n, validBefore: 99n, tokenDomain: { name: "USDC", version: "2" } })).toThrow();
    const typed = buildAtomicPaymentTypedData({ deployment: target, terms: payment,
      validAfter: 900n, validBefore: 2000n, tokenDomain: { name: "USDC", version: "2" } });
    expect(typed.primaryType).toBe("ReceiveWithAuthorization");
    expect(typed.message.nonce).toBe(atomicPaymentCommitment(target, payment));
    expect(typed.message.to).toBe(target.executor);
  });
});
