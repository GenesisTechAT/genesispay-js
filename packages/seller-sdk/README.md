# @genesis-tech/peerpay-seller

Framework-agnostic x402 payment gate for sellers, powered by PeerDirect (formerly PeerPay).

Wrap any Web-standard `(Request) => Response` handler and it becomes a paid
endpoint:

- Requests without payment get `402 Payment Required` with an x402 V2
  `PAYMENT-REQUIRED` header (and JSON body) describing the USDC payment.
- Requests carrying a `PAYMENT-SIGNATURE` header are structurally validated
  against the requirement, settled via your `verifySettlement` hook, and — on
  success — your handler runs and its response carries a `PAYMENT-RESPONSE`
  header with the settlement receipt (tx hash, payer, amount).

Works with Next.js route handlers, Hono, Bun.serve, and anything else that
speaks the Fetch API.

## Install

```bash
npm install @genesis-tech/peerpay-seller
```

## Quick start (PeerPay client — recommended)

The `PeerPay` client configures from **just the seller API key**. The key prefix
(`pp_sk_test_…` / `pp_sk_live_…`) determines the mode and base URL, and the payout
wallet + network are resolved from the key via the PeerPay backend and cached.

```ts
import { PeerPay } from "@genesis-tech/peerpay-seller";

const peerpay = new PeerPay({ apiKey: process.env.PEERPAY_SELLER_API_KEY! });

// Human hosted checkout — the wallet is defaulted server-side from the key.
// `metadata` and `clientReferenceId` come back on retrieve() and on the webhook,
// so you never need your own table just to map a link back to a buyer:
const { publicId, payUrl } = await peerpay.checkout.create({
  title: "50 credits",
  amountUsdc: "5.00",
  clientReferenceId: order.id,
  metadata: { buyerId: user.id, plan: "starter" },
  returnUrl: "https://shop.example.com/thanks",
  cancelUrl: "https://shop.example.com/cart",
});

// Poll for settlement:
const session = await peerpay.checkout.retrieve(publicId);
if (session.paid) fulfil(session.clientReferenceId);
// An unknown id throws PeerPayNotFoundError, not PeerPayConfigError — so a
// typo'd id is distinguishable from a broken key or an unreachable backend.

// Agent x402 gate — payTo + network resolved from the key, settlement auto-wired:
export const GET = peerpay.gate({ amountUsdc: "0.02" }).wrap(
  async () => Response.json({ data: "the good stuff" }),
);
```

### Webhooks

Prefer a webhook over polling. Verification is one call — it checks the HMAC in
constant time and enforces a replay window on the signature timestamp:

```ts
import { constructEvent, PeerPaySignatureVerificationError } from "@genesis-tech/peerpay-seller";

export async function POST(request: Request) {
  const rawBody = await request.text(); // raw — never re-serialize before verifying
  try {
    const event = await constructEvent(
      rawBody,
      request.headers.get("PEERPAY-SIGNATURE") ?? "",
      process.env.PEERPAY_WEBHOOK_SECRET!,
    );
    if (event.type === "payment.confirmed") await fulfil(event.data);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof PeerPaySignatureVerificationError) {
      return new Response("invalid signature", { status: 400 });
    }
    throw error;
  }
}
```

`constructEvent` is **async** — unlike Stripe's synchronous equivalent. It is built
on WebCrypto rather than `node:crypto` so the SDK also runs on Edge, Workers and
Bun. It is available as a free function (a webhook route rarely has a client in
scope) and as `peerpay.webhooks.constructEvent(…)`. Default replay tolerance is
300 s in both directions; override with `{ toleranceSeconds }`. Multiple `v1=`
values in the header are all checked, so you can rotate an endpoint secret without
dropping deliveries.

**One settlement can reach you twice — handle both cases separately.**

- *Retries*: a delivery is attempted up to three times on a non-2xx response, and
  `event.id` is stable across those attempts. Dedupe on `event.id` before fulfilling.
- *The event pair*: a **single-use** link emits both `payment.confirmed` and
  `link.paid` for the same settlement. These are two distinct deliveries with two
  **different** `event.id`s, so `event.id` will not collapse them — branch on
  `event.type` and fulfil on one of them. Reusable links emit only
  `payment.confirmed`.

### Subscriptions

Plans are the reusable template you create once and hand to any number of
customers. You do **not** need your own billing cron — renewals run on our
scheduler.

```ts
const plan = await peerpay.plans.create({
  title: "Pro",
  amountPerPeriod: "9.00",
  periodDays: 30,
});

// Send the customer to the hosted subscription checkout:
redirect(plan.checkoutUrl);
```

The customer signs one permit there; after that, renewals are charged without
further signatures and emit `subscription.renewed` (or `subscription.past_due`).
`peerpay.mandates.*` exposes the per-payer authorizations underneath —
`create`, `retrieve`, `charge` (per-use metering) and `revoke`.

There is deliberately **no `mandates.activate`**: activation requires the payer's
own signature over the permit, so it belongs in the payer's frontend, not in a
server holding your secret key.

**Cancelling a subscription** — list the plan's subscribers, find the payer, revoke:

```ts
let startingAfter: string | undefined;
let hasMore = true;
while (hasMore) {
  const page = await peerpay.mandates.list({
    planId: plan.publicId,
    status: "active",
    startingAfter,
  });
  const match = page.mandates.find(
    (m) => m.payerWallet.toLowerCase() === wallet.toLowerCase(),
  );
  if (match) return peerpay.mandates.revoke(match.id);
  startingAfter = page.mandates.at(-1)?.id;
  hasMore = page.hasMore;
}
```

Pagination is keyset-based: `startingAfter` is the id of the last mandate on the
previous page. Revoking is idempotent — a second call changes nothing and emits
no second `mandate.revoked`.

Note: failed renewals are reported as events, but there is no automatic dunning
(retry escalation, grace periods) yet — build that on
`subscription.past_due` / `mandate.charge_failed` for now.

### Testing the paid path

```ts
const session = await peerpay.checkout.simulatePayment(publicId);
// session.paid === true, and the real webhooks have fired.
```

Test keys only — a `pp_sk_live_…` key gets a 403, and on a mainnet deployment the
endpoint does not exist at all. The resulting attempt has `txHash: null` (no
transaction happened) and `simulated: true`; branch on that flag rather than on
the missing hash, because a *pending real* attempt has no hash either.

### Redirect parameters are not proof of payment

The hosted checkout appends `?peerpay_link_id=…&peerpay_status=paid` to your
`returnUrl`. Those parameters are a **UI hint only** — they are not signed, and a
payer can navigate to that URL directly without paying. Fulfil on the
`payment.confirmed` webhook or on `checkout.retrieve(publicId).paid`, never on the
query string.

### Limits

| Field | Limit |
|---|---|
| `metadata` | 20 keys; keys ≤ 40 chars; values must be strings, ≤ 500 chars; ≤ 4096 bytes serialized |
| `clientReferenceId` | ≤ 200 chars |
| `returnUrl` / `cancelUrl` | ≤ 2048 chars, `https` only (`http` allowed for localhost) |

Exceeding any of these fails the `checkout.create` call server-side with a 422.

### Note on `paid` for reusable links

`session.paid` is derived from `confirmedPaymentCount > 0`. For a `reusable` link
that counter only ever grows, so `paid` stays `true` from the first payment
onward — it answers "has this link ever been paid", not "has *this* buyer paid".
For per-buyer fulfilment on a reusable link, use a webhook, or track
`confirmedPaymentCount` as a delta.

Options: `baseUrl` (override the mode default — https, http only for localhost;
both modes default to the PeerPay facilitator, so it is optional), `configTtlMs`
(seller-config cache TTL, default 5 min), `expectedPayTo` (recommended for `live`
keys — a local pin that fail-closes if the resolved wallet ever differs), `fetchFn`.
The client fails **closed**: an unreachable backend returns `503` and a seller with
no wallet returns a `402` `payment_not_configured` — the paid handler never runs
without a valid destination. It also refuses to advertise a wallet whose network
doesn't match the SDK's native-USDC table or the key mode.

The low-level `createPaymentGate` / `peerPaySettlement` primitives below remain
available for advanced cases (custom wallet/network per gate, self-hosting).

## Quick start (Next.js route handler)

```ts
// app/api/premium/route.ts
import { createPaymentGate, peerPaySettlement } from "@genesis-tech/peerpay-seller";

const gate = createPaymentGate({
  amountUsdc: "0.10",
  payTo: "0xYourWalletAddress",
  description: "Premium market data",
  network: "base-sepolia", // or "base" for mainnet
});

const verifySettlement = peerPaySettlement({
  facilitatorBaseUrl: "https://your-peerpay-instance.example",
  apiKey: process.env.PEERPAY_SELLER_KEY!, // pp_sk_...
});

export const GET = gate.wrap(
  async () => Response.json({ data: "the good stuff" }),
  { verifySettlement },
);
```

Next.js route context (`{ params }`) is passed through to your handler
untouched, so dynamic routes work as usual:

```ts
export const GET = gate.wrap(
  async (request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return Response.json({ id });
  },
  { verifySettlement },
);
```

## Quick start (Hono)

```ts
import { Hono } from "hono";
import { createPaymentGate, peerPaySettlement } from "@genesis-tech/peerpay-seller";

const gate = createPaymentGate({
  amountUsdc: "0.05",
  payTo: "0xYourWalletAddress",
  description: "Paid API call",
  network: "base-sepolia",
});

const gated = gate.wrap(
  async () => Response.json({ ok: true }),
  {
    verifySettlement: peerPaySettlement({
      facilitatorBaseUrl: "https://your-peerpay-instance.example",
      apiKey: process.env.PEERPAY_SELLER_KEY!,
    }),
  },
);

const app = new Hono();
app.get("/premium", (c) => gated(c.req.raw));

export default app;
```

The same wrapped handler drops straight into `Bun.serve({ fetch: gated })`.

## Configuration

`createPaymentGate(config)`:

| Option | Required | Description |
| --- | --- | --- |
| `amountUsdc` | yes | Decimal USDC amount, e.g. `"0.10"` (max 6 decimals). |
| `payTo` | yes | EVM wallet address that receives the USDC. |
| `description` | no | Shown to payers in the payment requirement. |
| `network` | no | `"base-sepolia"` (default) or `"base"`. |
| `resource` | no | Canonical resource URL. Defaults to the request URL (query stripped). |
| `mimeType` | no | MIME type of the paid resource (default `application/json`). |
| `maxTimeoutSeconds` | no | Advertised authorization validity window (default 300). |

`gate.wrap(handler, { verifySettlement })` requires a settlement hook. Use the
built-in `peerPaySettlement({ facilitatorBaseUrl, apiKey })`, which POSTs the
payment to PeerDirect's facilitator (`/api/v1/facilitator/settle`). PeerDirect
broadcasts the EIP-3009 authorization on-chain, verifies the USDC transfer,
and returns the receipt. `facilitatorBaseUrl` is optional and defaults to the
public development facilitator (`DEFAULT_FACILITATOR_BASE_URL`,
`https://peerpay-app-development.up.railway.app`), so you can omit it in dev —
set it explicitly for production. Or supply your own hook:

```ts
import type { VerifySettlement } from "@genesis-tech/peerpay-seller";

const verifySettlement: VerifySettlement = async ({ payment, requirement }) => {
  // settle + verify however you like, then:
  return {
    ok: true,
    settlement: {
      success: true,
      transaction: "0x...",
      network: requirement.network,
      amount: requirement.maxAmountRequired,
      payer: payment.payload.authorization.from,
    },
  };
};
```

## Notes

- Amounts are handled as integer USDC minor units (6 decimals) internally —
  never floats.
- The gate performs structural validation only (amount, destination, network,
  validity window). Actual money movement and on-chain verification happen in
  your `verifySettlement` hook.
- Get a seller API key (`pp_sk_...`) from your PeerDirect dashboard under
  Developers.
