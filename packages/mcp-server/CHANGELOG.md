# Changelog

## 1.7.0 — Purchase keys from GenesisPay, not from the model (prepared, not published)

Minor release (one additive tool; changed guidance). Requires
`@genesis-tech/genesispay-agent` `^1.7.0` and a GenesisPay deployment that
issues purchase keys (`POST /api/v2/agent/purchase-keys`, MR-307 amendment
2026-10-03) — deploy that server first. Seventeen tools.

Why: the pay tool told the model to invent `<purpose>-<yyyymmdd>-<6 random
chars>`. Models are not random: a repeated task in a new chat produced a key
identical to one from hours earlier, and since keys are scoped per agent
account across every chat, the purchase replayed the old payment (or answered
`idempotency_conflict`) instead of buying.

**Compatibility:** a free-form key that happens to start with `gpk1_` is
now treated as an issued key: on first use (no payment exists for it yet)
it is refused with `purchase_key_invalid`, and nothing is charged. Retries of
a payment that already exists under such a key are unaffected. Choose another
prefix for self-made keys.

- **New `genesispay_purchase_key`** (`readOnlyHint`, no input): returns
  `{ purchaseKey, expiresAt, instructions }` — write the key with the purchase
  terms into the reply before paying, reuse it on every retry of THIS purchase,
  get a new one only for a new purchase. Charges nothing.
- **The invented-key convention is gone** from `genesispay_pay` (description
  and `idempotencyKey` field) and from the quote answer's purchase step:
  "BEFORE a new purchase, call genesispay_purchase_key". Discovery `nextStep`s
  (GenesisPay sellers and external providers with a `buyerFee`), the
  discovery, trending and describe-service instructions and every "buy with a
  new key" guidance now point at `genesispay_purchase_key`.
- **`genesispay_pay` always sends `requireIssuedKey: true`**, in the URL form
  and the quote form.
- **Guidance for the new 400s** `purchase_key_invalid`, `purchase_key_expired`,
  `purchase_key_required`: `outcome: "not_charged"`, get a key from
  `genesispay_purchase_key` — but first check whether an earlier call in this
  conversation already used a key for this purchase.
- **Keys unavailable**: a 503 `purchase_key_unavailable` from either pay form
  answers `outcome: "not_charged"`: GenesisPay cannot verify purchase keys
  right now, retry later with the same key, never invent one. A failed
  `genesispay_purchase_key` also answers `outcome: "not_charged"`, but since no
  key exists yet it never says "the same key": a 5xx says to call
  `genesispay_purchase_key` again later; `purchase_keys_unavailable` (an agent
  SDK without `createPurchaseKey`, or a deployment without the route) says
  purchases are unavailable until it is updated. Neither invents a key or pays
  without one.
- **`idempotency_conflict` (URL form) splits by key**: a `gpk1_` key is the
  conversation's own earlier call — resend its exact terms, a new key only if
  the user confirms a new purchase. Any other key answers with
  `payment: { createdAt, description }` and the original decides: older than
  15 minutes, terminal (`settled`, `failed`, `denied`, `expired`) and without
  approval history is a collision with an older purchase — nothing was bought
  now, get a purchase key and buy with the user's go-ahead; recent is most
  likely the conversation's own call — resend its exact terms. Anything else
  (a pending, approved, executing or unresolved original, one that went
  through approval, or no readable `createdAt`) gets the conditional text that
  asks the model to compare, so an in-flight purchase of this conversation is
  never called a collision (MR-306).
- **Stale replays**: a key that returns a `settled` or `failed` purchase
  created more than 15 minutes ago answers `outcome: "earlier_purchase"`. The
  guidance leads with the retry case — "If you were retrying this purchase,
  this is its outcome — do not buy again" (a failed one: it failed, nothing
  charged) — and only then says that if the user asked for a new purchase now,
  it was NOT bought (URL form and quote form). A payment or quote purchase with
  approval history (`approvalExpiresAt` or `resolvedAt` on the payment;
  `approvalReasons` or `approvalExpiresAt` on the purchase) is never labelled
  `earlier_purchase`: its age is the owner's wait, so a late approval followed
  by a same-chat retry reads as that purchase's outcome (MR-503). Pending,
  approved, executing and unresolved replays keep "do not buy again" unchanged
  (MR-306).
- **Late delivery** (MR-307 clarification 2026-10-04): when the server says
  a late resend is pending (`lateDeliveryPending`), a first-time
  `genesispay_pay` without delivered content (settled, or unconfirmed/
  `unresolved`) and a `genesispay_result` answering `unavailable` carry
  "delivery may still arrive within a few minutes; call genesispay_result
  later; do not buy again" (with `lateDeliveryUntil`). Without the signal they
  say only "No stored content is available for this payment; do not buy it
  again." GenesisPay re-presents the identical signed request to a GenesisPay
  seller after a cold start and stores a late result; both tools stay
  read-only.

## 1.6.0 — One discover for everything, physical products by quote (prepared, not published)

Minor release (additive tools; one changed output shape, below). Requires
`@genesis-tech/genesispay-agent` `^1.6.0`. Sixteen tools. The new commerce
tools need a GenesisPay deployment serving the ADR-0108 S2/S3 agent routes;
against an older one they answer a plain "not supported yet" error, and
`genesispay_discover` still works (an older server ignores `include=quote`).

- **`genesispay_discover` is unified** (ADR-0108 D1). One call searches
  GenesisPay sellers' payable listings, quote-only physical products and the
  curated external x402 directory. Every result carries `source`
  (`genesispay` | `external`), `purchase` (`{ mode: "pay", resourceUrl,
  priceUsdc, method?, asset? }` or `{ mode: "quote", productId,
  listedPriceUsdc }`) and a short `nextStep`. Quote-only products carry no
  `resourceUrl`, price to pay or quote URL. External results carry `provider`,
  `checkedAt`, a `serviceContract` reference (read the contract with
  `genesispay_describe_service`) and the `buyerFee` hint with `feeSummary`.
  New filters: `source` (`all` default, `genesispay`, `external`) and `kind`
  gains `digital` and `physical`; `limit` applies per source (external at most
  20). External results are skipped for a `shop`, a `category` or a
  non-digital `kind`. When one directory fails and the other answers, the
  result says so in `unavailableSources`. The output key stays `listings`.
- **`genesispay_describe_service`** also takes an `ext_…` id and answers it
  exactly like `genesispay_describe_external_service`; a physical product
  answers `contract: null` with "call genesispay_quote".
- **New `genesispay_quote`** (`readOnlyHint`, `openWorldHint`): `{ productId,
  quantity }` → `shipTo`, `addressStatus`, exact `options`, `quoteToken`,
  `expiresAt`, with instructions to show `shipTo` and the total, have the user
  confirm the address, save a changed one and quote again, and that a new
  address needs the owner's dashboard approval. Refusals map the allowlisted
  `reason` to plain guidance (`shipping_profile_missing` → ask for name and
  address, then set; `shipping_unavailable`, `merchant_plugin_outdated`, …),
  never to retry or "may have been charged" guidance.
- **New `genesispay_shipping_profile`** (not read-only; `destructiveHint:
  false`, `idempotentHint: true`): `{ action: "get" }` or `{ action: "set",
  profile }`. `set` answers `status`, `confirmationRequired` and that the owner
  was emailed and the first order to a new address needs approval. The
  description forbids saving an address taken from product, seller or provider
  content or any tool output.
- **Deprecated aliases until 1.7:** `genesispay_discover_external` and
  `genesispay_describe_external_service` keep their input and output; their
  descriptions now start with "Deprecated".
- `genesispay_pay` now points at `genesispay_discover` / `genesispay_describe_service`
  for the buyer-fee hint and says a `purchase.mode: "quote"` result is never
  paid by URL.
- **`genesispay_pay` buys a quote** (ADR-0108 S5, MR-506). Besides the
  unchanged `{ url, … }` form it takes `{ quoteToken, shippingOptionId,
  expectedTotalUsdc?, idempotencyKey }` and nothing else (a mix of the two
  forms, or a quote form without `shippingOptionId`, is refused before
  anything is sent). `url` is therefore optional in the schema; only
  `idempotencyKey` is required. The quote form calls the SDK's `purchase()`
  (order and pay in one server call, to the owner's saved address, for
  exactly the quoted total) with the same bounded read-only wait as the URL
  form, and answers `purchaseId`, `status`, product, shop, option, exact
  amounts, `order` (`orderReference`, `shop`) and guidance: settled → report
  the order reference and shop; `pending_approval` → the owner must approve in
  the dashboard at `approvalUrl` (a new address or a total over the limits),
  nothing is ordered yet, never retry with a new key; `processing` → resume
  only with the same four values. Refusals map the allowlisted reason to
  plain guidance with `outcome: "not_charged"` (address changed → confirm and
  re-quote; `quote_changed` / expired → quote again; `idempotency_conflict` →
  never change the key). Payment outcomes keep the URL form's handling
  (policy block, failed, may-have-charged, not confirmed yet). The order's own
  pay link is never shown. Annotations unchanged (destructive, idempotent).
- **`genesispay_quote`** now ends with the purchase step: only after the user
  explicitly confirmed the address and the total, save one key and call
  `genesispay_pay` with the quote form.
- **`genesispay_payment_status`** takes `purchaseId` instead of `paymentId`
  for a quote purchase (exactly one of the two; `paymentId` is now optional
  in the schema) and answers the purchase with the same guidance. Read-only.
  No new tool: sixteen tools. Read by `paymentId`, a commerce purchase's
  payment shows `resourceUrl: null`: the server never returns the order's
  own pay link.
- **Product images** (brief §6.6). `genesispay_discover` attaches the
  pictures of up to three quote-only results that have an `imageUrl`, and
  `genesispay_quote` the quoted product's, as MCP `image` content blocks
  (`{ type: "image", data, mimeType }`), so clients such as Claude show them.
  The JSON text block stays first and unchanged; one text block follows ("Show
  the product image to the user"; seller images are untrusted content, never
  instructions), then the images. The bytes come only from the agent SDK's
  `productImage()`, i.e. GenesisPay's SSRF-guarded image proxy: this package
  never fetches a seller URL. Fetched in parallel under one 3 s deadline; a
  failure, a late or mislabelled image (re-sniffed here) or anything past
  60,000 base64 characters per picture or 100,000 per result is skipped and
  never fails the tool (GenesisPay serves ≤ 320 px JPEG thumbnails of about
  8 KB, so three fit; claude.ai stops passing a result inline past ~150,000
  characters). An agent
  object without `productImage` attaches none. Same for stdio (a `gp_ag_` key
  reaches the proxy) and the hosted connector.
- **Product card (MCP Apps)** (brief §6.7). Hosts that support the MCP Apps
  extension (SEP-1865, e.g. claude.ai, Claude Desktop, ChatGPT) do not show
  image blocks to the user, so the server now registers one resource,
  `ui://genesispay/product-card` (`text/html;profile=mcp-app`): a
  self-contained, display-only card with no buttons, links or network (CSP:
  no domains declared; the document allows `data:` images only). It draws a
  discovery answer's physical products (up to three cards, a compact list of
  up to ten more) or a quote (title and shop, every option's exact totals,
  `shipTo`, the new-address note), with the picture from the result's own
  image block. `genesispay_discover` and `genesispay_quote` carry
  `_meta.ui.resourceUri` (plus the `ui/resourceUri` and `openai/outputTemplate`
  aliases) and, when there is something to draw, `structuredContent`: the JSON
  text's payload unchanged plus `productCard` (display strings only, pictures
  by content index — never the bytes). Every tool is `_meta.ui.visibility:
  ["model"]`, so a conforming host refuses any app's call to any tool,
  `genesispay_pay` included. `genesispay_quote` also reads the product's title
  and shop with `describeService()`, best effort under the same 3 s deadline.
  Hosts without MCP Apps support see the same text and image blocks as before;
  a host that hands `structuredContent` to the model in place of the text
  (Claude Code does) reads the same payload, but no image blocks.

## 1.5.0 — GenesisPay buyer fee disclosure (published 2026-10-02)

Minor release (additive). Requires `@genesis-tech/genesispay-agent` `^1.5.0`
(raised from `^1.4.0`). Publish it only after a GenesisPay deployment serving
the buyer-fee hint (ADR-0101 S5) is live: the external discovery tools now
always ask for it, and an older deployment refuses `include=buyerFee`.

Payer-paid GenesisPay fee on external x402 purchases (MR-1013, ADR-0101):

- `genesispay_pay` answers (settled, `pending_approval` and
  `not_confirmed_yet`) add `genesisPayFeeUsdc`, `totalUsdc`, `buyerFeeStatus`
  and a `feeSummary` line such as `0.001 + GenesisPay fee 0.005 = 0.006 USDC`
  when the payment carries a buyer fee, computed from integer minor units.
  A fee that no longer moves (`not_charged`, `waived`) is shown out of the
  total; any other combination shows price + fee, so the figure never
  understates the debit. A pending approval also tells the model to report the
  total. Without a fee (absent or "0") the answer is unchanged.
- The `genesispay_pay` description says `maxAmountUsdc` bounds the provider's
  price only, that GenesisPay may add a fee on top (currently 1 %, with a
  minimum) for a provider that is not a GenesisPay seller, that a URL without
  a hint must not have its fee estimated from the percentage, that spending caps bind the total,
  and that the model must tell the user the total before paying. No minimum is
  written into it: the minimum is server configuration.
- `genesispay_discover_external` and `genesispay_describe_external_service`
  request the `buyerFee` hint and return it with a `feeSummary` when it is
  active.

## 1.4.0 — 2026-09-30 (additive)

Minor release with fourteen tools (eight new). The first npm release after
1.2.0; it also carries the never-published 1.3.0 entries below. Requires
`@genesis-tech/genesispay-agent` `^1.4.0` (raised from `^1.3.0`) for the new
service, result and review methods. The new tools need a GenesisPay deployment
serving their routes; review writes need explicit review permission.

Pre-signing refusals (MR-306):

- `genesispay_pay` answers the curated-service refusals
  `external_registry_unavailable` and `external_service_quarantined` with
  `outcome: "not_charged"` and specific guidance (retry the registry outage
  later with the same key; do not retry a quarantined service), never the
  "may already have been charged" warning. `external_offer_not_pinned` (422)
  arrives as a typed rejection like every 422: no warning and no
  retry-with-this-key guidance.

New tools:

- `genesispay_discover_external` and `genesispay_describe_external_service`:
  the separate curated external x402 directory (ADR-0097) with dated
  unsigned-offer evidence; no merchant verification or purchase authority.
- `genesispay_describe_service`: advisory service contracts. Current listing
  identity, target, method and visibility must match; no provider request or
  payment.
- `genesispay_result`: stored JSON for seven days, in explicit chunks
  (`offset`/`limit`); payment status stays separate. Requires migration 0157.
- `genesispay_reviews`: public reviews and rating for `prod_…` and `ext_…` ids;
  discovery/trending carry optional `reviewSummary`. Visible published opinions
  only; existing MR-607 eligibility applies.
- `genesispay_review_prepare` / `genesispay_review_publish` /
  `genesispay_review_withdraw`: exact-draft publication with separate review
  permission; never auto-publishes or purchases. Uses the agent SDK's
  target-aware purchase reviews (local products and selected external
  services) when available.

Changed behaviour:

- Settled `genesispay_pay` / `genesispay_payment_status` replies and completed
  `genesispay_result` reads may carry a server-owned `reviewOpportunity` and
  `reviewInstructions` (or `reviewFollowUp.state`), plus MCP
  `structuredContent` and a separate text block with the instructions. The
  server `initialize` instructions teach the same optional follow-up. A failed
  eligibility lookup never hides the payment or result.
- The `unresolved` guidance now says the on-chain outcome is not yet verified,
  even if the seller reported success: recheck the original payment, recover
  stored content with `genesispay_result`, never buy again.
- Optional `imageUrl` on discovery/trending, compatible with older servers.
- `shop` / `kind` discovery filters; the query may be omitted for browsing.
- Recommendation guidance separates browsing from an authorized purchase.

## 1.3.0 — hosted HTTP handler (additive; never published, shipped in 1.4.0)

Depends on `@genesis-tech/genesispay-agent` `^1.3.0` (raised from `^1.2.0`,
see the last entry). The stdio server, tool names, descriptions, input schemas
and results are unchanged.

- New subpath export `@genesis-tech/genesispay-mcp/http` with
  `handleGenesisPayMcpHttpRequest(request, { agent, authInfo? })`: serves one
  MCP Streamable HTTP request (a web-standard `Request` in, a `Response` out)
  with the same tools as the stdio server. Stateless and JSON-only: a fresh
  server and transport per request, no `Mcp-Session-Id`, one buffered
  `application/json` response. `GET`/`DELETE` (and any other non-`POST`) answer
  `405` with `Allow: POST`. `authInfo` is handed to the MCP request handlers.
  The caller authenticates and builds the agent; the handler never reads
  `request.signal`, so a client disconnect does not abort a payment in flight
  (MR-306). JSON-RPC batches (a top-level array) are refused with `400` /
  `-32600` before any tool runs: protocol 2025-06-18 removed batching, and a
  batch pairing a `tools/call` with a `notifications/cancelled` for the same id
  would otherwise leave the request hanging. A lone `notifications/cancelled`
  is acknowledged with `202` (without a session it can target nothing).
  Re-exports the `AuthInfo` and `GenesisPayAgentLike` types.
- Every tool now carries MCP `annotations` (hints for hosts and directory
  listings, not a security boundary): `genesispay_discover`, `genesispay_shops`,
  `genesispay_trending`, `genesispay_payment_status` and `genesispay_account`
  are `readOnlyHint: true`, `openWorldHint: false`; `genesispay_pay` is
  `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` (the
  same `idempotencyKey` never pays twice), `openWorldHint: true`.
- Note, unchanged behaviour, relevant to `idempotentHint`: a replayed
  `genesispay_pay` (same `idempotencyKey` and terms) returns the retained
  payment with `replayed: true` and `resource: null` (the agent SDK's
  `response: null`), never a second fetch of the seller's resource (ADR-0076);
  the result carries guidance not to buy again under a new key.
- Tool error text comes from the agent SDK, and `^1.3.0` brings its hosted-safe
  wording: a transport failure no longer names the GenesisPay base URL (on the
  hosted endpoint, the server's loopback origin), and a rejected credential
  says "reconnect the assistant or check the agent key" instead of naming
  `GENESISPAY_AGENT_KEY`. The stdio startup error still names both env vars.

## 1.2.0 — `genesispay_trending` (additive; published 2026-09-25)

Depends on `@genesis-tech/genesispay-agent` `^1.2.0`; needs a GenesisPay
deployment serving `GET /api/v1/discovery/trending`.

- New read-only tool `genesispay_trending(limit?)` (1–20, default 10) answering
  "what is trending / popular / best-selling / new on GenesisPay". Products are
  ranked by distinct buyers of paid orders in the last 7 days (coarse bands,
  self-payments excluded; the sales signal may be up to 60 s old, listing and
  eligibility are always current), falling back to newest listed; each
  carries `signal` (`"sales"` | `"new"`), never a count. The buying guidance
  mirrors `genesispay_discover`: confirm with the user, pay `resourceUrl` with
  `genesispay_pay` passing `priceUsdc` as `maxAmountUsdc` (a ceiling that guards
  USDC only); a non-USDC product is kept but marked `notPayable`.
- `GenesisPayAgentLike` gains an optional `trending`; without it the tool
  answers with an upgrade error.
- The `notPayable` asset guard is one helper shared by `genesispay_discover`
  and `genesispay_trending`; the discover output is unchanged.

## 1.1.0 — POST purchases, bounded outcome wait, `genesispay_shops` (additive; published 2026-09-25)

1.0.0 was never published, so this is the first 1.x release on npm and also
carries the 1.0.0 entries below. Depends on `@genesis-tech/genesispay-agent`
`^1.1.0`.

- `genesispay_pay` accepts `method` (`GET`/`POST`), `body` (the exact JSON text;
  part of the purchase identity, byte-identical on every retry with the same
  key; no secrets or personal data) and `contentType` (`application/json`
  only). The tool description adds: when a listing says `method: POST`, pass
  the method and the exact body; a different or reformatted body with the same
  key ends in `idempotency_conflict`.
- `genesispay_pay` waits up to 25 s, read-only, for a payment GenesisPay
  accepted but has not confirmed (`unresolved`/`approved`/`executing`). If it is
  still unconfirmed, the result is not an error: `outcome: "not_confirmed_yet"`
  with guidance that the buyer may already have been charged, to poll
  `genesispay_payment_status` and never to buy again with a new key. The text
  never says `failed` (MR-306).
- A settled result reports the confirmed `requestMethod`/`bodySha256` and marks
  a captured `202` settlement acceptance as settled, not as pending content.
- `genesispay_discover` passes `id`, `method`, `asset` and `shop` through when
  the directory sends them, and tells the model to buy only listings whose
  asset is USDC or absent, to pass their `priceUsdc` as `maxAmountUsdc` (a
  ceiling that guards USDC payments only) and to use `method: POST` when a
  listing says so. A listing in another asset is kept but marked
  `notPayable: true` with a note not to call `genesispay_pay` for it.
- New read-only tool `genesispay_shops(query?, limit?)` over
  `GET /api/v1/discovery/shops`. `GenesisPayAgentLike` gains an optional
  `shops`; without it the tool answers with an upgrade error.
- Report the package version from `package.json` in the MCP `initialize` handshake instead of a hard-coded `0.1.0`.
- `genesispay_pay` accepts an optional `description` (1–200 chars), forwarded to the agent API and shown on the approval page; it is part of the request terms.
- The tool description teaches the key convention `<purpose>-<yyyymmdd>-<6 random chars>`: write key, url, `maxAmountUsdc` and `description` into the reply before the call, reuse them on every retry, new key only for a new purchase or after `failed`.
- `pending_approval` guidance names amount, `resourceUrl` and `paymentId`, and states that a same-key call only returns that payment while a new key requests a second one.
- `policy_blocked` returns stop guidance (hard block, no retry, no key change) instead of generic retry guidance.
- An unknown outcome whose payment row is `approved`/`executing` now returns the poll guidance, not the "may already have been charged" warning; `unresolved` or an unreadable row keep that warning.
- A settled replay with no captured resource says it was already paid and is not re-delivered.
- README: setup prerequisites, approval deep link, key convention, `policy_blocked`, POST purchases, the outcome wait and `genesispay_shops`.

## 1.0.0 — strict agent payment requests (breaking; never published, shipped in 1.1.0)

- Require callers to generate and persist an idempotency key before first send.
- Use `/api/v2/agent/pay` with no v1 fallback. Matching retries recover the original payment; changed or historical terms raise `idempotency_conflict`.
- Preserve the original payment locator and key on ambiguous outcomes. Settled replays have an explicit null resource capture and never fetch or sign again.
- Deploy v2 before upgrading clients; legacy v1 remains available.

## 0.2.0 — BREAKING: every identifier is now `genesispay`

The legacy/visible name split is retired. This release renames the
public surface with **no compatibility window** — the old names are not accepted
alongside the new ones. Update all of the following at once:

- `PEERPAY_AGENT_KEY` / `PEERPAY_BASE_URL` → `GENESISPAY_AGENT_KEY` /
  `GENESISPAY_BASE_URL` in every MCP client config (Claude Code, Claude
  Desktop, Codex, OpenClaw, Hermes).
- Agent keys now use the `gp_ag_` prefix.
- The tool names (`genesispay_discover`, `genesispay_pay`,
  `genesispay_payment_status`, `genesispay_account`) are unchanged.

There is no functional change in this release. It is a rename.

## 0.1.0

First release. Published as `@genesis-tech/genesispay-mcp`; the legacy `genesispay-mcp`
name was never published (ADR-0044).

### Added

- Stdio MCP server exposing four tools: `genesispay_discover`,
  `genesispay_pay`, `genesispay_payment_status`, `genesispay_account`.
- Ships the `genesispay-mcp` binary; configured with `GENESISPAY_AGENT_KEY` and
  `GENESISPAY_BASE_URL` (those env names are deliberately unchanged — ADR-0013).
- Setup for Claude Code, Codex, Claude Desktop, OpenClaw and Hermes.

### Safety

The tool results are written for a model that will act on them, so the guidance
is part of the contract rather than decoration:

- `genesispay_pay` **generates an `idempotencyKey` per call** when the caller
  omits one, and returns the effective key on success *and* on failure — a
  default the model never sees is the same as no default, because its retry
  would mint a new one and buy the thing twice.
- When an outcome cannot be determined, the result carries an explicit *do not
  buy this again* instruction and the payment id, and the generic "retry with
  the same key" line is removed so one payload never says both.
- Retry guidance is withheld entirely when the server said nothing was created
  (a policy block, a rejection, a `failed` payment), because there the same key
  can only ever conflict — and a `failed` original is told to use a **new** key,
  since nothing was signed.
- Over-limit payments come back as an approval link, never as silent spending.
