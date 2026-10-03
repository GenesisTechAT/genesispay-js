import { describe, expect, it, vi } from "vitest";

import { GenesisPayAgent } from "./client.js";
import { GenesisPayApiError, GenesisPayAuthError } from "./errors.js";
import { PRODUCT_IMAGE_MAX_BYTES, sniffProductImageType } from "./product-image.js";

const BASE_URL = "https://genesispay.example";
const PRODUCT = "prod_0kQkjzgoRSCRm3f3";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const text = (value: string) => new TextEncoder().encode(value);

function agentWith(response: Response | Error) {
  const fetchFn = vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { agent: new GenesisPayAgent({ apiKey: "gp_ag_test", baseUrl: BASE_URL, fetchFn }), fetchFn };
}

describe("productImage()", () => {
  it("reads the proxy with the agent credential and returns the bytes with their sniffed type", async () => {
    const { agent, fetchFn } = agentWith(new Response(PNG, { headers: { "content-type": "image/png" } }));
    expect(await agent.productImage(PRODUCT)).toEqual({ mimeType: "image/png", data: PNG });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/api/v1/discovery/products/${PRODUCT}/image`);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer gp_ag_test");
  });

  it.each([404, 413, 415, 502])("returns null, never throws, for a %s (no image to show)", async (status) => {
    const { agent } = agentWith(Response.json({ error: "No image.", code: "product_image_not_found" }, { status }));
    expect(await agent.productImage(PRODUCT)).toBeNull();
  });

  it("returns null for bytes that are not a raster image, whatever the header claims", async () => {
    for (const body of ['<svg xmlns="http://www.w3.org/2000/svg"/>', "<html></html>", ""]) {
      const { agent } = agentWith(new Response(text(body), { headers: { "content-type": "image/png" } }));
      expect(await agent.productImage(PRODUCT)).toBeNull();
    }
  });

  it("returns null for a body over 512 KiB, by declared length or by the bytes read", async () => {
    const big = new Uint8Array(PRODUCT_IMAGE_MAX_BYTES + 1);
    big.set(PNG);
    const declared = agentWith(new Response(big, { headers: { "content-length": String(big.byteLength) } }));
    expect(await declared.agent.productImage(PRODUCT)).toBeNull();

    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.subarray(0, PRODUCT_IMAGE_MAX_BYTES));
        controller.enqueue(big.subarray(PRODUCT_IMAGE_MAX_BYTES));
        controller.close();
      },
    });
    const undeclared = agentWith(new Response(streamed));
    expect(await undeclared.agent.productImage(PRODUCT)).toBeNull();
  });

  it("refuses a non-product id before any request", async () => {
    const { agent, fetchFn } = agentWith(new Response(PNG));
    await expect(agent.productImage("https://evil.example/x.png")).rejects.toBeInstanceOf(GenesisPayApiError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws for a rejected credential, a rate limit or a network error", async () => {
    await expect(agentWith(Response.json({ error: "Invalid key.", code: "agent_key_invalid" }, { status: 401 }))
      .agent.productImage(PRODUCT)).rejects.toBeInstanceOf(GenesisPayAuthError);
    await expect(agentWith(Response.json({ error: "Slow down.", code: "rate_limited" }, { status: 429 }))
      .agent.productImage(PRODUCT)).rejects.toMatchObject({ status: 429 });
    await expect(agentWith(new TypeError("fetch failed")).agent.productImage(PRODUCT))
      .rejects.toMatchObject({ code: "network_error" });
  });

  it("turns a stream that breaks mid-body into a network_error, never a raw error", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG);
        controller.error(new TypeError("terminated"));
      },
    });
    const { agent } = agentWith(new Response(broken));
    const error = await agent.productImage(PRODUCT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenesisPayApiError);
    expect(error).toMatchObject({ code: "network_error", status: 0 });
  });
});

describe("sniffProductImageType", () => {
  it("knows JPEG, PNG, WebP and GIF and nothing else", () => {
    expect(sniffProductImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(sniffProductImageType(PNG)).toBe("image/png");
    expect(sniffProductImageType(text("GIF89a.."))).toBe("image/gif");
    expect(sniffProductImageType(new Uint8Array([...text("RIFF"), 1, 0, 0, 0, ...text("WEBP")]))).toBe("image/webp");
    expect(sniffProductImageType(text("<svg/>"))).toBeNull();
  });
});
