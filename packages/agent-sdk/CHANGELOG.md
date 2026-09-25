# Changelog

## 1.2.0 — `trending()` (additive; prepared, not published)

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

## 1.1.0 — POST purchases and a bounded outcome wait (additive; prepared, not published)

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

## 1.0.0 — strict agent payment requests (breaking; prepared, not published)

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
