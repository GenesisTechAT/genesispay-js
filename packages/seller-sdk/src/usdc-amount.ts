const USDC_DECIMALS = 6;
const USDC_AMOUNT_PATTERN = /^\d+(?:\.\d{1,6})?$/;

/**
 * Parses a human-readable decimal USDC amount ("0.10") into integer minor
 * units (6 decimals) as a bigint. Rejects anything that is not a positive
 * amount with at most 6 decimal places.
 */
export function parseUsdcAmountToMinorUnits(amount: string): bigint {
  const normalizedAmount = amount.trim();

  if (!USDC_AMOUNT_PATTERN.test(normalizedAmount)) {
    throw new Error(
      `Invalid USDC amount "${amount}": use a positive decimal with up to 6 decimals, e.g. "0.10".`,
    );
  }

  const [wholePart, fractionalPart = ""] = normalizedAmount.split(".");
  const minorUnits =
    BigInt(wholePart) * BigInt(10 ** USDC_DECIMALS) +
    BigInt(fractionalPart.padEnd(USDC_DECIMALS, "0"));

  if (minorUnits <= 0n) {
    throw new Error("USDC amount must be greater than zero.");
  }

  return minorUnits;
}
