import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  buildTransferAuthorizationTypedData,
  resolveAcceptEip712Domain,
  verifyTransferAuthorizationSignature,
} from "./eip3009.js";
import type { TransferAuthorization, UsdcContractReference } from "./index.js";

const account = privateKeyToAccount(`0x${"42".repeat(32)}`);

const usdc: UsdcContractReference = {
  chainId: 84532,
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const authorization: TransferAuthorization = {
  from: account.address,
  to: "0x1111111111111111111111111111111111111111",
  value: "5000",
  validAfter: "0",
  validBefore: "1900000000",
  nonce: `0x${"ab".repeat(32)}`,
};

describe("buildTransferAuthorizationTypedData", () => {
  it("builds the USDC EIP-712 typed data with bigint numerics", () => {
    const typedData = buildTransferAuthorizationTypedData({ authorization, usdc });

    expect(typedData).toEqual({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: usdc.address,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: "0x1111111111111111111111111111111111111111",
        value: 5000n,
        validAfter: 0n,
        validBefore: 1900000000n,
        nonce: `0x${"ab".repeat(32)}`,
      },
    });
  });

  it("applies a domain name/version override for non-default deployments", () => {
    const typedData = buildTransferAuthorizationTypedData({
      authorization,
      usdc,
      domain: { name: "EURC", version: "2" },
    });

    expect(typedData.domain).toEqual({
      name: "EURC",
      version: "2",
      chainId: 84532,
      verifyingContract: usdc.address,
    });
  });

  it("checksums lowercase addresses", () => {
    const typedData = buildTransferAuthorizationTypedData({
      authorization: {
        ...authorization,
        from: account.address.toLowerCase() as `0x${string}`,
      },
      usdc: { ...usdc, address: usdc.address.toLowerCase() as `0x${string}` },
    });

    expect(typedData.message.from).toBe(account.address);
    expect(typedData.domain.verifyingContract).toBe(usdc.address);
  });
});

describe("resolveAcceptEip712Domain", () => {
  it("prefers the accepts entry's extra over the USDC default", () => {
    expect(
      resolveAcceptEip712Domain({ extra: { name: "USD Coin", version: "2" } }),
    ).toEqual({ name: "USD Coin", version: "2" });
    expect(resolveAcceptEip712Domain({})).toEqual({
      name: "USDC",
      version: "2",
    });
  });
});

describe("verifyTransferAuthorizationSignature", () => {
  it("accepts a signature produced by the payer over the typed data", async () => {
    const signature = await account.signTypedData(
      buildTransferAuthorizationTypedData({ authorization, usdc }),
    );

    await expect(
      verifyTransferAuthorizationSignature({ authorization, signature, usdc }),
    ).resolves.toBe(true);
  });

  it("rejects a signature over different authorization fields", async () => {
    const signature = await account.signTypedData(
      buildTransferAuthorizationTypedData({ authorization, usdc }),
    );

    await expect(
      verifyTransferAuthorizationSignature({
        authorization: { ...authorization, value: "6000" },
        signature,
        usdc,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a signature bound to a different chain", async () => {
    const signature = await account.signTypedData(
      buildTransferAuthorizationTypedData({ authorization, usdc }),
    );

    await expect(
      verifyTransferAuthorizationSignature({
        authorization,
        signature,
        usdc: { ...usdc, chainId: 8453 },
      }),
    ).resolves.toBe(false);
  });

  it("rejects a signature from a different account", async () => {
    const otherAccount = privateKeyToAccount(`0x${"43".repeat(32)}`);
    const signature = await otherAccount.signTypedData(
      buildTransferAuthorizationTypedData({ authorization, usdc }),
    );

    await expect(
      verifyTransferAuthorizationSignature({ authorization, signature, usdc }),
    ).resolves.toBe(false);
  });
});
