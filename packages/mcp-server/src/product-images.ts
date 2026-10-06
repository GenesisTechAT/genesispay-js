import { PRODUCT_IMAGE_MAX_BYTES, sniffProductImageType } from "@genesis-tech/genesispay-agent";
import type { DiscoveredQuoteProduct, DiscoveredService, ProductImage } from "@genesis-tech/genesispay-agent";

import type { ProductCardData } from "./product-card.js";
import type { GenesisPayAgentLike } from "./server.js";
import { PRODUCT_IMAGE_GUIDANCE } from "./tool-guidance.js";
import type { ToolContent } from "./tool-results.js";

/**
 * Product pictures as MCP `image` blocks (physical products, ADR-0108). The
 * bytes come only from GenesisPay's server-side image proxy (`productImage()`,
 * SSRF-guarded, raster types only); this package never fetches a seller URL.
 * Best effort: at most three per answer, one overall deadline, a bounded total
 * payload, and any failure simply leaves that picture out — never the tool.
 */
const PRODUCT_IMAGES_MAX_PER_RESULT = 3;
const PRODUCT_IMAGES_DEADLINE_MS = 3_000;
/**
 * Total base64 characters of all image blocks in one tool result. claude.ai
 * stops passing a tool result inline (and an MCP App never hydrates) past
 * ~150,000 characters; 100,000 leaves the rest for the JSON text and the
 * product card. The proxy serves ≤ 320 px JPEG thumbnails (~8 KB, ~11,000
 * characters), so three pictures fit with room to spare.
 */
const PRODUCT_IMAGES_MAX_BASE64_CHARS = 100_000;
/** One picture larger than this (an older proxy relaying originals) is skipped. */
const PRODUCT_IMAGE_MAX_BASE64_CHARS = 60_000;

/** The first quote-only results that have a picture, by product id. */
export function quoteProductsWithImages(listings: readonly DiscoveredService[]): string[] {
  return listings
    .filter((listing): listing is DiscoveredQuoteProduct => listing.purchase?.mode === "quote" && Boolean(listing.imageUrl))
    .slice(0, PRODUCT_IMAGES_MAX_PER_RESULT)
    .map((listing) => listing.purchase.productId);
}

type ProductImageBlock = { productId: string; data: string; mimeType: string };

/**
 * Appends the pictures to a JSON tool result, after its existing content (the
 * JSON stays first and unchanged), and says where each landed: the product
 * card finds a picture by that content index instead of a second copy.
 */
export function appendProductImages<Result extends { content: ToolContent[] }>(
  result: Result,
  images: readonly ProductImageBlock[],
): { result: Result; imageIndex: Map<string, number> } {
  const imageIndex = new Map<string, number>();
  if (images.length === 0) return { result, imageIndex };
  const content: ToolContent[] = [
    ...result.content,
    { type: "text" as const, text: `Product images follow, in this order: ${images.map((image) => image.productId).join(", ")}. ` +
      PRODUCT_IMAGE_GUIDANCE },
  ];
  for (const image of images) {
    imageIndex.set(image.productId, content.length);
    content.push({ type: "image" as const, data: image.data, mimeType: image.mimeType });
  }
  return { result: { ...result, content }, imageIndex };
}

/**
 * The product card's data (MCP Apps): `structuredContent` is the same payload
 * the JSON text carries, plus `productCard`. The same payload, because some
 * hosts hand `structuredContent` to the model instead of the text; never the
 * image bytes, which stay in their image blocks. No card, no
 * `structuredContent`: the answer is then exactly what it was before.
 */
export function withProductCard<Result extends { content: ToolContent[] }>(
  result: Result,
  payload: Record<string, unknown>,
  card: ProductCardData | null,
): Result & { structuredContent?: Record<string, unknown> } {
  if (!card) return result;
  return { ...result, structuredContent: { ...payload, productCard: card } };
}

/**
 * The quoted product's title and shop for its card: the quote answer names
 * neither. Read-only, best effort, under the image deadline; null on any
 * failure, a late answer or a listing that is not this quote-only product.
 */
export async function quoteProductDetails(
  agent: GenesisPayAgentLike,
  productId: string,
): Promise<{ title: string; shopName: string | null } | null> {
  if (!agent.describeService) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PRODUCT_IMAGES_DEADLINE_MS);
  });
  const lookup = agent.describeService(productId).then(({ listing }) =>
    listing?.purchase?.mode === "quote" && listing.id === productId && typeof listing.title === "string"
      ? { title: listing.title, shopName: listing.shop?.name ?? null }
      : null,
  ).catch(() => null);
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The pictures of `productIds` (at most three), fetched in parallel under one
 * deadline; a picture that fails, is late, is not a raster image or would push
 * the result past the payload bound is left out.
 */
export async function fetchProductImages(
  agent: GenesisPayAgentLike,
  requested: readonly string[],
): Promise<ProductImageBlock[]> {
  const productIds = requested.slice(0, PRODUCT_IMAGES_MAX_PER_RESULT);
  const productImage = agent.productImage?.bind(agent);
  if (!productImage || productIds.length === 0) return [];

  const arrived: Array<ProductImage | null> = productIds.map(() => null);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, PRODUCT_IMAGES_DEADLINE_MS);
  });
  let open = true;
  const all = Promise.all(productIds.map(async (productId, index) => {
    try {
      const image = await productImage(productId, { signal: controller.signal });
      if (open) arrived[index] = image;
    } catch {
      // No picture for this one; the tool answer stands without it.
    }
  }));
  await Promise.race([all, deadline]);
  open = false;
  clearTimeout(timer);
  controller.abort();

  const blocks: ProductImageBlock[] = [];
  let budget = PRODUCT_IMAGES_MAX_BASE64_CHARS;
  productIds.forEach((productId, index) => {
    const image = arrived[index];
    // Re-checked here, the last hop before the client renders it.
    if (!image || image.data.byteLength === 0 || image.data.byteLength > PRODUCT_IMAGE_MAX_BYTES) return;
    if (sniffProductImageType(image.data) !== image.mimeType) return;
    const data = Buffer.from(image.data).toString("base64");
    if (data.length > PRODUCT_IMAGE_MAX_BASE64_CHARS || data.length > budget) return;
    budget -= data.length;
    blocks.push({ productId, data, mimeType: image.mimeType });
  });
  return blocks;
}
