import { describe, expect, it } from "vitest";

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  GENESISPAY_ASSET_DEPLOYMENTS,
  getGenesisPayAssetDeploymentByChain,
} from "./asset-deployments.js";

describe("GenesisPay asset deployments", () => {
  it("MR-102/MR-103: binds each asset to one canonical Base tuple per mode", () => {
    for (const [mode, chainId] of [
      ["live", BASE_MAINNET_CHAIN_ID],
      ["test", BASE_SEPOLIA_CHAIN_ID],
    ] as const) {
      for (const asset of ["USDC", "EURC"] as const) {
        expect(GENESISPAY_ASSET_DEPLOYMENTS[mode][asset]).toMatchObject({
          mode,
          network: "base",
          chainId,
          asset,
          minorUnitScale: 6,
          tokenAddress: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        });
      }
    }
  });

  it("has no fallback for an unknown chain", () => {
    expect(getGenesisPayAssetDeploymentByChain("USDC", 1)).toBeNull();
  });
});
