# Changelog

## 0.3.0 — additive `product` block on `accepts[]`

A 402 resource that sells a catalogue product may now advertise it:
`accepts[0].product = { productId, sku, quantity: 1 }`. Strictly additive —
the key is **absent** (not `undefined`) for every non-product resource, so
payloads for ordinary links are byte-identical to 0.2.0, and the block is
advisory: the money fields remain the authority with or without it.

The parser tolerates malformed foreign blocks (they parse to an absent key,
never a throw) and refuses to round-trip a `quantity` other than the fixed `1`.
Old clients on 0.2.0 lose nothing but the catalogue hint: `parsePaymentAccept`
there drops unknown keys, which is exactly why upgrading is required to SEE
the block, and why nothing money-bearing may ever depend on it.

## 0.2.0 — BREAKING: every identifier is now `genesispay`

The legacy/visible name split is retired. This release renames the
public surface with **no compatibility window** — the old names are not accepted
alongside the new ones. Update all of the following at once:

- Exported types and helpers renamed `PeerPay*` → `GenesisPay*`.
- Header constants `PEERPAY-*` → `GENESISPAY-*` (this is the x402 wire
  format — a receiver still reading `PEERPAY-SIGNATURE` fails closed).

There is no functional change in this release. It is a rename.

## 0.1.0

First release. Published as `@genesis-tech/genesispay-protocol`; the legacy
`genesispay-protocol` name was never published (ADR-0044).

### Added

- Pure x402 V2 types plus encode/decode/validate helpers for the
  `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE` headers.
- No I/O and no GenesisPay-specific behaviour: this package is the wire format,
  so a seller or agent implementation can depend on it without depending on us.
