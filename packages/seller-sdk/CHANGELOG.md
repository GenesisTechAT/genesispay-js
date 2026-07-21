# Changelog

## 0.5.0

Closes the two subscription gaps 0.4.0 shipped with. Both only bite *after* the
sale, which is why they survived happy-path testing — and both were blocking a
real operation.

### Added

- **`peerpay.mandates.list({ planId?, status?, limit?, startingAfter? })`** —
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
  (`PeerPayMandateEventData`). Without it a `mandate.active` handler knew *that*
  someone subscribed but not *to what*. `null` means the mandate was proposed
  directly rather than through a plan checkout — a valid state, not missing data.
  The server sets it only in the hosted `/subscribe/:planId` flow, so a mandate
  cannot be attributed to someone else's plan.

### Behaviour changes

- A **400** whose body carries structured `issues` now throws
  `PeerPayValidationError` instead of `PeerPayConfigError` — the new list
  endpoint reports invalid query parameters that way. A 400 *without* `issues`
  is unchanged.

### Requirements

- Needs a backend carrying migration `0013`.

## 0.4.0

Closes the rest of the 0.2.0 integration report: programmatic subscriptions, a
test-mode payment simulator, and the typing/error work the 0.3.0 review turned up.
Additive except where noted under *Behaviour changes*.

### Added

- **`peerpay.plans.*`** — `create`, `list`, `retrieve`, `archive` against the new
  `/api/v1/plans`. Subscription plans existed before but were reachable only from
  the dashboard, which is what actually blocked building subscriptions
  programmatically. Every plan carries **`checkoutUrl`**, the hosted
  `/subscribe/:publicId` flow to hand a customer — you no longer assemble it.
- **`peerpay.mandates.*`** — `create`, `retrieve`, `charge`, `revoke`. There is
  deliberately **no `activate`**: activating a mandate needs the payer's
  signature, not the seller key, so it belongs in the payer's frontend.
  `mandates.create` returns `{ mandate, permitTypedData, spender }`, and
  `permitTypedData` is passed through verbatim — a signature covers those exact
  bytes, so the SDK must not reshape them.
- **`peerpay.checkout.simulatePayment(publicId, { payerWallet? })`** — mints a
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
  no cast. Also exported: `PEERPAY_EVENT_TYPES`, `isKnownPeerPayEventType`,
  `PeerPayEventType`, and `PeerPayAnyEvent`/`PeerPayUnknownEvent` for handlers
  that want to model the open world.
  - An **unknown event type is still accepted**, verified and returned — a newer
    server must never make an older SDK reject deliveries. Only the signature or
    a malformed envelope can reject.
  - `PeerPayEvent` has no `{ type: string }` fallback member on purpose:
    TypeScript disables discriminant narrowing for *every* member of a union as
    soon as one member's discriminant is a non-literal. Use `PeerPayAnyEvent`
    (assignable from any known event, no cast) when you need the open type.
- **`PeerPayValidationError`** (422, with structured `issues: [{path, message}]`)
  and **`PeerPayRateLimitError`** (429, with `retryAfterSeconds` from
  `Retry-After`).

### Behaviour changes

- A 422 or 429 previously surfaced as `PeerPayConfigError`. They now throw the
  two classes above. If you branch on `PeerPayConfigError` to catch bad input,
  update that branch — both new classes extend `Error`, not `PeerPayConfigError`.
- **`expectedPayTo` now also covers created objects.** It previously guarded only
  the `/api/v1/seller` config lookup, while `checkout.create` and `plans.create`
  each freeze their own `destinationWallet` — the addresses money actually moves
  to. Both now throw `PeerPayNetworkSafetyError` on a mismatch. If you set the
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
  button with `?peerpay_link_id=<publicId>&peerpay_status=paid` appended (existing
  query parameters on your URL are preserved). Deliberately not an automatic
  timed redirect: the payer should be able to see the on-chain confirmation before
  leaving. Both must be `https` (`http` is accepted for localhost only).
- **`checkout.retrieve(publicId)`** — reads a link's current state, including a
  `paid` boolean and `confirmedPaymentCount`, for polling without a raw fetch
  against `/api/v1/links/:publicId`. A 404 throws the new `PeerPayNotFoundError`
  rather than `PeerPayConfigError`, so an unknown id is distinguishable from a
  broken key or an unreachable backend.
- **`constructEvent(rawBody, signatureHeader, secret, opts?)`** — webhook signature
  verification, exported as a free function and as `peerpay.webhooks.constructEvent`.
  Constant-time comparison, a replay window on the signature timestamp (default
  300 s, rejecting future timestamps as well as stale ones), and support for
  multiple `v1=` values so an endpoint secret can be rotated without dropped
  deliveries. Throws `PeerPaySignatureVerificationError`; no error message
  contains the secret or the expected signature.

### Note on `constructEvent` being async

Stripe's equivalent is synchronous. Ours is not: it is implemented on WebCrypto
instead of `node:crypto` so the SDK keeps working on Edge runtimes, Cloudflare
Workers and Bun. Remember the `await`.

### Gotchas worth knowing before you upgrade

- `constructEvent` returns a **Promise** (see above).
- The `?peerpay_link_id=…&peerpay_status=paid` parameters appended to your
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

- **`PeerPay` client** — a Stripe-like entry point that configures from just the
  seller API key. The key prefix (`pp_sk_test_…` / `pp_sk_live_…`) determines the
  mode and base URL; the payout wallet and network are resolved from the key via the
  new PeerPay backend endpoint `GET /api/v1/seller` and cached (single-flight, 5-min
  TTL, failures never cached).
  - `peerpay.checkout.create({ title, amountUsdc, … })` → hosted `payUrl` (the wallet
    is defaulted server-side from the key).
  - `peerpay.gate({ amountUsdc }).wrap(handler)` → x402 gate with `payTo` + network
    resolved from the key and settlement auto-wired.
- Money-safety, all fail-closed: no `402` with a null destination; `503` when the
  backend is unreachable (the paid handler never runs); asset-integrity check
  (backend USDC/chainId must match the SDK's native table); mode↔network check (a
  `live` key must not resolve to a testnet); optional `expectedPayTo` pin.
- Exports: `PeerPay`, `PeerPayConfigError`, `PeerPayNetworkSafetyError`, and the
  related types.

### Requirements

- `gate()` requires the backend endpoint `GET /api/v1/seller`. Deploy that before
  upgrading a consumer, or `gate()` returns a clear "could not resolve seller" error.

### Unchanged

- The low-level `createPaymentGate` / `peerPaySettlement` primitives are untouched and
  remain exported. This release is purely additive.

## 0.1.0

- Initial release: framework-agnostic x402 payment gate (`createPaymentGate`,
  `peerPaySettlement`).
