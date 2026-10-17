/**
 * The catalog card's pictures (ADR-0113): bytes from the reader's optional
 * `productImages`, never fetched by this package. Best effort, like the full
 * server's product pictures (product-images.ts): at most three, one overall
 * deadline, each picture re-sniffed (raster only, never SVG) and bounded, and
 * any failure leaves pictures out — never the tool answer.
 */
import { sniffRasterImageType, type RasterImageMimeType } from "./app-card-shell.js";
import type { GenesisPayCatalogReader } from "./catalog-types.js";

const CATALOG_PICTURES_MAX = 3;
export const CATALOG_PICTURES_DEADLINE_MS = 3_000;
/**
 * Base64 characters per picture and per answer. claude.ai stops passing a
 * tool result inline past ~150,000 characters; the JSON text, its
 * `structuredContent` copy and these leave room under that. The image proxy
 * serves ≤ 320 px JPEG thumbnails (~11,000 characters).
 */
export const CATALOG_PICTURE_MAX_BASE64_CHARS = 24_000;
export const CATALOG_PICTURES_MAX_BASE64_CHARS = 48_000;

export type CatalogPicture = { mimeType: RasterImageMimeType; data: string };

function base64Length(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

async function readWithin(
  catalog: GenesisPayCatalogReader,
  ids: readonly string[],
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CATALOG_PICTURES_DEADLINE_MS);
  });
  const read = Promise.resolve()
    .then(() => catalog.productImages?.({ ids }) ?? null)
    .catch(() => null);
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The pictures of `requested` (the first three), by id, in request order. A
 * picture that is missing, late, not a raster image, labelled with another
 * type, or over a size bound is left out.
 */
export async function fetchCatalogPictures(
  catalog: GenesisPayCatalogReader,
  requested: readonly string[],
): Promise<Map<string, CatalogPicture>> {
  const pictures = new Map<string, CatalogPicture>();
  const ids = [...new Set(requested)].slice(0, CATALOG_PICTURES_MAX);
  if (!catalog.productImages || ids.length === 0) return pictures;

  const answer = await readWithin(catalog, ids);
  if (!Array.isArray(answer)) return pictures;

  let budget = CATALOG_PICTURES_MAX_BASE64_CHARS;
  for (const id of ids) {
    const image: unknown = answer.find((item: unknown) =>
      typeof item === "object" && item !== null && "id" in item && item.id === id);
    if (typeof image !== "object" || image === null || !("bytes" in image) || !("mimeType" in image)) continue;
    const { bytes, mimeType } = image;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) continue;
    const length = base64Length(bytes.byteLength);
    if (length > CATALOG_PICTURE_MAX_BASE64_CHARS || length > budget) continue;
    // Re-checked here, the last hop before a card renders it.
    const sniffed = sniffRasterImageType(bytes);
    if (!sniffed || sniffed !== mimeType) continue;
    budget -= length;
    pictures.set(id, { mimeType: sniffed, data: Buffer.from(bytes).toString("base64") });
  }
  return pictures;
}
