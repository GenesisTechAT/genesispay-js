import { describe, expect, it, vi } from "vitest";

import { GenesisPayConfigError } from "./errors.js";
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

  it("#976: the unauthenticated caller's 503 never carries the transport error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(
      new TypeError("Request cannot be constructed from a URL that includes credentials: https://alice:s3cret@x"),
    );
    const gate = createMandateGate({ ...baseOptions, fetchFn });
    const handler = vi.fn();

    const response = await gate.wrap(handler)(new Request("https://api.example/forecast", {
      headers: { [MANDATE_HEADER]: "mandate-1", "Idempotency-Key": "usage-request-976" },
    }));

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toMatch(/s3cret|alice|credentials/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("#976: refuses an https baseUrl with userinfo without echoing it", () => {
    for (const baseUrl of ["https://alice:s3cret@genesispay.example", "https://\\alice:s3cret@genesispay.example"]) {
      let message = "";
      try {
        createMandateGate({ ...baseOptions, baseUrl });
      } catch (error) {
        expect(error).toBeInstanceOf(GenesisPayConfigError);
        message = String(error);
      }
      expect(message, baseUrl).toMatch(/baseUrl/);
      expect(message, baseUrl).not.toMatch(/s3cret|alice/);
    }
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

  it("#947: refuses a plain-http baseUrl off this machine before any charge carries the key", () => {
    const fetchFn = vi.fn();
    for (const baseUrl of [
      "http://genesispay.example",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://localhost@evil.example",
      "ftp://genesispay.example",
    ]) {
      expect(() => createMandateGate({ ...baseOptions, baseUrl, fetchFn })).toThrow(GenesisPayConfigError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("#947: charges over https or loopback http", async () => {
    for (const origin of ["https://genesispay.example", "http://localhost:3000", "http://127.0.0.1:3000"]) {
      const fetchFn = vi.fn(async () => chargeResponse(500, { error: "x" }));
      await createMandateGate({ ...baseOptions, baseUrl: `${origin}/`, fetchFn }).charge("mdt_1", undefined, "usage-request-123");
      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${origin}/api/v1/mandates/mdt_1/charge`);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gp_sk_test");
    }
  });

  it("#947: does not echo credentials from a refused baseUrl", () => {
    expect(() => createMandateGate({ ...baseOptions, baseUrl: "http://user:s3cret@genesispay.example/x?token=t0ken" }))
      .toThrow(/must be https/);
    try {
      createMandateGate({ ...baseOptions, baseUrl: "http://user:s3cret@genesispay.example/x?token=t0ken" });
    } catch (error) {
      expect(String(error)).not.toMatch(/s3cret|t0ken|user:/);
    }
  });

  it("validates constructor inputs", () => {
    expect(() => createMandateGate({ ...baseOptions, apiKey: "" })).toThrow(/API key/);
    expect(() => createMandateGate({ ...baseOptions, amount: "abc" })).toThrow(
      /decimal amount/,
    );
  });
});
