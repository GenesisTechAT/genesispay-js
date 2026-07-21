import type { EvmAddress } from "@genesis-tech/peerpay-protocol";

/** Networks the payment gate supports out of the box. */
export type PaymentGateNetwork = "base" | "base-sepolia";

export type PaymentGateNetworkConfig = {
  network: PaymentGateNetwork;
  chainId: number;
  usdcAddress: EvmAddress;
};

const BASE_MAINNET: PaymentGateNetworkConfig = {
  network: "base",
  chainId: 8453,
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const BASE_SEPOLIA: PaymentGateNetworkConfig = {
  network: "base-sepolia",
  chainId: 84532,
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
