# Changelog

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
