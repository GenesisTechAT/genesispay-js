# Changelog

## 1.7.0 — Server-issued purchase keys (prepared, not published)

- **Late-delivery signal** (MR-307 clarification 2026-10-04, additive): the v2
  pay response and `result()` may carry `lateDeliveryPending` /
  `lateDeliveryUntil`. `AgentPaymentResult` and every
  `GenesisPayPaymentOutcomeUnknownError` (unresolved, wait timeout) expose
  them from the pay response; `AgentStoredResult` has them as optional
  fields. False/absent promises nothing; a malformed value reads as absent.

Minor release, additive (MR-307 amendment 2026-10-03). Free-form keys keep
working; nothing changes for a caller that does not opt in. Needs a GenesisPay
deployment that issues purchase keys before `createPurchaseKey()` or
`requireIssuedKey` is used.

**Compatibility:** a free-form key that happens to start with `gpk1_` is
now treated as an issued key: on first use (no payment exists for it yet)
it is refused with `purchase_key_invalid`, and nothing is charged. Retries of
a payment that already exists under such a key are unaffected. Choose another
prefix for self-made keys.

- **`createPurchaseKey()`** → `POST /api/v2/agent/purchase-keys` (no input).
  Returns `{ purchaseKey, expiresAt }`: a `gpk1_…` key bound to this agent
  account, for ONE new purchase, first use within 24 h. The response is
  validated (`apiVersion: 2`, a `gpk1_` key of at most 200 visible ASCII
  characters, an ISO `expiresAt`); anything else is `invalid_response`. A
  deployment without the route answers `code: "purchase_keys_unavailable"`.
  It creates no payment and charges nothing.
- **`requireIssuedKey`** on `pay()` options and on `purchase()`'s options:
  sent only when `true` (an older deployment's strict purchase schema refuses
  the unknown field, and `false` means what omitting it means). GenesisPay
  then refuses a free-form key for a new purchase. Not part of the purchase's
  terms.
- **New 400 codes** `purchase_key_invalid`, `purchase_key_expired`,
  `purchase_key_required`, sent only when no payment exists for the key:
  `pay()` throws them as `GenesisPayPaymentRejectedError` (rejected before
  anything was signed), `purchase()` as `GenesisPayCommerceError` with the code
  kept (not rewritten to `commerce_purchase_failed`).
- A 503 `purchase_key_unavailable` (key admission cannot verify keys, before
  any row exists) is a pre-signing refusal on `pay()` and a no-charge refusal on
  `purchase()`. A bare 503 `service_unavailable` on those routes stays an
  unknown outcome (MR-306).
- New exports: `PURCHASE_KEY_ERROR_CODES`, `PURCHASE_KEY_UNAVAILABLE_CODE`, `ISSUED_PURCHASE_KEY_PREFIX`,
  `isIssuedPurchaseKey()`, `isPurchaseKeyErrorCode()`,
  `purchaseKeyResponseSchema`, and the types `PurchaseKey`,
  `PurchaseKeyErrorCode`.

## 1.6.0 — Physical products: quote first, saved shipping profile (prepared, not published)

Minor release. Wire-additive: it parses every response an older server
sends, and an older server ignores the new `include=quote` parameter. One
TypeScript-visible changes, stated here so nobody is surprised by them:
`DiscoveredService` becomes a union and its `resourceUrl` / `priceUsdc` are
optional on it (ADR-0108), and `AgentPaymentRecord.resourceUrl` is
`string | null` (null only for a commerce purchase's payment).

Discovery (ADR-0108 S6):

- `discover()` sends `include=quote` and returns quote-only physical products
  (a seller's WooCommerce product) beside payable listings. A quote-only
  product is the new `DiscoveredQuoteProduct`: `kind: "product"`,
  `purchase: { mode: "quote", productId, listedPriceUsdc, quoteUrl? }`, and no
  `resourceUrl`, `priceUsdc`, `method` or `serviceContract`. Payable listings
  are the new name `DiscoveredPayableService`, unchanged at runtime, plus the
  optional `source` (`genesispay` | `external` | string) and `purchase: {
  mode: "pay", resourceUrl, method, priceUsdc, asset }` a newer server sends.
  `DiscoveredService = DiscoveredPayableService | DiscoveredQuoteProduct`; new
  guards `isPayableListing()` / `isQuoteProduct()`. `discover(query, {
  includeQuote: false })` keeps the 1.5 request and payable-only result.
- Discovery entries are now parsed one by one. An entry the client cannot
  read safely is dropped instead of failing the whole search: a quote product
  that also carries `resourceUrl`, `priceUsdc` or `method`, a quote product
  whose `purchase.productId` is not its `id`, or a payable listing whose
  `purchase` hint names another URL, price, method or asset than the listing.
- `describeService(id)` returns the new `ServiceDescription` union: the 1.5
  `{ listing, contract }`, or `{ listing, contract: null, instructions }` for a
  quote-only product ("quote first").

Physical commerce (ADR-0108 S2/S3; nothing here orders, signs or pays):

- `quote({ productId, quantity })` → `POST /api/v1/agent/commerce/quotes`.
  Returns `CommerceQuote`: `quoteToken` (`gp_cq_…`), `expiresAt`, `shipTo`,
  `addressStatus` (`confirmed` | `new_requires_approval` | string) and
  `options[]` with exact decimal `subtotalUsdc`, `shippingUsdc`, `taxUsdc`,
  `totalUsdc`. MR-101: a quote whose option total is not the sum of its parts
  in integer minor units, or that repeats an option id, is `invalid_response`.
- `getShippingProfile()` / `setShippingProfile(profile)` →
  `GET` / `PUT /api/v1/agent/shipping-profile`. The client now also sends
  `PUT`. `setShippingProfile` refuses a structurally invalid profile before
  sending (`status: 0`), omits blank optional fields, and reads
  `confirmationRequired` as `true` whenever the status is not `confirmed`.
- New `GenesisPayCommerceError` (extends `GenesisPayApiError`) with `reason`
  (the closed `COMMERCE_REFUSAL_REASONS`, including `shipping_unavailable`,
  `merchant_plugin_outdated` and `shipping_profile_missing`; anything else
  reads as `null`), `instructions` and `issues`. A 403 `agent_not_active` on
  these routes is this class, not `GenesisPayPolicyBlockedError`; no status on
  them is ever a payment outcome. 401 stays `GenesisPayAuthError`; a
  deployment without the routes (a non-JSON 404) is `commerce_unavailable`.
- New exports: `commerceQuoteInputSchema`, `commerceQuoteSchema`,
  `commerceQuoteOptionSchema`, `commerceShipToSchema`,
  `commerceProductIdSchema`, `shippingProfileInputSchema`,
  `agentShippingProfileSchema`, `shippingProfileReadSchema`,
  `shippingProfileWriteSchema`, `commerceRefusalReason`, `usdcDecimalToMinor`
  and their types, plus `DiscoveryPurchase`, `DiscoverySource` and
  `GenesisPayFieldIssue`.

Buying a quote (ADR-0108 S5, MR-506):

- `purchase({ quoteToken, shippingOptionId, idempotencyKey,
  expectedTotalUsdc? }, { waitForOutcome? })` →
  `POST /api/v1/agent/commerce/purchases`. Orders and pays the quoted option
  in one call, to the owner's saved address, for exactly the sealed total;
  `expectedTotalUsdc` (the total the user confirmed, exactly as quoted) can
  only refuse. Same discipline as `pay()`: the key is required (trimmed,
  1–200 visible ASCII) and must be saved before the call; a retry with the
  identical input resumes and never orders or pays twice, other terms under
  the key are `idempotency_conflict`. Invalid input is refused before
  sending (`status: 0`, `invalid_request`).
- Returns `CommercePurchase`: `purchaseId`, `status`, `purchase` (product,
  shop, option, exact decimal amounts, `approvalReasons`), `order: {
  orderReference, shop: { name } } | null`, `totalUsdc`, `paymentId`,
  `payment`, `txHash`, `approvalUrl`, `statusUrl`, `code`, `reason`.
  `purchase()` returns three statuses: `settled`, `pending_approval` (a new
  address or a total over the caps; the owner approves in the dashboard at
  `approvalUrl`, nothing is ordered before that; never waited for) and
  `processing` (being ordered; retry with the same input).
- Everything else throws the existing classes: `GenesisPayCommerceError`
  (reason from the extended `COMMERCE_REFUSAL_REASONS`, e.g.
  `idempotency_conflict`, `commerce_quote_expired`, `shipping_address_changed`,
  `quote_changed`, `merchant_network_mismatch`, `commerce_purchase_denied`,
  `approval_expired`) only when the server said no payment exists;
  `GenesisPayPolicyBlockedError` for a hard block;
  `GenesisPayPaymentFailedError` for a failed payment;
  `GenesisPayUnresolvedPaymentError`, `GenesisPayOutcomeWaitTimeoutError` or
  `GenesisPayPaymentOutcomeUnknownError` whenever a charge cannot be ruled
  out — a lost connection, an unrecognised 5xx or state, or an envelope that
  names another key or option, a total above `expectedTotalUsdc`, or a
  payment above the authorized total, or an `idempotency_conflict` that names
  no purchase (the purchase's own payment step met a retained payment).
  `idempotency_conflict` / `commerce_quote_already_used` with a
  `purchaseId` name an earlier purchase that may itself be paid. A status
  check on the envelope refuses a `status` that contradicts its payment, and
  a payment that disappears during the wait is an unknown outcome. `agent_busy`,
  `commerce_purchase_unavailable` and the other configuration 503s are
  refusals, not unknown outcomes.
- `waitForOutcome` waits, bounded and read-only, through an accepted payment
  (`executing`, `approved`, `unresolved`) by polling `getPurchase()`.
- `getPurchase(purchaseId)` → `GET /api/v1/agent/commerce/purchases/:id`:
  read-only, returns every status as it is (including `failed`, `denied`,
  `expired`).
- A merchant's own order-refusal code never surfaces: `code` and
  `purchase.failureCode` outside GenesisPay's own codes read as
  `commerce_purchase_failed`.
- `GenesisPayApiError` gains `purchaseId` (null unless the error is about a
  commerce purchase); `GenesisPayCommerceError` accepts it.
- `AgentPaymentRecord.resourceUrl` is `string | null` (TypeScript-visible):
  the server never returns the shop order's own pay link, so a commerce
  purchase's payment — in `CommercePurchase.payment` and in
  `paymentStatus(paymentId)` — carries `null`. Every other payment keeps its
  URL; a record without the key is still refused.
- New exports: `commercePurchaseInputSchema`, `commercePurchaseEnvelopeSchema`,
  `commercePurchaseSummarySchema` and the types `CommercePurchase`,
  `CommercePurchaseInput`, `CommercePurchaseOptions`,
  `CommercePurchaseSummary`.

Product images (brief §6.6; additive):

- `productImage(productId, { signal? })` →
  `GET /api/v1/discovery/products/:id/image`: a quote-only product's picture
  as `{ mimeType, data: Uint8Array }`, or `null` when there is none to show
  (404, 413, 415 or 502 from the server, a body over 512 KiB, or bytes that
  are not JPEG, PNG, WebP or GIF). GenesisPay fetches the seller's image
  server-side under its SSRF guard and serves a JPEG thumbnail of at most
  320 px (about 8 KB), never the original; this client never fetches a seller URL and
  re-checks the bytes (the type comes from the magic bytes, never a header;
  SVG is never accepted). Throws only for an invalid id, 401, 429 or a
  network error. Needs a deployment serving the route; an older one answers
  404, which reads as `null`.
- New exports: `PRODUCT_IMAGE_MAX_BYTES`, `sniffProductImageType` and the
  types `ProductImage`, `ProductImageMimeType`, `ProductImageOptions`.

## 1.5.0 — GenesisPay buyer fee disclosure (published 2026-10-02)

Minor release (additive). It also carries the never-published 1.4.1 below.
Every new field is optional, so a response from an older GenesisPay server
still parses; the new `include` option needs a deployment that serves the
hint (ADR-0101 S5) and is refused by an older one.

Payer-paid GenesisPay fee on external x402 purchases (MR-1013, ADR-0101):

- `AgentPaymentRecord` gains optional `buyerFeeMinor` (the GenesisPay fee
  snapshotted at creation, paid ON TOP of `amountUsdcMinor`), `totalDebitMinor`
  (price plus the fee that is or will be charged) and `buyerFeeStatus` (new
  type `AgentBuyerFeeStatus`: `none`, `quoted`, `pending`, `collected`,
  `not_charged`, `waived`). The status is open: a value this version does not
  know still parses as its string. The two amounts must be integer minor-unit
  strings when present; a malformed one is an invalid response, never read as
  "no fee". `feeUsdcMinor` keeps meaning the seller-borne fee inside the
  amount ("0" on an external purchase). `maxAmount` / `maxAmountUsdc` stay the
  ceiling for the provider's price; the owner's caps and approval bind price
  plus fee.
- `discoverExternalServices({ q?, limit?, include? })` and
  `describeExternalService(id, { include? })`: `include: ["buyerFee"]` sends
  `?include=buyerFee`, and each service then carries an optional `buyerFee`
  `{ active, bps, minMinor, feeMinor, totalMinor }` (new
  `externalServiceBuyerFeeSchema` / `ExternalServiceBuyerFee`). The external
  service schema stays strict; it accepts `buyerFee` and refuses one whose
  `totalMinor` is not `priceHint.amountMinor + feeMinor`. Without `include`
  the request and response are unchanged. New exports
  `externalServiceIncludeSchema`, `externalServiceDiscoveryOptionsSchema`,
  `externalServiceDescribeOptionsSchema` and their types.
  `externalServiceQuerySchema` (the wire query) is unchanged.

Carried from 1.4.1 (never published) — protocol range:

- Raises the protocol dependency range to `^0.6.0`, matching the
  coordinated protocol candidate. No agent SDK source change: the agent SDK
  does not build settlement-preparation parameters; the server-side agent
  engine proposes the fee window.

## 1.4.0 — 2026-09-30 (additive)

Minor release. The first npm release after 1.2.0; it also carries the
never-published 1.3.0 entries below. The new read methods need a GenesisPay
deployment serving their routes (named per entry); against an older deployment
they fail with an API error. The existing payment methods are unchanged.

Pre-signing refusals (MR-306):

- Type the curated-service refusals `external_registry_unavailable` (503) and
  `external_service_quarantined` (422) as `GenesisPayPaymentRejectedError`:
  the server refuses both before contacting the service, so nothing was signed.
  A 503 `external_registry_unavailable` was previously reported as
  `GenesisPayPaymentOutcomeUnknownError` ("may already have been charged").
  `external_offer_not_pinned` (422, a live offer outside the curated pin) is a
  `GenesisPayPaymentRejectedError` by its status, as every 422 already was.

Curated external x402 services (ADR-0097):

- `discoverExternalServices({ q?, limit? })` and `describeExternalService(id)`
  read the separate curated external directory with dated unsigned-offer
  evidence (`evidence.kind: "unsigned_402"`, `purchaseTested: false`). No
  merchant verification or purchase authority. New exports
  `externalServiceIdSchema`, `externalServiceQuerySchema`,
  `externalServiceSchema`, `externalServicePageSchema`, `ExternalService` and
  `ExternalServiceQuery`.

Reviews:

- Read public reviews with `reviews(id, options)`, and optional `reviewSummary`
  in discovery/trending. Visible published opinions only; existing MR-607
  eligibility applies.
- Separate `prepareReview` / `publishReview` / `withdrawReview` commands. Exact
  draft publication requires separate review permission; never auto-publishes
  or purchases. Requires server-side review consent, purchase binding and
  moderation support (migrations 0158–0161).
- Target-aware purchase reviews for local products and selected external
  services: `reviewOpportunity(paymentId)` (a read-only eligibility hint with a
  3 s timeout; never pays, drafts or grants permission),
  `preparePurchaseReview` / `publishPurchaseReview` (opt into
  `representation: "target_v1"` on the existing review route) and
  `purchaseReviews(id, { limit, cursor })` for `prod_…` and `ext_…` ids. New
  exports `reviewOpportunitySchema`, `purchaseReviewsRequestSchema`,
  `reviewTargetSchema`, `preparedPurchaseReviewResponseSchema`,
  `publishedPurchaseReviewResponseSchema`, `ReviewOpportunity`,
  `PurchaseReviewTarget`, `PreparedPurchaseReview` and
  `PublishedPurchaseReview`. External purchases are bound prospectively
  (migration 0162); the legacy `prepareReview` / `publishReview` stay
  local-only with unchanged responses.

Discovery and results:

- Read advisory service contracts with `describeService(id)`. Current listing
  identity, target, method and visibility must match. No provider request or
  payment.
- Read stored JSON with `result(paymentId)` for seven days; payment status
  stays separate. Requires migration 0157.
- Optional `imageUrl` on discovery/trending, compatible with older servers.
- `shop` / `kind` discovery filters; the query may be empty for browsing.
- Recommendation guidance separates browsing from an authorized purchase.

## 1.3.0 — error text safe for hosted use (never published; shipped in 1.4.0)

No API change: types, method signatures, error classes and `code`s are
unchanged; only two messages are reworded. Minor rather than patch so the
version lines up with `@genesis-tech/genesispay-mcp` 1.3.0, which depends on
`^1.3.0` and serves the same SDK behind the hosted remote-MCP endpoint.

- A transport failure no longer embeds the base URL: `network_error` reads
  `Failed to reach GenesisPay: <cause>` and the unknown-outcome message
  `Lost the connection to GenesisPay while the payment was in flight: …`.
  Behind a hosted MCP endpoint the base URL is the server's own loopback
  origin, and the message reaches the chat model and its provider verbatim.
- A `401` (`GenesisPayAuthError`) now appends credential-neutral guidance —
  "The agent credential was rejected or revoked; reconnect the assistant or
  check the agent key." — instead of naming `gp_ag_…` and
  `GENESISPAY_AGENT_KEY`, which were wrong for a web chat connected through
  OAuth. The server's own message is still prefixed, unchanged. The missing-key
  constructor error still names `GENESISPAY_AGENT_KEY`, where it is correct.

## 1.2.0 — `trending()` (additive; published 2026-09-25)

Needs a GenesisPay deployment serving `GET /api/v1/discovery/trending`.

- `trending(options?)` reads what is trending on GenesisPay: listed products
  ranked by distinct buyers of paid orders in the last 7 days (coarse bands,
  self-payments excluded), newest listed after them. Option
  `limit` (server default 10, max 20). Returns `TrendingProduct[]` with `rank`,
  `id`, `title`, `description`, `asset`, `priceMinor` (integer minor units as a
  decimal string), `priceUsdc`, `method`, `resourceUrl`, `category`, `shop` and
  `signal` (`"sales"` | `"new"`, open for future values). Entries are parsed one
  by one; a malformed entry (no id, price, URL or a non-integer `priceMinor`) is
  dropped rather than failing the read.
- New exported types `TrendingProduct` and `TrendingOptions`.

## 1.1.0 — POST purchases and a bounded outcome wait (additive; published 2026-09-25)

1.0.0 was never published, so this is the first 1.x release on npm and also
carries the 1.0.0 entries below. Needs a GenesisPay deployment serving
`/api/v2/agent/pay`; POST purchases need one that echoes `requestMethod` and
`bodySha256`.

- `PayOptions.method` (`"GET"` default, `"POST"`), `body` (the exact JSON text,
  at most 256 KiB of UTF-8, never re-serialized) and `contentType`
  (`"application/json"` only). The body is part of the purchase identity: the
  same key with a different or reformatted body is `idempotency_conflict`. No
  `json:` helper on purpose. Invalid combinations, non-JSON, lone surrogates and
  oversized bodies throw `GenesisPayPaymentRejectedError` before anything is
  sent. New export `PURCHASE_BODY_MAX_BYTES`.
- Echo check: a POST result is trusted only when the v2 envelope echoes
  `requestMethod: "POST"` and a `bodySha256` equal to the locally computed
  (WebCrypto) hash. A missing or different echo — an older server drops the
  fields and buys with GET — throws `GenesisPayPaymentOutcomeUnknownError` with
  the payment locator and key. `AgentPaymentResult` gains `requestMethod` and
  `bodySha256`.
- `PayOptions.waitForOutcome` (`true` or `{ timeoutMs, pollIntervalMs }`, default
  off; defaults 30 s / 2 s doubling to 10 s): waits read-only through
  `unresolved`, `approved` and `executing` until `settled` or a terminal
  status. Never calls `executePayment()`. Running out of budget throws the new
  `GenesisPayOutcomeWaitTimeoutError` (a `GenesisPayPaymentOutcomeUnknownError`
  with `waitedMs`), never `GenesisPayPaymentFailedError`. `waitForApproval` is
  unchanged.
- Discovery listings parse the additive `id`, `method`, `asset` and `shop`
  (`{ id, name, storefrontUrl: string | null }` or null) fields; a malformed additive field
  reads as absent instead of failing the search. New types `PurchaseMethod`,
  `PurchaseContentType`, `DiscoveredShopRef`, `DiscoveredShop`, `ShopsOptions`,
  `WaitForOutcomeOptions`.
- `shops(query?, { limit })` reads `GET /api/v1/discovery/shops`
  (`{ shops: [{ id, name, description, storefrontUrl, category, productCount }] }`);
  entries are parsed one by one and malformed ones dropped.
- Raise the protocol dependency range to `^0.5.0`, matching the coordinated
  protocol candidate. No agent SDK source change; the agent SDK does not send
  the new settlement-preparation params header yet.
- README: state the setup prerequisites (a deployment serving `/api/v2/agent/pay`, SDK 1.0 or later) instead of release-pending wording; document POST purchases, the echo check and `waitForOutcome`.

## 1.0.0 — strict agent payment requests (breaking; never published, shipped in 1.1.0)

- Require callers to generate and persist an idempotency key before first send.
- Use `/api/v2/agent/pay` with no v1 fallback. Matching retries recover the original payment; changed or historical terms raise `idempotency_conflict`.
- Preserve the original payment locator and key on ambiguous outcomes. Settled replays have an explicit null resource capture and never fetch or sign again.
- Deploy v2 before upgrading clients; legacy v1 remains available.

## 0.2.1

### Fixed

- Align the published protocol dependency with `@genesis-tech/genesispay-protocol`
  0.4.0 so clean workspace installs resolve the same authority registry version
  used by the seller SDK. The agent SDK API and payment behaviour are unchanged.

## 0.2.0 — BREAKING: every identifier is now `genesispay`

The legacy/visible name split is retired. This release renames the
public surface with **no compatibility window** — the old names are not accepted
alongside the new ones. Update all of the following at once:

- `PeerPayAgent` → `GenesisPayAgent`; every `PeerPay*Error` → `GenesisPay*Error`.
- Agent API keys now use the `gp_ag_` prefix; `pp_ag_` keys are rejected and
  must be reissued.
- `PEERPAY_AGENT_KEY` / `PEERPAY_BASE_URL` → `GENESISPAY_AGENT_KEY` /
  `GENESISPAY_BASE_URL`. Update your MCP client config, not just your code.

There is no functional change in this release. It is a rename.

## 0.1.0

First release. Published as `@genesis-tech/genesispay-agent` — the legacy
`genesispay-agent` name was versioned in-repo but never published, so this is the
only name this package has ever had on npm (ADR-0044).

### Added

- `pay(url, options)` — pay an x402-gated URL from an agent wallet, with
  `maxAmount` as a caller-side ceiling and `waitForApproval` to poll a payment
  that needs a human decision.
- `discover`, `paymentStatus`, `executePayment`, `account`.
- `idempotencyKey` on `PayOptions`. **Pass one on every call.** It is what makes
  a retry the same payment rather than a second purchase: the server refuses a
  duplicate key, and the on-chain nonce is derived from it, so even a
  re-execution cannot settle twice.

### Safety

- **`failed` means no money moved; `GenesisPayPaymentOutcomeUnknownError` means we
  do not know.** Every path that cannot rule out a charge raises the second —
  a dropped connection during `pay()`/`executePayment()`, a 5xx with no
  recognised envelope, a `waitForApproval` timeout on a payment already
  executing, and a server `unresolved` envelope. Retry those **only** with the
  same `idempotencyKey`.
- A rejection the server made *before* signing anything (a bad or unreachable
  URL, a free resource, an amount over your ceiling, a busy agent) is a
  `GenesisPayPaymentRejectedError`, never an unknown outcome — including when its
  status is 5xx, because `target_unreachable` and `agent_busy` are.
- Every error extends `GenesisPayApiError`, so one `instanceof` is exhaustive, and
  every subclass sets a `code`.
- The payment status is an **open** union: a status this version predates is
  treated as unknown-outcome rather than throwing, so an old client can still
  read the payment it most needs to see.
- Money amounts are decimal **strings**, never numbers — `0.1 + 0.2` does not
  round-trip through a payments API.
- v1 settles in **USDC on Base**.
