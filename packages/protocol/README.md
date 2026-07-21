# @genesis-tech/peerpay-protocol

Pure x402 V2 protocol types and encode/decode/validate helpers, shared by the
PeerDirect (formerly PeerPay) SDKs (`@genesis-tech/peerpay-seller`, `@genesis-tech/peerpay-agent`). No I/O, no framework
coupling — just typed payload builders, base64 header codecs, strict parsers,
and EIP-3009 (`transferWithAuthorization`) typed-data helpers for USDC.

Use it if you are implementing your own x402 seller or payer and want the
wire format handled for you.

## Install

```bash
npm install @genesis-tech/peerpay-protocol
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

## Quick start: decode a 402 and validate a payment

```ts
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  validatePaymentSignatureAgainstRequirement,
} from "@genesis-tech/peerpay-protocol";

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
} from "@genesis-tech/peerpay-protocol";

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
- Header name constants: `PAYMENT_REQUIRED_HEADER`, `PAYMENT_SIGNATURE_HEADER`,
  `PAYMENT_RESPONSE_HEADER`
- Types: `PaymentRequiredPayload`, `PaymentAccept`, `PaymentSignaturePayload`,
  `SettlementResponsePayload`, `TransferAuthorization`, `EvmAddress`, `HexString`

## Conventions

- Money is integer USDC minor units (6 decimals) carried as decimal integer
  strings (`maxAmountRequired: "5000"` = 0.005 USDC); the human-readable
  `amount` field is display-only. No floats, ever.
- All parsers accept `unknown` and validate structurally before returning
  typed values — safe to point at untrusted input.
- The only runtime dependency is `viem` (EIP-712 hashing/verification).
