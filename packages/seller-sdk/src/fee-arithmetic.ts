/**
 * The percentage fee of one contract-mandate charge, in minor units:
 * `floor(gross × feeBps / 10000)` — what `MandateExecutor._charge` takes
 * on-chain (`Math.mulDiv(gross, terms.feeBps, 10_000)`, OpenZeppelin's default
 * floor rounding). Internal, not exported from the package index.
 *
 * It mirrors the server's `calculateFeeMinor` (`src/lib/fees.ts`), which this
 * package cannot import. `fee-arithmetic.test.ts` pins the same vectors as
 * `src/lib/fees.test.ts`, so the two cannot drift silently.
 */
export function contractChargeFeeMinor(grossMinor: bigint, feeBps: bigint): bigint {
  if (grossMinor < 0n) throw new RangeError("grossMinor must not be negative.");
  if (feeBps < 0n || feeBps > 10_000n) throw new RangeError("feeBps must be an integer between 0 and 10000.");
  return (grossMinor * feeBps) / 10_000n;
}
