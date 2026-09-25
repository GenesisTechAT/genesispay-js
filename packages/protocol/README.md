# @genesis-tech/genesispay-protocol

Pure x402 V2 protocol types and encode/decode/validate helpers, shared by the
GenesisPay SDKs (`@genesis-tech/genesispay-seller`, `@genesis-tech/genesispay-agent`). No I/O, no framework
coupling — just typed payload builders, base64 header codecs, strict parsers,
and EIP-3009 (`transferWithAuthorization`) typed-data helpers for USDC.

Use it if you are implementing your own x402 seller or payer and want the
wire format handled for you.

## Install

This README targets the coordinated **0.5.0 release candidate**. npm currently
serves 0.3.0; use the explicit candidate version only after it is published.

```bash
npm install @genesis-tech/genesispay-protocol@0.5.0
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
- The only runtime dependency is `viem` (EIP-712 hashing/verification).

## Experimental contract authority helpers (0.4.0 candidate)

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
