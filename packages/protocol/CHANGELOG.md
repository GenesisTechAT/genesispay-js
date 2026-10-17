# Changelog

## 0.8.0 — purchase intent and conversation digest (prepared, not published)

Minor, additive. Nothing is removed or renamed; existing x402 codecs are unchanged.

### Added

- `PURCHASE_INTENT_VERSION` (1), `PURCHASE_INTENT_APPROVAL_QUOTE_MAX_LENGTH`
  (500 UTF-16 code units), and the strict `parsePurchaseIntent` parser. The
  version-1 shape couples x402 resources to null delivery and commerce products
  to the owner's saved shipping profile, with an asset-qualified int8 minor-unit
  total-debit cap, a bounded approval quote and a conversation commitment.
- `serializePurchaseIntent` / `digestPurchaseIntent` and
  `serializePurchaseConversation` / `digestPurchaseConversation`, plus
  `isPurchaseDigest`. Digests are synchronous SHA-256 over canonical UTF-8 JSON,
  formatted `sha256:<64 lowercase hex>`, in browser and Node.
- Types: `PurchaseIntent`, `PurchaseIntentItem`, `PurchaseIntentMaxTotal`,
  `PurchaseConversationMessage`, `PurchaseDigest`.

GenesisPay never receives or stores the conversation, only its digest. Visible
user/assistant turns are hashed locally, verbatim, with no protocol size cap;
system/tool turns are excluded. The frozen canonical forms (domain type,
version, key order, compact JSON and UTF-8 encoding) are a public contract,
pinned by literal digest vectors. The approval quote is an NFC allow-list of visible
characters and the ASCII space (RGI emoji sequences, ZWNJ only inside joining
scripts, bounded combining marks), so it has no carrier-free hidden channel; an x402 item URL must already be canonical (`new URL(url).href`). The conversation
digest is unsalted: binding, not hiding. Buyers can recompute both commitments using
the retained messages and structured intent. This release prepares protocol
primitives only; server and SDK/MCP integration remain separate work.

## 0.7.0 — 2026-10-06 — null fee-leg fields are not a fee leg (published 2026-10-06)

Minor: one fix plus additive exports. Nothing is removed or renamed.

### Fixed

- `parsePaymentSignaturePayload` (and so `decodePaymentSignatureHeader`) no
  longer counts a `null` `payload.feeAuthorization` or `payload.feeSignature`
  as half of a fee leg. A null is JSON's "absent": the payload is single-auth,
  exactly like a missing field, instead of throwing on the null half. The
  GenesisPay server always read it that way and now parses with this function,
  so the SDK and the server cannot disagree about the same bytes (GenesisPay
  MR-1004). Fail-closed is unchanged: a single-auth seller leg is validated
  against the gross amount, so a net seller leg with a null fee half is still
  refused.

### Added

- `isRecord`, `addressesEqual` and `normalizeUsdcMinorAmount` are exported from
  the package root. They were already the internal validators of every parser
  here; the GenesisPay server now imports them instead of keeping copies.

## 0.6.0 — the fee leg's own settlement window (published 2026-10-02)

Additive. `SettlementPrepareAuthority` gains an optional `feeValidBefore`: the
fee authorization's own deadline, as a positive decimal integer string, like
`validBefore`. `parseSettlementPrepareParams` (and so the header codec) accepts
it only beside a non-null `feeNonce` and never earlier than `validBefore`, and
returns it only when it was present. When it is absent, both legs share
`validBefore`, exactly as in 0.5.0 (GenesisPay ADR-0102, amendment S1b).

Compatibility: a 0.5.0 decoder drops the field as an unknown key, so a resource
that has not upgraded prepares equal windows. A client proposing a fee window
must accept that plan. Nothing existing changes.

## 0.5.0 — settlement preparation parameters as a header

Additive. Exports `GENESISPAY_SETTLEMENT_PREPARE_HEADER`
(`GENESISPAY-Settlement-Prepare`), `GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER`
(`GENESISPAY-Settlement-Prepare-Params`), `SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH`
(4096) and the codec `encodeSettlementPrepareParamsHeader` /
`decodeSettlementPrepareParamsHeader` / `parseSettlementPrepareParams` with the
`SettlementPrepareParams` and `SettlementPrepareAuthority` types.

The params are `{ payer, idempotencyKey: string | null, feeMode: "collect" |
"record_only", authority?: { sellerNonce, feeNonce | null, validBefore } }` as
base64(JSON), the x402 header encoding. Carrying them in a header lets a
preparation request repeat the purchase request exactly — method, URL, content
type and body — so a resource that validates or prices by its body can accept
it and bind it to the purchase fingerprint (ADR-0083). The decoder returns
`null` for any empty, oversized, non-base64, non-JSON or structurally invalid
value; known fields are checked strictly, unknown keys are dropped. Nothing
existing changes.

## 0.4.0 — canonical asset deployments and experimental contract authority

Additive. Exports `GENESISPAY_ASSET_DEPLOYMENTS`, Base chain constants, and
lookup helpers for the exact USDC/EURC deployment tuple used by the backend and
published SDKs. This makes asset, chain, token address, minor-unit scale, mode,
and EIP-712 domain one publishable source of truth under MR-102/MR-103. The
side-effect-free registry is also available through the
`@genesis-tech/genesispay-protocol/asset-deployments` subpath.

Adds the experimental atomic-payment and `contract_mandate_v1` typed-data
builders, commitment/hash helpers, subscription charge identity helper, and
immutable `MandateExecutor`/`BatchSettler` ABIs. These exports construct and
validate payloads only. They do not activate contract admission, approve a
deployment, or grant Mainnet clearance (MR-401/MR-403).

### Node settlement entry points

Expose the existing synchronous ESM graph through Node's `module-sync` condition
for both public entry points. Node runtimes with synchronous ESM support can
load the same module from `require`, including the application's Node 24+ tsx
worker/operator entry points. ESM imports and older ESM consumers are unchanged;
there is no separate CommonJS build or protocol behavior change.

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
