import type { EvmAddress } from "@genesis-tech/genesispay-protocol";
import { GENESISPAY_ASSET_DEPLOYMENTS } from "@genesis-tech/genesispay-protocol";

/** Networks the payment gate supports out of the box. */
export type PaymentGateNetwork = "base" | "base-sepolia";

export type PaymentGateNetworkConfig = {
  network: PaymentGateNetwork;
  chainId: number;
  usdcAddress: EvmAddress;
};

const BASE_MAINNET: PaymentGateNetworkConfig = {
  network: "base",
  chainId: GENESISPAY_ASSET_DEPLOYMENTS.live.USDC.chainId,
  usdcAddress: GENESISPAY_ASSET_DEPLOYMENTS.live.USDC.tokenAddress,
};

const BASE_SEPOLIA: PaymentGateNetworkConfig = {
  network: "base-sepolia",
  chainId: GENESISPAY_ASSET_DEPLOYMENTS.test.USDC.chainId,
  usdcAddress: GENESISPAY_ASSET_DEPLOYMENTS.test.USDC.tokenAddress,
};

const NETWORK_CONFIGS: Record<PaymentGateNetwork, PaymentGateNetworkConfig> = {
  base: BASE_MAINNET,
  "base-sepolia": BASE_SEPOLIA,
};

export function resolvePaymentGateNetwork(
  network: PaymentGateNetwork,
): PaymentGateNetworkConfig {
  const config = NETWORK_CONFIGS[network];

  if (!config) {
    throw new Error(
      `Unsupported network "${String(network)}". Supported networks: ${Object.keys(NETWORK_CONFIGS).join(", ")}.`,
    );
  }

  return config;
}
