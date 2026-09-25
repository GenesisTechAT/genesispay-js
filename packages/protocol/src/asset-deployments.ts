/**
 * Publishable authority registry shared by GenesisPay's backend and SDKs.
 * These tuples are protocol identity, not application configuration: an amount
 * can authorize fulfillment only together with its exact asset deployment.
 */
export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;

export const GENESISPAY_ASSET_SYMBOLS = ["USDC", "EURC"] as const;
export type GenesisPayAssetSymbol = (typeof GENESISPAY_ASSET_SYMBOLS)[number];

export type GenesisPayDeploymentMode = "test" | "live";

export type GenesisPayAssetDeployment = Readonly<{
  mode: GenesisPayDeploymentMode;
  network: "base";
  chainId: typeof BASE_MAINNET_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID;
  asset: GenesisPayAssetSymbol;
  tokenAddress: `0x${string}`;
  minorUnitScale: 6;
  eip712: Readonly<{ name: string; version: "2" }>;
}>;

export const GENESISPAY_ASSET_DEPLOYMENTS: Readonly<
  Record<
    GenesisPayDeploymentMode,
    Readonly<Record<GenesisPayAssetSymbol, GenesisPayAssetDeployment>>
  >
> = {
  live: {
    USDC: {
      mode: "live",
      network: "base",
      chainId: BASE_MAINNET_CHAIN_ID,
      asset: "USDC",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      minorUnitScale: 6,
      eip712: { name: "USD Coin", version: "2" },
    },
    EURC: {
      mode: "live",
      network: "base",
      chainId: BASE_MAINNET_CHAIN_ID,
      asset: "EURC",
      tokenAddress: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
      minorUnitScale: 6,
      eip712: { name: "EURC", version: "2" },
    },
  },
  test: {
    USDC: {
      mode: "test",
      network: "base",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      asset: "USDC",
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      minorUnitScale: 6,
      eip712: { name: "USDC", version: "2" },
    },
    EURC: {
      mode: "test",
      network: "base",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      asset: "EURC",
      tokenAddress: "0x808456652fdb597867f38412077A9182bf77359F",
      minorUnitScale: 6,
      eip712: { name: "EURC", version: "2" },
    },
  },
};

export function getGenesisPayAssetDeployment(
  mode: GenesisPayDeploymentMode,
  asset: GenesisPayAssetSymbol,
): GenesisPayAssetDeployment {
  return GENESISPAY_ASSET_DEPLOYMENTS[mode][asset];
}

export function getGenesisPayAssetDeploymentByChain(
  asset: GenesisPayAssetSymbol,
  chainId: number,
): GenesisPayAssetDeployment | null {
  if (chainId === BASE_MAINNET_CHAIN_ID) return GENESISPAY_ASSET_DEPLOYMENTS.live[asset];
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return GENESISPAY_ASSET_DEPLOYMENTS.test[asset];
  return null;
}
