import { describe, expect, it } from "vitest";

import { parseUsdcAmountToMinorUnits } from "./usdc-amount.js";

describe("parseUsdcAmountToMinorUnits", () => {
  it("parses whole and fractional amounts to minor units", () => {
    expect(parseUsdcAmountToMinorUnits("1")).toBe(1_000_000n);
    expect(parseUsdcAmountToMinorUnits("0.10")).toBe(100_000n);
    expect(parseUsdcAmountToMinorUnits("0.000001")).toBe(1n);
    expect(parseUsdcAmountToMinorUnits("12.5")).toBe(12_500_000n);
  });

  it("trims surrounding whitespace", () => {
    expect(parseUsdcAmountToMinorUnits(" 0.25 ")).toBe(250_000n);
  });

  it("rejects malformed amounts", () => {
    for (const amount of ["", "abc", "-1", "1.2345678", "1,5", ".5", "1e6"]) {
      expect(() => parseUsdcAmountToMinorUnits(amount)).toThrow(
        "Invalid USDC amount",
      );
    }
  });

  it("rejects zero", () => {
    expect(() => parseUsdcAmountToMinorUnits("0")).toThrow(
      "greater than zero",
    );
    expect(() => parseUsdcAmountToMinorUnits("0.000000")).toThrow(
      "greater than zero",
    );
  });
});
