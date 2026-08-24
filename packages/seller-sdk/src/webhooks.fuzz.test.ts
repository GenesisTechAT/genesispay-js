import { describe, expect, it } from "vitest";

import { constructEvent, GenesisPaySignatureVerificationError } from "./webhooks.js";

/**
 * Boundary fuzz for the published webhook verifier (MR-603): hostile
 * signature headers and bodies must always surface as the SDK's own typed
 * verification error — never a TypeError from parsing internals (an
 * integrator's catch blocks branch on the error class), and obviously never
 * a successfully "verified" event.
 *
 * Deterministic generator; each case reproduces from its index.
 */

function makeRng(seed: bigint) {
  let state = seed;
  return () => {
    state ^= state << 13n;
    state ^= state >> 7n;
    state ^= state << 17n;
    state &= (1n << 64n) - 1n;
    return state;
  };
}

function randomString(next: () => bigint, length: number): string {
  const pool = "\u0000{}[]\"'\\:,=tv1🤖ÿ\n\r\tabcdef0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += pool[Number(next() % BigInt(pool.length))];
  }
  return out;
}

const secret = "gp_whsec_fuzz_secret";
const body = JSON.stringify({ type: "payment.confirmed", data: {} });

async function expectTypedRefusal(header: string, rawBody: string, label: string) {
  try {
    await constructEvent(rawBody, header, secret);
    expect.fail(`${label}: hostile input was accepted as a verified event`);
  } catch (error) {
    expect(
      error instanceof GenesisPaySignatureVerificationError,
      `${label}: threw ${String(error)} instead of the SDK's typed verification error`,
    ).toBe(true);
  }
}

describe("MR-603: hostile signature headers always fail with the SDK's typed error", () => {
  it("random hostile header strings", async () => {
    const next = makeRng(0x4444n);
    for (let i = 0; i < 200; i++) {
      const header = randomString(next, Number(next() % 150n) + 1);
      await expectTypedRefusal(header, body, `header case ${i}`);
    }
  });

  it("near-miss headers around the t=...,v1=... grammar", async () => {
    const cases = [
      "t=,v1=",
      "t=abc,v1=deadbeef",
      "t=99999999999999999999,v1=deadbeef",
      "t=-1,v1=deadbeef",
      `t=${Math.floor(Date.now() / 1000)}`,
      `v1=${"ab".repeat(32)}`,
      `t=${Math.floor(Date.now() / 1000)},v1=`,
      `t=${Math.floor(Date.now() / 1000)},v1=nothex!!`,
      `t=${Math.floor(Date.now() / 1000)},v2=${"ab".repeat(32)}`,
      `t=${Math.floor(Date.now() / 1000)},v1=${"ab".repeat(32)},${"x".repeat(10_000)}`,
      "t".repeat(50_000),
    ];
    for (const [i, header] of cases.entries()) {
      await expectTypedRefusal(header, body, `grammar case ${i}`);
    }
  });

  it("a syntactically valid but wrong signature never verifies, for hostile bodies too", async () => {
    const next = makeRng(0x5555n);
    for (let i = 0; i < 100; i++) {
      const hostileBody = randomString(next, Number(next() % 300n));
      const header = `t=${Math.floor(Date.now() / 1000)},v1=${"ab".repeat(32)}`;
      await expectTypedRefusal(header, hostileBody, `body case ${i}`);
    }
  });
});
