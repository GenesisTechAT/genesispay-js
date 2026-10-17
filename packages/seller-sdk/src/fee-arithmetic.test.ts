import { describe, expect, it } from "vitest";

import { contractChargeFeeMinor } from "./fee-arithmetic.js";

/**
 * The SAME table as `FEE_FLOOR_VECTORS` in `src/lib/fees.test.ts` (the server's
 * `calculateFeeMinor`). Change one, change both: a drift here means the SDK
 * would reject a fee the server and the contract agree on.
 * Each row: [grossMinor, feeBps, floor(gross × bps / 10000)].
 */
const FEE_FLOOR_VECTORS: ReadonlyArray<readonly [bigint, number, bigint]> = [
  [0n, 1, 0n], [0n, 50, 0n], [0n, 100, 0n], [0n, 167, 0n], [0n, 10_000, 0n],
  [1n, 1, 0n], [1n, 50, 0n], [1n, 100, 0n], [1n, 167, 0n], [1n, 10_000, 1n],
  [9_999n, 1, 0n], [9_999n, 50, 49n], [9_999n, 100, 99n], [9_999n, 167, 166n], [9_999n, 10_000, 9_999n],
  [10_000n, 1, 1n], [10_000n, 50, 50n], [10_000n, 100, 100n], [10_000n, 167, 167n], [10_000n, 10_000, 10_000n],
  [10_001n, 1, 1n], [10_001n, 50, 50n], [10_001n, 100, 100n], [10_001n, 167, 167n], [10_001n, 10_000, 10_001n],
  [2_000_000n, 1, 200n], [2_000_000n, 50, 10_000n], [2_000_000n, 100, 20_000n], [2_000_000n, 167, 33_400n],
  [2_000_000n, 10_000, 2_000_000n],
];

describe("contractChargeFeeMinor", () => {
  it("MR-1005: SDK fee arithmetic matches the server vectors", () => {
    for (const [grossMinor, feeBps, expected] of FEE_FLOOR_VECTORS) {
      expect(contractChargeFeeMinor(grossMinor, BigInt(feeBps)), `${grossMinor} @ ${feeBps} bps`).toBe(expected);
    }
  });

  it("MR-104: rejects a negative gross and a rate outside 0–10000 bps", () => {
    expect(() => contractChargeFeeMinor(-1n, 100n)).toThrow(RangeError);
    expect(() => contractChargeFeeMinor(1n, -1n)).toThrow(RangeError);
    expect(() => contractChargeFeeMinor(1n, 10_001n)).toThrow(RangeError);
  });
});
