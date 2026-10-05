/**
 * A physical product's picture through GenesisPay's image proxy
 * (`GET /api/v1/discovery/products/:id/image`), for clients that show images
 * (an MCP `image` content block). GenesisPay fetches the seller's image
 * server-side under its SSRF guard and relays only JPEG, PNG, WebP or GIF;
 * this module re-checks the bytes anyway, because a client that renders them
 * should not have to trust any one hop.
 *
 * The image is seller content: a picture to show the user, never
 * instructions, never proof of what will be delivered.
 */

/** The largest image the proxy relays (and this client accepts). */
export const PRODUCT_IMAGE_MAX_BYTES = 512 * 1024;

export type ProductImageMimeType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type ProductImage = {
  /** From the image's own bytes, never from a header. */
  mimeType: ProductImageMimeType;
  data: Uint8Array;
};

export type ProductImageOptions = {
  /** Aborts the request (for example a caller's overall time budget). */
  signal?: AbortSignal;
};

/**
 * Statuses that mean "no image to show", never an error: no such product or
 * no image (404, also an older server without the proxy), too large (413),
 * not a raster image (415), the seller's host could not be fetched (502).
 */
export const PRODUCT_IMAGE_ABSENT_STATUSES: ReadonlySet<number> = new Set([404, 413, 415, 502]);

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/** The raster type of `bytes` by magic number; null for anything else (SVG included). */
export function sniffProductImageType(bytes: Uint8Array): ProductImageMimeType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** The body, or null once it exceeds `maxBytes` (the rest is cancelled, not read). */
export async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
