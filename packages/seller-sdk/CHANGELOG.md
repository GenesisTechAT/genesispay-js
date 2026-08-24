# Changelog

## 0.13.0 — checkout return parameters and fulfilment DX

Additive. Exports the return-parameter constants and a hint parser, and adds
local redirect-URL validation to `checkout.create`. No removed or changed
behaviour; the server stays the authoritative backstop for raw HTTP clients.

### Added

- **`CHECKOUT_RETURN_LINK_ID_PARAM` / `CHECKOUT_RETURN_STATUS_PARAM`** — the exact
  query-parameter names (`genesispay_link_id` / `genesispay_status`) the hosted
  checkout appends to a merchant's `returnUrl`. Exported so a merchant can build
  or match the return URL without hardcoding the names.
- **`parseCheckoutReturnHint(url: string | URL): CheckoutReturnHint | null`** and the
  **`CheckoutReturnHint`** type (`{ linkId, status: "paid" }`). Returns a hint only
  when the URL carries a non-empty `genesispay_link_id` and an exact
  `genesispay_status=paid`; a missing id, an unknown status, or an unparseable URL
  returns `null`. It performs **no verification** — the parameters are unsigned,
  so gate fulfilment on `checkout.retrieve(hint.linkId)` or a webhook, never on
  the hint itself.

### Behaviour changes

- `checkout.create` now validates `returnUrl` and `cancelUrl` **locally** before
  the request is sent: each field is trimmed (a blank field is dropped), capped at
  2,048 characters, and must be `https` (`http` is accepted only for the exact
  loopback hosts `localhost` and `127.0.0.1`). A `javascript:`/`data:` value, a
  remote `http` host, or a deceptive `localhost.example` name throws
  `GenesisPayValidationError` with one `issues` entry per offending field, and no
  network request is made. The fields stay typed `string`; the server's own
  validation is unchanged and remains authoritative for non-SDK callers.

### Documentation

- The unsigned-return-parameter warning moved beside the SDK quick start, with a
  parse-hint → authenticated `checkout.retrieve()` → idempotent-action example.
- New fulfilment guide (per product: what to fulfil on and how to dedupe), a note
  that the `cs` query parameter is internal payer session identity rather than
  merchant correlation, and the exact correlation echo contract for `metadata`
  and `clientReferenceId`.

### Requirements

- None. Works against any backend; a server predating this release simply sees
  the same validated values it would have received anyway.

## 0.12.0 — permanent product checkout permalinks

### Added

- **`genesispay.products.permalink(publicId)`**. The product's PERMANENT
  checkout URL — `{baseUrl}/pay/p/{publicId}` — stable across every link
  remint because the server resolves the product's current canonical link on
  every request. Pure string builder: no network call, no mint. This is the
  URL to embed in a shop's buy button.
- **`genesispay.products.checkoutUrl(publicId)`**. Convenience for
  `createPaymentLink(publicId)` → `link.payUrl`. The mint is idempotent, but
  it is still a write — resolve at render time, never persist the result.

### Why

`link.payUrl` embeds the link's `inv_…` id, which is **per link, not per
product**: archiving and reminting (e.g. a wallet migration) gives the new
link a new id and silently breaks every hardcoded copy. A product's `prod_…`
id never changes. On the server, `GET /pay/p/:productPublicId` resolves the
product's current canonical live link read-only (a public GET never mints)
and redirects to the existing dual-readable `/pay/:linkId` URL, so humans get
checkout and agents get x402 from one stable product URL.

## 0.11.0 — product-backed x402 resource gates

### Added

- **`delivery` on `genesispay.products.create()` and `.update()`**. A product
  can now be a redirect entitlement, a registered HTTP resource gate, or have
  no delivery. The flat `fulfilmentUrl` fields remain compatible with existing
  redirect integrations.
- **`genesispay.products.gate(productId)`**. `prime()` resolves the registered
  gate product and canonical reusable payment link; `protect(request, handler)`
  performs the x402 challenge/settlement exchange and runs the handler only
  after GenesisPay confirms payment. Use `purchase.payment.attemptId` as the
  idempotency key because confirmed payment retries may run a handler again.
- **`genesispay.entitlements.verify(entitlementId)`**. This seller-authorized
  hard check is for a redirect product's redemption handler; require a valid,
  non-simulated entitlement for the expected product before granting access.

### Safety

- Product gates bind the pending attempt to the registered URL, upper-case HTTP
  method, and a SHA-256 fingerprint of the raw request body. GenesisPay receives
  the fingerprint, not the request data.
- Gate purchases never mint redirect entitlements. Redirect products retain
  their signed 30-day redemption URLs unchanged.
- A product gate always derives amount, asset, destination and fees from the
  canonical product link; callers cannot supply those money fields.

## 0.9.0 — BREAKING: every identifier is now `genesispay`

The legacy/visible name split is retired. This release renames the
public surface with **no compatibility window** — the old names are not accepted
alongside the new ones. Update all of the following at once:

- Client and errors renamed: `PeerPay` → `GenesisPay`, `PeerPay*Error` →
  `GenesisPay*Error` (including `PeerPaySignatureVerificationError`).
- Webhook signature header `PEERPAY-SIGNATURE` → `GENESISPAY-SIGNATURE`.
  **Verification fails silently if you do not update this** — the old header
  simply stops arriving.
- Seller API keys now use the `gp_sk_` prefix. Keys issued as `pp_sk_` are
  rejected and must be reissued from the dashboard.
- Environment variables `PEERPAY_*` → `GENESISPAY_*`.
- Checkout return parameters `peerpay_link_id` / `peerpay_status` →
  `genesispay_link_id` / `genesispay_status`.
- `genesispay-settlement` module renamed to `genesispay-settlement`.

### Also in this release — a real fix, not a rename

`PRODUCTION_FACILITATOR_BASE_URL` pointed at `peerpay-app-production.up.railway.app`,
a Railway-generated hostname that **never existed** — production has exactly one
domain. Any live key used via the zero-config path (`new GenesisPay({ apiKey })`
with no `baseUrl`) therefore resolved to a dead host. Both defaults now use the
custom domains, which are ours and survive a Railway service rename:

- live keys → `https://genesispay.finance`
- `DEFAULT_FACILITATOR_BASE_URL` → `https://dev.genesispay.finance`

Everything else in this release is a rename.

## Unreleased — renamed to `@genesis-tech/genesispay-seller`

The legacy `@genesis-tech/genesispay-seller` name was versioned here through 0.8.0
but never published to npm, so the first npm release carried the product's own
name (ADR-0044). 0.8.0 was published on 2026-08-07. Every version below describes work done under the old name.

## 0.8.0

Adds one-off commercial invoicing without changing the existing checkout or
subscription surfaces.

### Added

- **`genesispay.customers.*`** — create, list, retrieve, update, and archive
  reusable billing contacts.
- **`genesispay.invoices.*`** — create/update drafts, finalize an immutable invoice,
  retrieve/list it, send it through the configured email provider, void it, or
  mark it uncollectible.
- Finalized invoice responses include the hosted invoice URL, PDF URL, exact
  payment URL, stablecoin asset, integer minor-unit totals, and verified payment
  receipt fields.
- `invoices.send(publicId, { idempotencyKey })` requires a caller-supplied key so
  transport retries cannot create duplicate email sends.

### Safety

- A draft is not payable. Finalization creates one single-use payment link and
  freezes the customer, line items, totals, asset, chain, and destination.
- `paid` is reported only from a confirmed, non-simulated GenesisPay payment.

## 0.7.0

Carries the 0.6.0 amount rename one surface further: onto the **webhook
payload**. Same defect, same shape of fix — a handler settling an EURC payment
read `amountUsdc` and had nothing in the payload telling it those were euros.
Additive and backward compatible; no existing handler changes meaning.

### Added

- **`amount` and `asset` on the `payment.confirmed` / `link.paid` payload**
  (`GenesisPayPaymentEventData["link"]`). `event.data.link.asset` names the
  currency; `event.data.link.amount` is the field whose name matches its value.
  `amountUsdcMinor` is unchanged — same integer minor units, same name.
- **`attempt.chainId` on the same payload** — the chain `attempt.txHash` is on.
  Without it the hash cannot be resolved and a testnet delivery is byte-identical
  to a mainnet one. `8453`/`84532` (Base mainnet/Sepolia) for a crypto
  settlement, but the set is **open**: a pay-by-bank settlement reports the
  provider's chain, which can be Gnosis, Polygon or Ethereum — a
  `chainId !== 8453` test would book a real Gnosis settlement as test money.
  It sits on the attempt rather than the link because the two can differ: a
  pay-by-bank settlement mints on whatever chain the provider profile uses.
  `chainId` and `txHash` are `null` together when there is nothing to resolve.
  Optional in the type for the same reason `asset` is — but note the polarity
  trap: `undefined !== 8453` is `true`, so branch on presence before comparing.

### Deprecated

- **`amountUsdc` on the payment webhook payload.** Still sent on every delivery
  with the same value, only marked `@deprecated`. Removed no earlier than 1.0.

### Requirements

- A backend carrying the matching server change; older deliveries are handled
  below.
- The webhook payload is **not** re-validated at runtime — `constructEvent`
  verifies the signature and the envelope, then hands the body over under the
  declared type. A delivery enqueued before this release is stored and retried
  verbatim, so it can still arrive without `amount`/`asset` while its retry
  window is open. `amount ?? amountUsdc` covers the first; the second is typed
  **optional** precisely because it has no safe fallback — defaulting a missing
  `asset` to `"USDC"` would book a euro payment as dollars, which is the bug
  this release exists to remove. Ack such a delivery, alert, and resolve the
  link through `checkout.retrieve` instead.

## 0.6.0

Renames the checkout amount field. `amountUsdc` carried the **EUR** amount on a
link created with `asset: "EURC"` — the field name asserted a currency the value
did not have, which an integrator reported as a currency-confusion risk. Additive
and backward compatible: nothing is removed and no existing call changes meaning.

### Added

- **`amount` on `checkout.create`** — the decimal amount in the link's `asset`.
  Dollars under the default `asset: "USDC"`, euros under `asset: "EURC"`. The
  currency comes from `asset`; the field name no longer claims one.
- **`amount` and `asset` on `CheckoutLink`** — `create()` now echoes the
  settlement currency back, so an EURC link is confirmable without a second
  `retrieve()`. `asset` moved up from `CheckoutSession`, which still has it.
- **`amount` on `POST /api/v1/links` and on every link response**, next to the
  unchanged `amountUsdc` / `amountUsdcMinor`.

### Deprecated

- **`amountUsdc` on `checkout.create` and on `CheckoutLink`/`CheckoutSession`.**
  Still accepted, still returned, still carrying the same value — only marked
  `@deprecated`. It is removed no earlier than 1.0.

### Behaviour changes

- `checkout.create` with **both** `amount` and `amountUsdc` set to *different*
  amounts throws `GenesisPayValidationError` and never sends the request. Equal
  values are fine — `"5.0"` and `"5.00"` compare as the same money, since the
  check is on minor units rather than on the strings. The server enforces the
  same rule (422) for callers that do not use this SDK.
- `checkout.create` with **neither** field is still a **compile** error:
  `CheckoutAmountInput` is a union requiring one of the two names, so the
  guarantee the required `amountUsdc` property gave is not traded away. It also
  throws `GenesisPayValidationError` at runtime, for JavaScript callers.
- Every create request sends the amount under **both** names. A backend older
  than 0.6.0 only knows `amountUsdc` and ignores `amount`, so 0.6.0 works
  unchanged against one.

### Unchanged on purpose

- `gate({ amountUsdc })` keeps its name. An x402 gate prices a request in USDC on
  Base, so the currency genuinely belongs in the field.
- The `amountUsdcMinor` field and the database column behind it are untouched.

### Requirements

- None. Works against any backend; `amount` on responses needs a 0.6.0 backend,
  and the SDK falls back to `amountUsdc` when it is absent.

## 0.5.0

Closes the two subscription gaps 0.4.0 shipped with. Both only bite *after* the
sale, which is why they survived happy-path testing — and both were blocking a
real operation.

### Added

- **`genesispay.mandates.list({ planId?, status?, limit?, startingAfter? })`** —
  until now a mandate id arrived only on the `mandate.active` webhook, so a
  missed delivery meant a customer who wanted to cancel could not be served:
  `revoke` needs that id and there was no way to look it up. Returns
  `{ mandates, hasMore }`.
  - Pagination is **keyset**, not offset: `startingAfter` is the id of the last
    mandate on the previous page, ordering is `createdAt DESC, id DESC`. Equal
    timestamps therefore can't drop or duplicate a row across pages.
  - `planId` takes the plan's **`publicId`**. An unknown or foreign plan returns
    an empty page rather than a 404, so it cannot be used to probe for plans.
- **`subscriptionPlanId` on `Mandate`** and on the mandate webhook payload
  (`GenesisPayMandateEventData`). Without it a `mandate.active` handler knew *that*
  someone subscribed but not *to what*. `null` means the mandate was proposed
  directly rather than through a plan checkout — a valid state, not missing data.
  The server sets it only in the hosted `/subscribe/:planId` flow, so a mandate
  cannot be attributed to someone else's plan.

### Behaviour changes

- A **400** whose body carries structured `issues` now throws
  `GenesisPayValidationError` instead of `GenesisPayConfigError` — the new list
  endpoint reports invalid query parameters that way. A 400 *without* `issues`
  is unchanged.

### Requirements

- Needs a backend carrying migration `0013`.

## 0.4.0

Closes the rest of the 0.2.0 integration report: programmatic subscriptions, a
test-mode payment simulator, and the typing/error work the 0.3.0 review turned up.
Additive except where noted under *Behaviour changes*.

### Added

- **`genesispay.plans.*`** — `create`, `list`, `retrieve`, `archive` against the new
  `/api/v1/plans`. Subscription plans existed before but were reachable only from
  the dashboard, which is what actually blocked building subscriptions
  programmatically. Every plan carries **`checkoutUrl`**, the hosted
  `/subscribe/:publicId` flow to hand a customer — you no longer assemble it.
- **`genesispay.mandates.*`** — `create`, `retrieve`, `charge`, `revoke`. There is
  deliberately **no `activate`**: activating a mandate needs the payer's
  signature, not the seller key, so it belongs in the payer's frontend.
  `mandates.create` returns `{ mandate, permitTypedData, spender }`, and
  `permitTypedData` is passed through verbatim — a signature covers those exact
  bytes, so the SDK must not reshape them.
- **`genesispay.checkout.simulatePayment(publicId, { payerWallet? })`** — mints a
  confirmed payment in test mode and fires the real `payment.confirmed` /
  `link.paid` webhooks, so the paid path is testable without testnet USDC and
  wallet UX. Test keys only (a live key gets 403), and the endpoint does not
  exist at all on a mainnet deployment (404).
- **`attempts` on `CheckoutSession`** — id, status, `txHash`, `payerWallet`,
  timestamps, `failureReason`. Building a receipt after `paid === true` no longer
  needs a raw fetch.
- **`simulated` on every attempt** and on `data.attempt` in the webhook payload.
  A simulated attempt has `txHash: null` — but so does a pending real one, so
  this flag is the only honest signal. Real payments report `false`.
- **Typed webhook events.** `constructEvent` now returns a union discriminated on
  `type`, so `if (event.type === "payment.confirmed")` narrows `event.data` with
  no cast. Also exported: `GENESISPAY_EVENT_TYPES`, `isKnownGenesisPayEventType`,
  `GenesisPayEventType`, and `GenesisPayAnyEvent`/`GenesisPayUnknownEvent` for handlers
  that want to model the open world.
  - An **unknown event type is still accepted**, verified and returned — a newer
    server must never make an older SDK reject deliveries. Only the signature or
    a malformed envelope can reject.
  - `GenesisPayEvent` has no `{ type: string }` fallback member on purpose:
    TypeScript disables discriminant narrowing for *every* member of a union as
    soon as one member's discriminant is a non-literal. Use `GenesisPayAnyEvent`
    (assignable from any known event, no cast) when you need the open type.
- **`GenesisPayValidationError`** (422, with structured `issues: [{path, message}]`)
  and **`GenesisPayRateLimitError`** (429, with `retryAfterSeconds` from
  `Retry-After`).

### Behaviour changes

- A 422 or 429 previously surfaced as `GenesisPayConfigError`. They now throw the
  two classes above. If you branch on `GenesisPayConfigError` to catch bad input,
  update that branch — both new classes extend `Error`, not `GenesisPayConfigError`.
- **`expectedPayTo` now also covers created objects.** It previously guarded only
  the `/api/v1/seller` config lookup, while `checkout.create` and `plans.create`
  each freeze their own `destinationWallet` — the addresses money actually moves
  to. Both now throw `GenesisPayNetworkSafetyError` on a mismatch. If you set the
  pin and create links for a wallet other than the pinned one, those calls will
  start failing (which is the point).
- **An unknown `plan.status` now degrades to `archived`, not `active`.** A status
  a given SDK version does not know must not read as "keep sending customers to
  this `checkoutUrl`". Matches mandate status degrading to `pending_permit`.

### Known gaps

- There is no `mandates.list()`: mandate ids currently arrive only on the
  `mandate.active` webhook, so persist them — `mandates.revoke(id)` needs one.
- Mandates carry no plan reference, so "who subscribes to plan X" cannot be
  answered yet. Both are tracked for the next release.

### Requirements

- The new endpoints need a backend carrying migrations `0011` and `0012`.

## 0.3.0

Closes the integration gaps reported against 0.2.0. Fully additive — no existing
call signature changes.

### Added

- **Checkout correlation** — `checkout.create` accepts `metadata`
  (`Record<string, string>`, max 20 keys, 500 chars per value, 4 KB serialized) and
  `clientReferenceId` (max 200 chars). Both are echoed by `checkout.retrieve()` and
  included in the `payment.confirmed` / `link.paid` webhook payloads, so a link
  carries your own identifiers and you no longer need a side table to map a
  `publicId` back to a buyer.
- **Return / cancel URLs** — `checkout.create` accepts `returnUrl` and `cancelUrl`.
  After a confirmed payment the hosted checkout shows an explicit "back to …"
  button with `?genesispay_link_id=<publicId>&genesispay_status=paid` appended (existing
  query parameters on your URL are preserved). Deliberately not an automatic
  timed redirect: the payer should be able to see the on-chain confirmation before
  leaving. Both must be `https` (`http` is accepted for localhost only).
- **`checkout.retrieve(publicId)`** — reads a link's current state, including a
  `paid` boolean and `confirmedPaymentCount`, for polling without a raw fetch
  against `/api/v1/links/:publicId`. A 404 throws the new `GenesisPayNotFoundError`
  rather than `GenesisPayConfigError`, so an unknown id is distinguishable from a
  broken key or an unreachable backend.
- **`constructEvent(rawBody, signatureHeader, secret, opts?)`** — webhook signature
  verification, exported as a free function and as `genesispay.webhooks.constructEvent`.
  Constant-time comparison, a replay window on the signature timestamp (default
  300 s, rejecting future timestamps as well as stale ones), and support for
  multiple `v1=` values so an endpoint secret can be rotated without dropped
  deliveries. Throws `GenesisPaySignatureVerificationError`; no error message
  contains the secret or the expected signature.

### Note on `constructEvent` being async

Stripe's equivalent is synchronous. Ours is not: it is implemented on WebCrypto
instead of `node:crypto` so the SDK keeps working on Edge runtimes, Cloudflare
Workers and Bun. Remember the `await`.

### Gotchas worth knowing before you upgrade

- `constructEvent` returns a **Promise** (see above).
- The `?genesispay_link_id=…&genesispay_status=paid` parameters appended to your
  `returnUrl` are a UI hint, **not** proof of payment — they are unsigned and a
  payer can navigate to that URL without paying. Fulfil on the webhook or on
  `checkout.retrieve().paid`.
- Deduplicate webhook *retries* on `event.id` (stable across the up-to-three
  attempts of one delivery). Note that a single-use link also emits both
  `payment.confirmed` and `link.paid` for one settlement — those are two separate
  deliveries with different ids, so branch on `event.type` and fulfil on one.
- `session.paid` on a `reusable` link means "ever paid", not "this buyer paid".

### Not included

- `checkout.list()` — deferred until `GET /api/v1/links` supports `cursor`/`limit`;
  shipping a method over the current unpaginated endpoint would freeze the wrong
  signature.

### Requirements

- The four new checkout fields need a backend carrying migration `0011`. Against an
  older backend they simply come back `null`; nothing throws.

## 0.2.0

### Added

- **`GenesisPay` client** — a Stripe-like entry point that configures from just the
  seller API key. The key prefix (`gp_sk_test_…` / `gp_sk_live_…`) determines the
  mode and base URL; the payout wallet and network are resolved from the key via the
  new GenesisPay backend endpoint `GET /api/v1/seller` and cached (single-flight, 5-min
  TTL, failures never cached).
  - `genesispay.checkout.create({ title, amountUsdc, … })` → hosted `payUrl` (the wallet
    is defaulted server-side from the key).
  - `genesispay.gate({ amountUsdc }).wrap(handler)` → x402 gate with `payTo` + network
    resolved from the key and settlement auto-wired.
- Money-safety, all fail-closed: no `402` with a null destination; `503` when the
  backend is unreachable (the paid handler never runs); asset-integrity check
  (backend USDC/chainId must match the SDK's native table); mode↔network check (a
  `live` key must not resolve to a testnet); optional `expectedPayTo` pin.
- Exports: `GenesisPay`, `GenesisPayConfigError`, `GenesisPayNetworkSafetyError`, and the
  related types.

### Requirements

- `gate()` requires the backend endpoint `GET /api/v1/seller`. Deploy that before
  upgrading a consumer, or `gate()` returns a clear "could not resolve seller" error.

### Unchanged

- The low-level `createPaymentGate` / `genesisPaySettlement` primitives are untouched and
  remain exported. This release is purely additive.

## 0.1.0

- Initial release: framework-agnostic x402 payment gate (`createPaymentGate`,
  `genesisPaySettlement`).
