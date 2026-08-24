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
    const fetchFn = vi.fn().mockResolvedValue(
      chargeResponse(200, {
        charge: { id: "c1", amountMinor: "80000", txHash: "0xabc" },
      }),
    );
    const gate = createMandateGate({ ...baseOptions, fetchFn });
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ forecast: [1, 2, 3] }), { status: 200 }),
    );

    const request = new Request("https://api.example/forecast", {
      headers: { [MANDATE_HEADER]: "mandate-1" },
    });
    const response = await gate.wrap(handler)(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("GENESISPAY-MANDATE-CHARGE")).toBe("c1");
    expect(handler).toHaveBeenCalledTimes(1);

    const [chargeUrl, chargeInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(chargeUrl).toBe("https://genesispay.example/api/v1/mandates/mandate-1/charge");
    expect(chargeInit.headers).toMatchObject({
      Authorization: "Bearer gp_sk_test",
    });
    expect(JSON.parse(chargeInit.body as string)).toMatchObject({ amount: "0.08" });
  });

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
      headers: { [MANDATE_HEADER]: "mandate-1" },
    });
    const response = await gate.wrap(handler)(request);

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.code).toBe("allowance_exhausted");
    expect(handler).not.toHaveBeenCalled();
  });

  it("maps unreachable GenesisPay to a 402 with a clear error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const gate = createMandateGate({ ...baseOptions, fetchFn });

    const request = new Request("https://api.example/forecast", {
      headers: { [MANDATE_HEADER]: "mandate-1" },
    });
    const response = await gate.wrap(vi.fn())(request);

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toContain("unreachable");
  });

  it("validates constructor inputs", () => {
    expect(() => createMandateGate({ ...baseOptions, apiKey: "" })).toThrow(/API key/);
    expect(() => createMandateGate({ ...baseOptions, amount: "abc" })).toThrow(
      /decimal amount/,
    );
  });
});
