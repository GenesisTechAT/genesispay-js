# @genesis-tech/genesispay-protocol

Pure x402 V2 and purchase-intent types, codecs and digest helpers, shared by the
GenesisPay SDKs (`@genesis-tech/genesispay-seller`, `@genesis-tech/genesispay-agent`). No I/O, no framework
coupling — just typed payload builders, base64 header codecs, strict parsers,
and EIP-3009 (`transferWithAuthorization`) typed-data helpers for USDC.

Use it if you are implementing your own x402 seller or payer and want the
wire format handled for you.

## Install

This README documents **0.8.0** (prepared, not published).

```bash
npm install @genesis-tech/genesispay-protocol@0.8.0
```

## The three headers

| Header | Direction | Payload type |
| --- | --- | --- |
| `PAYMENT-REQUIRED` | server → client, with HTTP 402 | `PaymentRequiredPayload` — what to pay (USDC amount, chain, destination). |
| `PAYMENT-SIGNATURE` | client → server, on retry | `PaymentSignaturePayload` — the accepted requirement + a signed EIP-3009 transfer authorization. |
| `PAYMENT-RESPONSE` | server → client, with the paid response | `SettlementResponsePayload` — the settlement receipt (tx hash, payer, amount). |

Each has the same helper trio: `build*Payload` / `encode*Header` (payload →
base64 JSON) / `decode*Header` (base64 JSON → validated payload), plus a
`parse*Payload(value: unknown)` for bodies that arrive as plain JSON. Parsers
throw descriptive `Error`s on any structural problem — nothing is coerced
silently.

## Purchase intent and conversation commitments (0.8.0)

An agent commits to a structured purchase intent and a SHA-256 digest of the
purchase conversation. **The payment API receives only intent fields and the
conversation digest; GenesisPay never stores conversation text.** These are pure
protocol helpers. Prepared Agent SDK/MCP 2.0.0 use them for local hashing; hosted
MCP processes visible turns in memory only after owner activation following the
privacy amendment. Hosted capture remains off until then.

```ts
import {
  digestPurchaseConversation,
  digestPurchaseIntent,
  parsePurchaseIntent,
  serializePurchaseConversation,
  serializePurchaseIntent,
} from "@genesis-tech/genesispay-protocol";

// Retain the visible purchase turns locally so the buyer can recompute the hash.
const messages = [
  { role: "user", content: "Buy the report for at most 1.01 USDC including fees." },
  { role: "assistant", content: "I will buy https://example.com/report." },
] as const;
const intent = parsePurchaseIntent({
  version: 1,
  item: { kind: "x402_resource", url: "https://example.com/report" },
  maxTotal: { asset: "USDC", amountMinor: "1010000" },
  delivery: null,
  approvalQuote: "Buy the report for at most 1.01 USDC including fees.",
  conversationDigest: digestPurchaseConversation(messages),
});
const intentDigest = digestPurchaseIntent(intent);
// The buyer uses the same visible messages and intent to recompute both digests.
const conversationJson = serializePurchaseConversation(messages);
const intentJson = serializePurchaseIntent(intent);
```

The alternative item is
`{ kind: "commerce_product", productId: "prod_12345678", quantity: 2, shippingOptionId: "flat_rate:1" }`,
paired with `delivery: { kind: "saved_shipping_profile" }`. There is no address,
profile ID or fingerprint in the intent. Product IDs match
`^prod_[A-Za-z0-9_-]{8,187}$`, quantity is 1–20, and the option ID is 1–300
UTF-16 code units. An x402 item requires `delivery: null`; its URL is HTTP(S),
has no credentials, is at most 2048 code units, and must already be in its
canonical form `new URL(url).href` (a non-canonical URL is refused, not rewritten). Consumers must match that URL to the normalized request URL;
for commerce they must match product ID and quantity to the opened quote's
claims and shipping option ID to the request.

`maxTotal` carries `USDC` or `EURC` plus a positive decimal minor-unit string,
without leading zeros, at most `9223372036854775807`. Both assets have six
decimals (MR-101/MR-102). This bounds **total debit**, including the MR-1013
buyer fee; for commerce it bounds the sealed option total. The existing
`maxAmount` bounds price only. Enforcement belongs to the consumer/server.
`approvalQuote` is 1–500 UTF-16 code units (at most 1,500 UTF-8 bytes),
an NFC allow-list with no carrier-free hidden channel: every code point is a
visible letter, mark, number, punctuation or symbol, or the ASCII space — no
control, separator, private-use, unassigned or default-ignorable code point, no
look-alike blank (NBSP, U+2000–U+200A, U+3000, Braille blank), no U+FFFC and no
blank-drawn symbol (U+303F, U+13441, U+13442, U+1D159, U+1DA7F, U+1DA80), and
no run of spaces. Tag-sequence flags (England, Scotland, Wales) are refused,
because tag characters are default-ignorable.
Combining marks sit on a letter or number, at most three in a row, never the
same mark twice in a row; a grapheme
with ZWJ, U+FE0F or a keycap must be one recommended (RGI) emoji; U+FE0E only
follows a pictograph; ZWNJ only separates two letters of the same joining script
(Arabic, Syriac, N'Ko, Mongolian; in the Indic scripts after a vowel sign or
virama). No leading or trailing space. What remains needs a visible character
per bit — homoglyphs (Latin `a` vs Cyrillic `а`) and the bidi order of visible
letters next to digits — so a consumer shows amounts from `maxTotal`, never from
the quote. Validity follows the JS engine's Unicode tables (an engine without
the ES2024 `v` regex flag refuses emoji sequences); GenesisPay's server verdict
is authoritative, and the digest never depends on those tables. Show the quote
as escaped plain text (ideally `white-space: pre-wrap`), never as Markdown or
HTML, where markup such as `<!-- -->` or `[](…)` renders as nothing. The intent
names an asset, not a chain: the consumer binds the network from its own
environment and the matched offer, never from the intent;
invalid input is refused rather than trimmed. Every intent object has exactly
the documented keys, including at nested levels. `parsePurchaseIntent` returns
fresh objects in canonical key order.

The **frozen version-1 canonical forms are a public contract**:

- Intent keys, in order: `type: "genesispay.purchase_intent"`, `version: 1`,
  `item`, `maxTotal`, `delivery`, `approvalQuote`, `conversationDigest`.
  Nested key order follows the shapes above: `kind, url` or
  `kind, productId, quantity, shippingOptionId`; `asset, amountMinor`; `kind`.
- Conversation keys, in order: `type: "genesispay.purchase_conversation"`,
  `version: 1`, `messages`, with each message exactly `{ role, content }`.
  At least one message and one `user` turn are required; only `user` and
  `assistant` roles are allowed. System/tool turns are excluded. Content is a
  non-empty, well-formed Unicode string, kept verbatim: no trim or Unicode
  normalization, including trailing spaces. There is no protocol size cap.

To recompute either digest independently, serialize the corresponding canonical
form with `JSON.stringify` and no whitespace, encode it as UTF-8, hash with
SHA-256, and prefix the 64 lowercase hex digits (without `0x`) with `sha256:`.
Caller key order never affects serialization. `isPurchaseDigest` checks this
exact digest format. A commitment permits comparison with retained messages;
it does not attest their origin. The conversation digest is unsalted: it binds
the messages but does not hide a short or guessable conversation from anyone
holding the digest, so treat it as pseudonymous personal data, not as anonymous.

## GenesisPay settlement preparation header (0.5.0)

A GenesisPay resource advertises a prepare endpoint with its 402. Before
signing, the client sends `GENESISPAY-Settlement-Prepare: 1` and — from 0.5.0 —
the plan parameters in `GENESISPAY-Settlement-Prepare-Params`, so the
preparation can repeat the purchase request (method, URL, content type, body)
unchanged and the resource can bind it to that purchase:

```ts
import {
  GENESISPAY_SETTLEMENT_PREPARE_HEADER,
  GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER,
  decodeSettlementPrepareParamsHeader,
  encodeSettlementPrepareParamsHeader,
} from "@genesis-tech/genesispay-protocol";

const headers = {
  [GENESISPAY_SETTLEMENT_PREPARE_HEADER]: "1",
  [GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER]: encodeSettlementPrepareParamsHeader({
    payer: "0x…",
    idempotencyKey: "order-42", // or null
    feeMode: "collect", // or "record_only"
    authority: { sellerNonce: "0x…32 bytes", feeNonce: null, validBefore: "1790000000" },
  }),
};

// Resource side: null means refuse the preparation (never read the body instead).
const params = decodeSettlementPrepareParamsHeader(value);
```

The value is base64 JSON, at most `SETTLEMENT_PREPARE_PARAMS_HEADER_MAX_LENGTH`
(4096) characters. Known fields are validated strictly (`payer` is returned
checksummed, `idempotencyKey` is `null` or 1–255 characters, nonces are 32-byte
hex, `validBefore` a positive decimal integer string); unknown keys are dropped.
The older form, with the same fields as the JSON request body, remains
supported by the GenesisPay seller SDK.

### The fee leg's own window (0.6.0)

`authority.feeValidBefore` is optional: the deadline the payer proposes for the
**fee** authorization, in the same format as `validBefore`. GenesisPay releases
a fee authorization only after the seller transfer is verified, so a fee leg
that shared the short seller window could expire while a delayed seller
settlement was still finishing. With the field, the fee leg can live longer:

```ts
authority: {
  sellerNonce: "0x…32 bytes",
  feeNonce: "0x…32 bytes",
  validBefore: "1790000300", // seller leg: e.g. now + 300 s
  feeValidBefore: "1790086340", // fee leg: up to now + 24 h
}
```

The parser accepts it only beside a non-null `feeNonce`, and never earlier than
`validBefore`. A GenesisPay resource additionally refuses a value later than
now + 24 hours. When the field is absent, both legs share `validBefore`,
exactly as in 0.5.0.

Compatibility: a resource on protocol 0.5.0 drops the field as an unknown key
and prepares both legs on `validBefore`. That is safe: the payer signs only
what the returned plan states. A client that proposes a fee window must
therefore accept a plan whose fee window equals the seller window, and should
refuse any fee window shorter than the seller window or longer than it
proposed.

## Quick start: decode a 402 and validate a payment

```ts
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  validatePaymentSignatureAgainstRequirement,
} from "@genesis-tech/genesispay-protocol";

// Payer side: a request came back 402 — what does it cost?
const required = decodePaymentRequiredHeader(
  response.headers.get(PAYMENT_REQUIRED_HEADER)!,
);
const accept = required.accepts[0];
console.log(accept.amount, "USDC →", accept.payTo, "on chain", accept.chainId);

// Seller side: a retry arrived carrying a signature — does it match my requirement?
const payment = decodePaymentSignatureHeader(
  request.headers.get(PAYMENT_SIGNATURE_HEADER)!,
);
validatePaymentSignatureAgainstRequirement({ payment, requirement: accept });
// throws with a precise reason on amount/destination/network/window mismatch
```

## EIP-3009 typed data

USDC moves via `transferWithAuthorization` — the payer signs an EIP-712 typed
message off-chain, and anyone (a facilitator) can broadcast it:

```ts
import {
  buildTransferAuthorizationTypedData,
  verifyTransferAuthorizationSignature,
} from "@genesis-tech/genesispay-protocol";

const typedData = buildTransferAuthorizationTypedData({
  authorization, // from/to/value/validAfter/validBefore/nonce
  usdc: { chainId: 84532, address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
});
// sign typedData with your wallet, then later:
const ok = await verifyTransferAuthorizationSignature({
  authorization,
  signature,
  usdc,
});
```

## API surface

- `PURCHASE_INTENT_VERSION` / `PURCHASE_INTENT_APPROVAL_QUOTE_MAX_LENGTH` /
  `parsePurchaseIntent` / `serializePurchaseIntent` / `digestPurchaseIntent` /
  `serializePurchaseConversation` / `digestPurchaseConversation` / `isPurchaseDigest`
- Purchase types: `PurchaseIntent`, `PurchaseIntentItem`, `PurchaseIntentMaxTotal`,
  `PurchaseConversationMessage`, `PurchaseDigest`
- `GENESISPAY_ASSET_DEPLOYMENTS` / `getGenesisPayAssetDeployment` /
  `getGenesisPayAssetDeploymentByChain` — canonical Base USDC/EURC identity
  tuples shared by the backend and SDKs
- `BASE_MAINNET_CHAIN_ID` / `BASE_SEPOLIA_CHAIN_ID` /
  `GENESISPAY_ASSET_SYMBOLS`

- `buildPaymentRequiredPayload` / `encodePaymentRequiredHeader` /
  `decodePaymentRequiredHeader` / `parsePaymentRequiredPayload`
- `encodePaymentSignatureHeader` / `decodePaymentSignatureHeader` /
  `parsePaymentSignaturePayload` / `parseTransferAuthorization` /
  `validatePaymentSignatureAgainstRequirement`
- `buildSettlementResponse` / `encodeSettlementResponseHeader` /
  `decodeSettlementResponseHeader` / `parseSettlementResponsePayload`
- `buildTransferAuthorizationTypedData` / `verifyTransferAuthorizationSignature` /
  `transferWithAuthorizationTypes` / `USDC_EIP712_DOMAIN_NAME` /
  `USDC_EIP712_DOMAIN_VERSION`
- `encodeSettlementPrepareParamsHeader` / `decodeSettlementPrepareParamsHeader` /
  `parseSettlementPrepareParams` — GenesisPay settlement-preparation parameters
- `isRecord` / `addressesEqual` / `normalizeUsdcMinorAmount` — the field
  validators the parsers use (a plain-object check, a checksum-insensitive EVM
  address comparison, a positive minor-unit amount as a decimal string)
- Header name constants: `PAYMENT_REQUIRED_HEADER`, `PAYMENT_SIGNATURE_HEADER`,
  `PAYMENT_RESPONSE_HEADER`, `GENESISPAY_SETTLEMENT_PREPARE_HEADER`,
  `GENESISPAY_SETTLEMENT_PREPARE_PARAMS_HEADER`
- Types: `PaymentRequiredPayload`, `PaymentAccept`, `PaymentSignaturePayload`,
  `SettlementResponsePayload`, `TransferAuthorization`, `SettlementPrepareParams`,
  `SettlementPrepareAuthority`, `EvmAddress`, `HexString`

## Conventions

- Money is integer USDC minor units (6 decimals) carried as decimal integer
  strings (`maxAmountRequired: "5000"` = 0.005 USDC); the human-readable
  `amount` field is display-only. No floats, ever.
- All parsers accept `unknown` and validate structurally before returning
  typed values — safe to point at untrusted input.
- A `PAYMENT-SIGNATURE` fee leg (`payload.feeAuthorization` +
  `payload.feeSignature`) is used only when both are present and not `null`.
  A missing or `null` half makes the payload single-auth, and the seller leg is
  then checked against the gross amount (since 0.7.0 a `null` half no longer
  throws).
- The only runtime dependency is `viem` (EIP-712 hashing/verification).

## Experimental contract authority helpers (since 0.4.0)

`contract-authority` exports `atomicPaymentCommitment`,
`buildAtomicPaymentTypedData`, `buildMandateTermsTypedData`,
`mandateTermsDigest`, `mandateTermsStructHash`,
`mandateSubscriptionChargeId`, `buildMandatePermitTypedData`,
`buildMandateChargeTypedData` and `buildMandateRevocationTypedData`, plus
`mandateExecutorAbi`, `batchSettlerAbi`, and their supporting typed-data
constants/types. These are pure validation and signing-payload primitives for
the gated `contract_mandate_v1` and atomic-settlement paths. Exporting them does
not enable either path, approve a deployment, or grant Mainnet clearance. Do
not substitute them for existing direct x402 authorizations.

Amounts/caps/deadlines/nonces are bigint values. `ContractDeployment` binds
chain, token, executor address and version. Obtain token domain name/version
from its reviewed native deployment. For a batch payment, independently build
`AtomicPaymentTerms` from the displayed seller, treasury, amounts, payment ID
and salt, then call `buildAtomicPaymentTypedData` with validity and token domain.
It derives the ReceiveWithAuthorization nonce from all allocation terms; never
sign an arbitrary supplied nonce as proof of the split.

Mandate activation requires both terms and Permit signatures. The Permit value
is the signed expected outstanding commitment plus the new lifetime cap, never
unlimited. Read current aggregate and token nonce before constructing a
proposal; a stale proposal must be rebuilt and approved again. Per-use charges
require their own one-use signature after server agent-policy approval. A
revocation signature can be independently relayed, but confirmation must be
proved on chain before presenting it as effective. The seller SDK exposes gated
orchestration for mandate proposal and charge payloads. Admission remains off
unless the reviewed backend registry and environment gates permit the exact
deployment; Mainnet additionally requires the separate legal, audit, cutover,
and canary evidence.
