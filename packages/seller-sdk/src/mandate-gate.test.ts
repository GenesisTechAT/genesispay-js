import { describe, expect, it, vi } from "vitest";

import { createMandateGate, MANDATE_HEADER } from "./mandate-gate.js";

const baseOptions = {
  amount: "0.08",
  baseUrl: "https://genesispay.example/",
  apiKey: "gp_sk_test",
};

function chargeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createMandateGate", () => {
  it("returns 402 with instructions when no mandate header is present", async () => {
    const fetchFn = vi.fn();
    const gate = createMandateGate({ ...baseOptions, fetchFn });
    const handler = vi.fn();

    const response = await gate.wrap(handler)(
      new Request("https://api.example/forecast"),
    );

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.howToPay).toContain(MANDATE_HEADER);
    expect(handler).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("charges the mandate and runs the handler on success", async () => {
    const txHash = `0x${"a".repeat(64)}`;
    const fetchFn = vi.fn().mockResolvedValue(
      chargeResponse(200, {
        charge: {
          id: "c1",
          status: "settled",
          amountMinor: "80000",
          txHash,
        },
      }),
    );
    const gate = createMandateGate({ ...baseOptions, fetchFn });
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ forecast: [1, 2, 3] }), { status: 200 }),
    );

    const request = new Request("https://api.example/forecast", {
      headers: {
        [MANDATE_HEADER]: "mandate-1",
        "Idempotency-Key": "usage-request-123",
      },
    });
    const response = await gate.wrap(handler)(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("GENESISPAY-MANDATE-CHARGE")).toBe("c1");
    expect(handler).toHaveBeenCalledTimes(1);

    const [chargeUrl, chargeInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(chargeUrl).toBe("https://genesispay.example/api/v1/mandates/mandate-1/charge");
    expect(chargeInit.headers).toMatchObject({
      Authorization: "Bearer gp_sk_test",
      "Idempotency-Key": "usage-request-123",
    });
    expect(JSON.parse(chargeInit.body as string)).toMatchObject({ amount: "0.08" });
  });

  it.each([
    ["missing charge", {}],
    [
      "submitted charge",
      {
        charge: {
          id: "c-submitted",
          status: "submitted",
          amountMinor: "80000",
          txHash: `0x${"b".repeat(64)}`,
        },
      },
    ],
    [
      "settled charge without a hash",
      {
        charge: {
          id: "c-no-hash",
          status: "settled",
          amountMinor: "80000",
          txHash: null,
        },
      },
    ],
    [
      "settled charge for a different amount",
      {
        charge: {
          id: "c-wrong-amount",
          status: "settled",
          amountMinor: "80001",
          txHash: `0x${"c".repeat(64)}`,
        },
      },
    ],
  ])(
    "MR-202/MR-406: fails closed on a 2xx %s response",
    async (_label, body) => {
      const fetchFn = vi.fn().mockResolvedValue(chargeResponse(200, body));
      const gate = createMandateGate({ ...baseOptions, fetchFn });
      const handler = vi.fn();

      const response = await gate.wrap(handler)(new Request(
        "https://api.example/forecast",
        {
          headers: {
            [MANDATE_HEADER]: "mandate-1",
            "Idempotency-Key": "usage-request-123",
          },
        },
      ));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "charge_response_unverified",
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("does not run the handler when the charge fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      chargeResponse(402, {
        error: "The mandate's on-chain allowance is exhausted.",
        code: "allowance_exhausted",
      }),
    );
    const gate = createMandateGate({ ...baseOptions, fetchFn });
    const handler = vi.fn();

    const request = new Request("https://api.example/forecast", {
      headers: {
        [MANDATE_HEADER]: "mandate-1",
        "Idempotency-Key": "usage-request-123",
      },
    });
    const response = await gate.wrap(handler)(request);

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.code).toBe("allowance_exhausted");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    [409, "idempotency_conflict"],
    [429, "rate_limit_exceeded"],
  ])(
    "MR-202/MR-404/MR-406: preserves upstream %i instead of inviting a new charge",
    async (status, code) => {
      const fetchFn = vi.fn().mockResolvedValue(
        chargeResponse(status, {
          error: "The mandate charge was rejected.",
          code,
        }),
      );
      const gate = createMandateGate({ ...baseOptions, fetchFn });
      const handler = vi.fn();

      const response = await gate.wrap(handler)(new Request(
        "https://api.example/forecast",
        {
          headers: {
            [MANDATE_HEADER]: "mandate-1",
            "Idempotency-Key": "usage-request-123",
          },
        },
      ));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ code });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("keeps unreachable GenesisPay outcome-unknown as 503, never a re-chargeable 402", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const gate = createMandateGate({ ...baseOptions, fetchFn });

    const request = new Request("https://api.example/forecast", {
      headers: {
        [MANDATE_HEADER]: "mandate-1",
        "Idempotency-Key": "usage-request-123",
      },
    });
    const response = await gate.wrap(vi.fn())(request);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("unreachable");
  });

  it("MR-202/MR-406/MR-1106: preserves a submitted locator and never opens the resource", async () => {
    const txHash = `0x${"6".repeat(64)}`;
    const fetchFn = vi.fn().mockResolvedValue(
      chargeResponse(503, {
        error: "The charge is awaiting confirmation.",
        code: "charge_submitted_awaiting_confirmation",
        charge: { id: "c-unknown", amountMinor: "80000", txHash },
      }),
    );
    const gate = createMandateGate({ ...baseOptions, fetchFn });
    const handler = vi.fn();

    const response = await gate.wrap(handler)(new Request(
      "https://api.example/forecast",
      {
        headers: {
          [MANDATE_HEADER]: "mandate-1",
          "Idempotency-Key": "usage-request-123",
        },
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "charge_submitted_awaiting_confirmation",
      charge: { id: "c-unknown", amountMinor: "80000", txHash },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("MR-404/MR-406: requires the caller's stable key before charging", async () => {
    const fetchFn = vi.fn();
    const gate = createMandateGate({ ...baseOptions, fetchFn });

    const response = await gate.wrap(vi.fn())(new Request(
      "https://api.example/forecast",
      { headers: { [MANDATE_HEADER]: "mandate-1" } },
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_idempotency_key",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("MR-404/MR-406: rejects a stringified undefined key before opening or charging", async () => {
    const fetchFn = vi.fn();
    const gate = createMandateGate({ ...baseOptions, fetchFn });
    const handler = vi.fn();

    const response = await gate.wrap(handler)(new Request(
      "https://api.example/forecast",
      {
        headers: {
          [MANDATE_HEADER]: "mandate-1",
          "Idempotency-Key": undefined as unknown as string,
        },
      },
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_idempotency_key",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates constructor inputs", () => {
    expect(() => createMandateGate({ ...baseOptions, apiKey: "" })).toThrow(/API key/);
    expect(() => createMandateGate({ ...baseOptions, amount: "abc" })).toThrow(
      /decimal amount/,
    );
  });
});
