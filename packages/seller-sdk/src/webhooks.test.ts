import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  constructEvent,
  isKnownGenesisPayEventType,
  GENESISPAY_EVENT_TYPES,
  GenesisPaySignatureVerificationError,
  type GenesisPayAnyEvent,
  type GenesisPayEvent,
  type GenesisPayEventType,
} from "./webhooks.js";

// Reference implementation, byte-for-byte the server's signing formula in
// `src/features/sellers/webhooks.ts` (computeWebhookSignature /
// buildWebhookSignatureHeader). Kept local + node:crypto-based so the package
// typecheck (rootDir: src) stays self-contained; if the server ever changes the
// signed payload, these tests are the drift alarm.
function referenceSignature(
  secret: string,
  timestampSeconds: number,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`)
    .digest("hex");
}

function referenceHeader(
  secret: string,
  body: string,
  timestampSeconds: number,
): string {
  return `t=${timestampSeconds},v1=${referenceSignature(secret, timestampSeconds, body)}`;
}

const SECRET = "whsec_test_5f3c9a2b1d8e4c7a";
const NOW_SECONDS = 1_774_000_000;
const NOW_MS = NOW_SECONDS * 1_000;

const RAW_BODY = JSON.stringify({
  id: "b4f1f0e2-6a9c-4c1e-9d2f-6b7c8d9e0a1b",
  type: "payment.confirmed",
  createdAt: "2026-07-08T12:00:00.000Z",
  data: {
    link: { publicId: "abc123", amountUsdc: "5.00" },
    occurredAt: "2026-07-08T12:00:00.000Z",
  },
});

const VALID_HEADER = referenceHeader(SECRET, RAW_BODY, NOW_SECONDS);

async function expectRejection(
  promise: Promise<unknown>,
  messageMatch: RegExp,
): Promise<GenesisPaySignatureVerificationError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(GenesisPaySignatureVerificationError);
  const typed = caught as GenesisPaySignatureVerificationError;
  expect(typed.name).toBe("GenesisPaySignatureVerificationError");
  expect(typed.message).toMatch(messageMatch);
  return typed;
}

describe("constructEvent", () => {
  it("accepts a signature produced with the server formula and returns the parsed event", async () => {
    const event = await constructEvent(RAW_BODY, VALID_HEADER, SECRET, {
      nowMs: NOW_MS,
    });

    expect(event.id).toBe("b4f1f0e2-6a9c-4c1e-9d2f-6b7c8d9e0a1b");
    expect(event.type).toBe("payment.confirmed");
    expect(event.createdAt).toBe("2026-07-08T12:00:00.000Z");
    expect(event.data).toMatchObject({
      link: { publicId: "abc123", amountUsdc: "5.00" },
    });
  });

  it("accepts a Uint8Array body identical to the signed bytes", async () => {
    const bytes = new TextEncoder().encode(RAW_BODY);

    const event = await constructEvent(bytes, VALID_HEADER, SECRET, {
      nowMs: NOW_MS,
    });

    expect(event.type).toBe("payment.confirmed");
  });

  it("verifies a body containing multi-byte UTF-8 characters", async () => {
    const body = JSON.stringify({
      id: "utf8",
      type: "payment.confirmed",
      createdAt: "2026-07-08T12:00:00.000Z",
      data: { title: "Café — Straße 日本語 🎉" },
    });
    const header = referenceHeader(SECRET, body, NOW_SECONDS);

    const fromString = await constructEvent(body, header, SECRET, {
      nowMs: NOW_MS,
    });
    const fromBytes = await constructEvent(
      new TextEncoder().encode(body),
      header,
      SECRET,
      { nowMs: NOW_MS },
    );

    expect(fromString.data).toEqual({ title: "Café — Straße 日本語 🎉" });
    expect(fromBytes).toEqual(fromString);
  });

  it("rejects a tampered body", async () => {
    const tampered = RAW_BODY.replace('"5.00"', '"5000.00"');
    expect(tampered).not.toBe(RAW_BODY);

    await expectRejection(
      constructEvent(tampered, VALID_HEADER, SECRET, { nowMs: NOW_MS }),
      /signature mismatch/i,
    );
  });

  it("rejects the wrong secret", async () => {
    await expectRejection(
      constructEvent(RAW_BODY, VALID_HEADER, "whsec_wrong_secret", {
        nowMs: NOW_MS,
      }),
      /signature mismatch/i,
    );
  });

  it("rejects an expired timestamp beyond the default 300s tolerance", async () => {
    const staleSeconds = NOW_SECONDS - 301;
    const header = referenceHeader(SECRET, RAW_BODY, staleSeconds);

    await expectRejection(
      constructEvent(RAW_BODY, header, SECRET, { nowMs: NOW_MS }),
      /tolerance window/i,
    );
  });

  it("accepts a timestamp exactly at the tolerance boundary", async () => {
    const header = referenceHeader(SECRET, RAW_BODY, NOW_SECONDS - 300);

    await expect(
      constructEvent(RAW_BODY, header, SECRET, { nowMs: NOW_MS }),
    ).resolves.toMatchObject({ type: "payment.confirmed" });
  });

  it("rejects a timestamp from the future", async () => {
    const header = referenceHeader(SECRET, RAW_BODY, NOW_SECONDS + 3_600);

    await expectRejection(
      constructEvent(RAW_BODY, header, SECRET, { nowMs: NOW_MS }),
      /tolerance window/i,
    );
  });

  it("honours a custom toleranceSeconds", async () => {
    const header = referenceHeader(SECRET, RAW_BODY, NOW_SECONDS - 30);

    await expect(
      constructEvent(RAW_BODY, header, SECRET, {
        nowMs: NOW_MS,
        toleranceSeconds: 60,
      }),
    ).resolves.toMatchObject({ type: "payment.confirmed" });

    await expectRejection(
      constructEvent(RAW_BODY, header, SECRET, {
        nowMs: NOW_MS,
        toleranceSeconds: 10,
      }),
      /tolerance window/i,
    );
  });

  it("accepts any of several v1 values (secret rotation)", async () => {
    const rotatedIn = referenceSignature(SECRET, NOW_SECONDS, RAW_BODY);
    const oldSecretSignature = referenceSignature(
      "whsec_previous_secret",
      NOW_SECONDS,
      RAW_BODY,
    );

    const newFirst = `t=${NOW_SECONDS},v1=${rotatedIn},v1=${oldSecretSignature}`;
    const oldFirst = `t=${NOW_SECONDS},v1=${oldSecretSignature},v1=${rotatedIn}`;

    await expect(
      constructEvent(RAW_BODY, newFirst, SECRET, { nowMs: NOW_MS }),
    ).resolves.toMatchObject({ type: "payment.confirmed" });
    await expect(
      constructEvent(RAW_BODY, oldFirst, SECRET, { nowMs: NOW_MS }),
    ).resolves.toMatchObject({ type: "payment.confirmed" });
  });

  it("rejects when none of several v1 values match", async () => {
    const header =
      `t=${NOW_SECONDS},` +
      `v1=${referenceSignature("whsec_a", NOW_SECONDS, RAW_BODY)},` +
      `v1=${referenceSignature("whsec_b", NOW_SECONDS, RAW_BODY)}`;

    await expectRejection(
      constructEvent(RAW_BODY, header, SECRET, { nowMs: NOW_MS }),
      /signature mismatch/i,
    );
  });

  it("parses the header regardless of order and whitespace", async () => {
    const signature = referenceSignature(SECRET, NOW_SECONDS, RAW_BODY);
    const headers = [
      `v1=${signature}, t=${NOW_SECONDS}`,
      `  t = ${NOW_SECONDS} ,  v1 = ${signature}  `,
      `t=${NOW_SECONDS},v0=legacy,v1=${signature}`,
      `t=${NOW_SECONDS},v1=${signature.toUpperCase()}`,
    ];

    for (const header of headers) {
      await expect(
        constructEvent(RAW_BODY, header, SECRET, { nowMs: NOW_MS }),
      ).resolves.toMatchObject({ type: "payment.confirmed" });
    }
  });

  it("rejects a missing or empty header", async () => {
    await expectRejection(
      constructEvent(RAW_BODY, "", SECRET, { nowMs: NOW_MS }),
      /missing genesispay-signature header/i,
    );
    await expectRejection(
      constructEvent(RAW_BODY, "   ", SECRET, { nowMs: NOW_MS }),
      /missing genesispay-signature header/i,
    );
  });

  it("rejects a malformed header with distinguishable messages", async () => {
    await expectRejection(
      constructEvent(RAW_BODY, "garbage", SECRET, { nowMs: NOW_MS }),
      /malformed/i,
    );
    await expectRejection(
      constructEvent(RAW_BODY, `v1=${"a".repeat(64)}`, SECRET, {
        nowMs: NOW_MS,
      }),
      /missing "t"/i,
    );
    await expectRejection(
      constructEvent(RAW_BODY, `t=${NOW_SECONDS}`, SECRET, { nowMs: NOW_MS }),
      /missing "v1"/i,
    );
    await expectRejection(
      constructEvent(RAW_BODY, `t=not-a-number,v1=${"a".repeat(64)}`, SECRET, {
        nowMs: NOW_MS,
      }),
      /invalid "t"/i,
    );
    await expectRejection(
      constructEvent(
        RAW_BODY,
        `t=${NOW_SECONDS},t=${NOW_SECONDS},v1=${"a".repeat(64)}`,
        SECRET,
        { nowMs: NOW_MS },
      ),
      /duplicate "t"/i,
    );
  });

  it("rejects an empty secret", async () => {
    await expectRejection(
      constructEvent(RAW_BODY, VALID_HEADER, "", { nowMs: NOW_MS }),
      /missing webhook signing secret/i,
    );
  });

  it("rejects a correctly signed body that is not valid JSON", async () => {
    const body = "not-json";
    const header = referenceHeader(SECRET, body, NOW_SECONDS);

    await expectRejection(
      constructEvent(body, header, SECRET, { nowMs: NOW_MS }),
      /not valid json/i,
    );
  });

  it("rejects a correctly signed JSON array body", async () => {
    const body = "[1,2,3]";
    const header = referenceHeader(SECRET, body, NOW_SECONDS);

    await expectRejection(
      constructEvent(body, header, SECRET, { nowMs: NOW_MS }),
      /not a json object/i,
    );
  });

  it.each([
    ["id", '{"type":"payment.confirmed","createdAt":"2026-07-21T10:00:00.000Z","data":{}}'],
    ["type", '{"id":"evt_1","createdAt":"2026-07-21T10:00:00.000Z","data":{}}'],
    ["createdAt", '{"id":"evt_1","type":"payment.confirmed","data":{}}'],
  ])(
    "rejects a correctly signed envelope missing %s",
    async (field, body) => {
      const header = referenceHeader(SECRET, body, NOW_SECONDS);

      await expectRejection(
        constructEvent(body, header, SECRET, { nowMs: NOW_MS }),
        new RegExp(`"${field}"`),
      );
    },
  );

  it("rejects an envelope whose id is empty", async () => {
    // An empty id would pass a naive `typeof === "string"` check and then break
    // idempotency silently: every retry would dedupe against the same "" key.
    const body =
      '{"id":"","type":"payment.confirmed","createdAt":"2026-07-21T10:00:00.000Z","data":{}}';
    const header = referenceHeader(SECRET, body, NOW_SECONDS);

    await expectRejection(
      constructEvent(body, header, SECRET, { nowMs: NOW_MS }),
      /"id"/,
    );
  });

  it("rejects an envelope whose data is not an object", async () => {
    const body =
      '{"id":"evt_1","type":"payment.confirmed","createdAt":"2026-07-21T10:00:00.000Z","data":"nope"}';
    const header = referenceHeader(SECRET, body, NOW_SECONDS);

    await expectRejection(
      constructEvent(body, header, SECRET, { nowMs: NOW_MS }),
      /"data"/,
    );
  });

  it("never leaks the secret or the expected signature in error messages", async () => {
    const expected = referenceSignature(SECRET, NOW_SECONDS, RAW_BODY);
    const error = await expectRejection(
      constructEvent(RAW_BODY, VALID_HEADER, "whsec_wrong_secret", {
        nowMs: NOW_MS,
      }),
      /signature mismatch/i,
    );

    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("whsec_wrong_secret");
    expect(error.message).not.toContain(expected);
  });

  it("is insensitive to key-order-preserving re-serialization only when bytes match", async () => {
    // Guard against the classic integration bug: re-stringifying the parsed
    // body changes the bytes (here: whitespace) and must fail verification.
    const reserialized = JSON.stringify(JSON.parse(RAW_BODY), null, 2);
    expect(reserialized).not.toBe(RAW_BODY);

    await expectRejection(
      constructEvent(reserialized, VALID_HEADER, SECRET, { nowMs: NOW_MS }),
      /signature mismatch/i,
    );
  });
});

describe("typed event union", () => {
  const signed = (event: Record<string, unknown>) => {
    const body = JSON.stringify(event);
    return { body, header: referenceHeader(SECRET, body, NOW_SECONDS) };
  };

  const paymentBody = {
    id: "evt_payment_1",
    type: "payment.confirmed",
    createdAt: "2026-07-21T10:00:00.000Z",
    data: {
      link: {
        publicId: "abc123",
        title: "Credits",
        amountUsdcMinor: "5000000",
        amountUsdc: "5.00",
        linkType: "single",
        metadata: { orderId: "A-1" },
        clientReferenceId: "cart_42",
      },
      attempt: {
        id: "att_1",
        txHash: "0xdead",
        payerWallet: "0x1111111111111111111111111111111111111111",
        createdAt: "2026-07-21T09:59:00.000Z",
        confirmedAt: "2026-07-21T10:00:00.000Z",
        simulated: false,
      },
      occurredAt: "2026-07-21T10:00:00.000Z",
    },
  };

  it("narrows data on `event.type === \"payment.confirmed\"` without a cast", async () => {
    const { body, header } = signed(paymentBody);

    const event = await constructEvent(body, header, SECRET, { nowMs: NOW_MS });

    // The assignments below are the actual assertion: they only compile because
    // `data` is narrowed to GenesisPayPaymentEventData. `tsc -p packages/seller-sdk`
    // is what enforces it; the runtime expects keep the test honest.
    if (event.type !== "payment.confirmed") {
      throw new Error(`expected payment.confirmed, got ${event.type}`);
    }
    const txHash: string | null = event.data.attempt.txHash;
    const simulated: boolean = event.data.attempt.simulated;
    const clientReferenceId: string | null = event.data.link.clientReferenceId;
    const metadata: Record<string, string> | null = event.data.link.metadata;

    expect(txHash).toBe("0xdead");
    expect(simulated).toBe(false);
    expect(clientReferenceId).toBe("cart_42");
    expect(metadata).toEqual({ orderId: "A-1" });
  });

  it("narrows mandate events onto the mandate payload", async () => {
    const { body, header } = signed({
      id: "evt_mandate_1",
      type: "mandate.charged",
      createdAt: "2026-07-21T10:00:00.000Z",
      data: {
        mandate: {
          id: "man_1",
          kind: "subscription",
          status: "active",
          payerWallet: "0x2222222222222222222222222222222222222222",
          subscriptionPlanId: "1f0c4a6e-0000-4000-8000-000000000001",
          asset: "USDC",
          allowanceMinor: "100000000",
          capPerChargeMinor: "10000000",
          spentMinor: "10000000",
          amountPerPeriodMinor: "10000000",
          periodDays: 30,
          nextChargeAt: "2026-08-20T10:00:00.000Z",
        },
        charge: {
          id: "chg_1",
          kind: "subscription_renewal",
          amountMinor: "10000000",
          status: "confirmed",
          txHash: "0xbeef",
          resourceUrl: null,
          failureReason: null,
        },
        occurredAt: "2026-07-21T10:00:00.000Z",
      },
    });

    const event = await constructEvent(body, header, SECRET, { nowMs: NOW_MS });

    if (event.type !== "mandate.charged") throw new Error("wrong type");
    const spent: string = event.data.mandate.spentMinor;
    const chargeTx: string | null = event.data.charge?.txHash ?? null;
    const planId: string | null = event.data.mandate.subscriptionPlanId;

    expect(spent).toBe("10000000");
    expect(chargeTx).toBe("0xbeef");
    expect(planId).toBe("1f0c4a6e-0000-4000-8000-000000000001");
  });

  it("tells a mandate.active handler which plan was subscribed to", async () => {
    // The whole point of the plan reference: without it this handler knows that
    // someone subscribed but not to what, and has to guess from the amount.
    const { body, header } = signed({
      id: "evt_mandate_2",
      type: "mandate.active",
      createdAt: "2026-07-21T10:00:00.000Z",
      data: {
        mandate: {
          id: "man_2",
          kind: "subscription",
          status: "active",
          payerWallet: "0x2222222222222222222222222222222222222222",
          subscriptionPlanId: "1f0c4a6e-0000-4000-8000-000000000002",
          asset: "USDC",
          allowanceMinor: "108000000",
          capPerChargeMinor: "9000000",
          spentMinor: "0",
          amountPerPeriodMinor: "9000000",
          periodDays: 30,
          nextChargeAt: "2026-08-20T10:00:00.000Z",
        },
        charge: null,
        occurredAt: "2026-07-21T10:00:00.000Z",
      },
    });

    const event = await constructEvent(body, header, SECRET, { nowMs: NOW_MS });

    if (event.type !== "mandate.active") throw new Error("wrong type");
    // Compiles only because `data` narrows to GenesisPayMandateEventData and the
    // field is declared there — `tsc -p packages/seller-sdk` is the assertion.
    const planId: string | null = event.data.mandate.subscriptionPlanId;
    const mandateId: string = event.data.mandate.id;

    expect(planId).toBe("1f0c4a6e-0000-4000-8000-000000000002");
    // The pair a handler needs: which plan, and the id it can later revoke.
    expect(mandateId).toBe("man_2");
  });

  it("accepts an unknown event type instead of throwing — a new server event must never 400 a customer's route", async () => {
    // The regression this guards: an SDK that rejects unknown types turns every
    // newly added server event into a failing webhook delivery for every
    // integrator still on an older SDK. Worse than no typing at all.
    const { body, header } = signed({
      id: "evt_future_1",
      type: "invoice.finalized.v7",
      createdAt: "2026-07-21T10:00:00.000Z",
      data: { invoice: { id: "inv_1" }, occurredAt: "2026-07-21T10:00:00.000Z" },
    });

    const event = await constructEvent(body, header, SECRET, { nowMs: NOW_MS });

    // Widening is assignment-only: no cast, no `unknown` round trip.
    const anyEvent: GenesisPayAnyEvent = event;
    expect(anyEvent.type).toBe("invoice.finalized.v7");
    expect(anyEvent.data).toEqual({
      invoice: { id: "inv_1" },
      occurredAt: "2026-07-21T10:00:00.000Z",
    });
    expect(isKnownGenesisPayEventType(anyEvent.type)).toBe(false);
  });

  it("still verifies the signature of an unknown event type", async () => {
    // Forward compatibility must not become "anything goes": an unknown type is
    // waved through the type check, never through the HMAC.
    const { body, header } = signed({
      id: "evt_future_2",
      type: "invoice.finalized.v7",
      createdAt: "2026-07-21T10:00:00.000Z",
      data: {},
    });

    await expectRejection(
      constructEvent(body.replace("inv", "INV"), header, SECRET, { nowMs: NOW_MS }),
      /signature mismatch/i,
    );
  });

  it("reports which types this SDK version knows", () => {
    expect(GENESISPAY_EVENT_TYPES).toContain("payment.confirmed");
    expect(GENESISPAY_EVENT_TYPES).toContain("subscription.past_due");
    expect(new Set(GENESISPAY_EVENT_TYPES).size).toBe(GENESISPAY_EVENT_TYPES.length);
    expect(isKnownGenesisPayEventType("link.paid")).toBe(true);
    expect(isKnownGenesisPayEventType("link.paid.v2")).toBe(false);
  });

  it("keeps GenesisPayEventType and the runtime list in lockstep", () => {
    // Compile-time half: every literal in the runtime list is a GenesisPayEventType
    // and every GenesisPayEventType is coverable by the list.
    const fromList: GenesisPayEventType = GENESISPAY_EVENT_TYPES[0];
    const coverage: Record<GenesisPayEventType, true> = {
      "payment.confirmed": true,
      "link.paid": true,
      "product.purchased": true,
      "agent_payment.pending_approval": true,
      "agent_payment.settled": true,
      "mandate.active": true,
      "mandate.charged": true,
      "mandate.charge_failed": true,
      "mandate.revoked": true,
      "subscription.renewed": true,
      "subscription.past_due": true,
    };

    expect(fromList).toBe("payment.confirmed");
    expect(Object.keys(coverage).sort()).toEqual([...GENESISPAY_EVENT_TYPES].sort());
  });

  it("lets a handler switch exhaustively and still see unhandled types", () => {
    const handled: string[] = [];
    const handle = (event: GenesisPayAnyEvent): string => {
      if (!isKnownGenesisPayEventType(event.type)) {
        handled.push(`unknown:${event.type}`);
        return "ignored";
      }
      const known = event as GenesisPayEvent;
      switch (known.type) {
        case "payment.confirmed":
        case "link.paid":
          return known.data.link.publicId;
        case "mandate.active":
        case "mandate.charged":
        case "mandate.charge_failed":
        case "mandate.revoked":
        case "subscription.renewed":
        case "subscription.past_due":
          return known.data.mandate.id;
        case "agent_payment.pending_approval":
        case "agent_payment.settled":
          return "agent";
      }
    };

    expect(
      handle({
        id: "e1",
        type: "invoice.finalized.v7",
        createdAt: "2026-07-21T10:00:00.000Z",
        data: {},
      }),
    ).toBe("ignored");
    expect(handled).toEqual(["unknown:invoice.finalized.v7"]);
  });
});
