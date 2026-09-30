# Changelog

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
