import { getAddress, verifyTypedData } from "viem";

import type {
  EvmAddress,
  HexString,
  PaymentAccept,
  TransferAuthorization,
} from "./types.js";

/**
 * EIP-712 typed-data definition for the EIP-3009 TransferWithAuthorization
 * message used by USDC.
 */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const USDC_EIP712_DOMAIN_NAME = "USDC";
export const USDC_EIP712_DOMAIN_VERSION = "2";

export type UsdcContractReference = {
  chainId: number;
  address: EvmAddress;
};

/** EIP-712 domain `name`/`version` of the settlement asset contract. */
export type Eip3009Domain = {
  name: string;
  version: string;
};

export type TransferAuthorizationTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: EvmAddress;
  };
  types: typeof transferWithAuthorizationTypes;
  primaryType: "TransferWithAuthorization";
  message: {
    from: EvmAddress;
    to: EvmAddress;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: HexString;
  };
};

/**
 * Derives the EIP-712 domain name/version to sign with from a PAYMENT-REQUIRED
 * accepts entry: the x402 `extra` field when the seller advertised one,
 * otherwise the historical USDC default ("USDC" / "2").
 */
export function resolveAcceptEip712Domain(
  accept: Pick<PaymentAccept, "extra">,
): Eip3009Domain {
  return {
    name: accept.extra?.name ?? USDC_EIP712_DOMAIN_NAME,
    version: accept.extra?.version ?? USDC_EIP712_DOMAIN_VERSION,
  };
}

/**
 * Builds the full EIP-712 typed-data payload for signing or verifying an
 * EIP-3009 TransferWithAuthorization. Pass the result to viem's
 * signTypedData / verifyTypedData.
 *
 * `domain` overrides the EIP-712 domain name/version; without it the
 * historical USDC default ("USDC" / "2") is used. Use
 * `resolveAcceptEip712Domain` to derive the override from an accepts entry.
 */
export function buildTransferAuthorizationTypedData({
  authorization,
  usdc,
  domain,
}: {
  authorization: TransferAuthorization;
  usdc: UsdcContractReference;
  domain?: Eip3009Domain;
}): TransferAuthorizationTypedData {
  return {
    domain: {
      name: domain?.name ?? USDC_EIP712_DOMAIN_NAME,
      version: domain?.version ?? USDC_EIP712_DOMAIN_VERSION,
      chainId: usdc.chainId,
      verifyingContract: getAddress(usdc.address),
    },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
}

/**
 * Verifies that `signature` is a valid EIP-712 signature by
 * `authorization.from` over the TransferWithAuthorization message for the
 * given USDC contract.
 */
export async function verifyTransferAuthorizationSignature({
  authorization,
  signature,
  usdc,
  domain,
}: {
  authorization: TransferAuthorization;
  signature: HexString;
  usdc: UsdcContractReference;
  domain?: Eip3009Domain;
}): Promise<boolean> {
  const typedData = buildTransferAuthorizationTypedData({
    authorization,
    usdc,
    domain,
  });

  return verifyTypedData({
    address: typedData.message.from,
    ...typedData,
    signature,
  });
}
