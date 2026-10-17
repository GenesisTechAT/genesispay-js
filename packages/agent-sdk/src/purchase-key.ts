import { z } from "zod";

/**
 * Server-issued purchase keys (MR-307 amendment 2026-10-03).
 *
 * A model asked to invent a "random" idempotency key repeats itself across
 * chats, and a repeated key with identical terms replays an old payment
 * instead of buying. `createPurchaseKey()` asks GenesisPay for a key it minted
 * (`gpk1_…`, bound to this agent account, first use within 24 h); a caller
 * that sends `requireIssuedKey: true` has a free-form key refused before
 * anything is created.
 *
 * The key stays an ordinary `idempotencyKey`: save it with the purchase terms
 * BEFORE paying and reuse it on every retry of that purchase. A retry is never
 * refused for the key's age — once a payment exists for it, the key replays.
 */

/** Prefix of a GenesisPay-issued purchase key. */
export const ISSUED_PURCHASE_KEY_PREFIX = "gpk1_";

/**
 * Codes GenesisPay answers (HTTP 400) when it refuses a purchase key. Each is
 * only sent when NO payment or purchase exists for the key, so nothing was
 * signed or charged: get a fresh key with `createPurchaseKey()`.
 *
 * - `purchase_key_invalid`: a `gpk1_` key that is not GenesisPay's, was changed,
 *   or belongs to another agent account.
 * - `purchase_key_expired`: a `gpk1_` key first used more than 24 h after it was issued.
 * - `purchase_key_required`: a free-form key on a request with `requireIssuedKey: true`.
 */
export const PURCHASE_KEY_ERROR_CODES = ["purchase_key_invalid", "purchase_key_expired", "purchase_key_required"] as const;
export type PurchaseKeyErrorCode = (typeof PURCHASE_KEY_ERROR_CODES)[number];

const PURCHASE_KEY_CODES: ReadonlySet<string> = new Set(PURCHASE_KEY_ERROR_CODES);

/**
 * A dedicated 503 code for "GenesisPay cannot verify purchase keys right now",
 * sent by key admission before any payment or purchase row exists: nothing was
 * signed or charged, and a later retry with the SAME key is safe.
 *
 * Only THIS code is read as "nothing charged". A bare 503 `service_unavailable`
 * on a money route stays an unknown outcome (MR-306): the generic code can come
 * from anywhere in a handler, including after signing.
 */
export const PURCHASE_KEY_UNAVAILABLE_CODE = "purchase_key_unavailable";

export function isPurchaseKeyErrorCode(code: string | null | undefined): code is PurchaseKeyErrorCode {
  return typeof code === "string" && PURCHASE_KEY_CODES.has(code);
}

/** True for a key GenesisPay issued (`gpk1_…`); says nothing about whether it is still valid. */
export function isIssuedPurchaseKey(key: string): boolean {
  return key.startsWith(ISSUED_PURCHASE_KEY_PREFIX);
}

/**
 * `POST /api/v2/agent/purchase-keys`. The key must fit both purchase forms'
 * key rules (`pay()`: at most 200 characters; `purchase()`: visible ASCII),
 * so a key that does not is refused here rather than at the purchase.
 */
export const purchaseKeyResponseSchema = z.object({
  apiVersion: z.literal(2),
  purchaseKey: z.string().max(200).regex(/^gpk1_[\x21-\x7e]+$/),
  expiresAt: z.iso.datetime({ offset: true }),
});

/** A purchase key from `createPurchaseKey()`. */
export type PurchaseKey = {
  /** Pass as `idempotencyKey` to `pay()` or `purchase()`, unchanged. */
  purchaseKey: string;
  /**
   * ISO 8601. The key must be FIRST used before this; a retry of a purchase
   * already made with it keeps working after it.
   */
  expiresAt: string;
};
