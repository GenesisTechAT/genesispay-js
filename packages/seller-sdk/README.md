# @genesis-tech/genesispay-seller

Framework-agnostic x402 payment gate for sellers, powered by GenesisPay (formerly GenesisPay).

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
npm install @genesis-tech/genesispay-seller
```

## Quick start (legacy `GenesisPay` client — recommended)

The `GenesisPay` client configures from **just the seller API key**. The key prefix
(`gp_sk_test_…` / `gp_sk_live_…`) determines the mode and base URL, and the payout
wallet + network are resolved from the key via the GenesisPay backend and cached.

```ts
import { GenesisPay } from "@genesis-tech/genesispay-seller";

const genesispay = new GenesisPay({ apiKey: process.env.GENESISPAY_SELLER_API_KEY! });

// Human hosted checkout — the wallet is defaulted server-side from the key.
// `metadata` and `clientReferenceId` come back on retrieve() and on the webhook,
// so you never need your own table just to map a link back to a buyer:
const { publicId, payUrl } = await genesispay.checkout.create({
  title: "50 credits",
  amount: "5.00", // decimal string in `asset` — see "Amounts and assets" below
  clientReferenceId: order.id,
  metadata: { buyerId: user.id, plan: "starter" },
  returnUrl: "https://shop.example.com/thanks",
  cancelUrl: "https://shop.example.com/cart",
});

// Poll for settlement:
const session = await genesispay.checkout.retrieve(publicId);
if (session.paid) fulfil(session.clientReferenceId);
// An unknown id throws GenesisPayNotFoundError, not GenesisPayConfigError — so a
// typo'd id is distinguishable from a broken key or an unreachable backend.

// Agent x402 gate — payTo + network resolved from the key, settlement auto-wired:
export const GET = genesispay.gate({ amountUsdc: "0.02" }).wrap(
  async () => Response.json({ data: "the good stuff" }),
);
```

### Return URL — parse the hint, then verify

When you pass `returnUrl` to `checkout.create`, the hosted checkout shows a
"Return to …" button and appends
`?genesispay_link_id=<publicId>&genesispay_status=paid` only when the payer
selects it — there is no timed auto-redirect. Those parameters are a **UI hint
only**: they are unsigned, and a payer can navigate to that URL directly without
paying. **Never fulfil on the query string**; use webhooks as the reliable
delivery path.

Use `parseCheckoutReturnHint` to read the hint, then confirm with an
**authenticated** `checkout.retrieve()` before fulfilling:

```ts
import { parseCheckoutReturnHint } from "@genesis-tech/genesispay-seller";

export async function GET(request: Request) {
  const hint = parseCheckoutReturnHint(new URL(request.url));
  if (!hint) return Response.json({ ok: true }); // no return params — nothing to do

  // hint.linkId is the link's publicId. Verify with your seller key, not the URL.
  const session = await genesispay.checkout.retrieve(hint.linkId);

  // Only single-use links are fulfilled here. A reusable link's "paid" means
  // "ever paid"; fulfil those on a payment.confirmed webhook keyed by attempt.id.
  if (session.linkType !== "single") return Response.json({ ok: true });

  // Single-use link: fulfil once, keyed by the link itself.
  if (session.paid) await fulfilOnce(hint.linkId);

  return Response.json({ ok: true });
}
```

`parseCheckoutReturnHint(url)` returns `{ linkId, status: "paid" }` only when the
URL carries a non-empty `genesispay_link_id` and an exact `genesispay_status=paid`.
Anything else — a missing id, an unknown status like `refunded`, a hand-built URL
— returns `null`. It performs **no verification**: treat it as a prompt to look
the link up with your key, never as a receipt.

This pattern fulfils a **single-use** link, keyed by `hint.linkId` (the link's
`publicId`) and refuses any other `linkType`. For a **reusable** link, `paid`
means "ever paid" and the return URL cannot say which payment triggered it —
fulfil those on verified `payment.confirmed` webhooks keyed by `attempt.id` (see
the fulfilment guide below).

### Amounts and settlement

During the beta, every new hosted checkout link settles in **USDC on Base**. An
amount is therefore a decimal dollar string — never a number:

```ts
// 5 USDC / 5 dollars:
await genesispay.checkout.create({ title: "Credits", amount: "5.00" });
```

Buyers can use EUR or USD in the Privy/MoonPay flow; MoonPay converts the local
fiat amount to USDC before settlement. The provider shows the final live quote
and fees. New `asset: "EURC"` requests are rejected during the beta; historical
EURC links remain readable.

`amountUsdc` is the **deprecated** pre-0.6.0 name for `amount`. It still works
everywhere `amount` does, on input and on output, so no existing integration
breaks.

You may pass both, and the SDK sends both on the wire so a backend older than
0.6.0 still finds the field it knows. Passing **two different amounts** throws
`GenesisPayValidationError` before the request leaves your process — a link for
money you did not mean must not be created because one field quietly won.

`gate({ amountUsdc })` keeps its name deliberately: an x402 gate prices a request
in USDC on Base, so there the currency really is part of the field.

### Webhooks

Prefer a webhook over polling. Verification is one call — it checks the HMAC in
constant time and enforces a replay window on the signature timestamp:

```ts
import { constructEvent, GenesisPaySignatureVerificationError } from "@genesis-tech/genesispay-seller";

export async function POST(request: Request) {
  const rawBody = await request.text(); // raw — never re-serialize before verifying
  try {
    const event = await constructEvent(
      rawBody,
      request.headers.get("GENESISPAY-SIGNATURE") ?? "",
      process.env.GENESISPAY_WEBHOOK_SECRET!,
    );
    if (event.type === "payment.confirmed") await fulfil(event.data);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof GenesisPaySignatureVerificationError) {
      return new Response("invalid signature", { status: 400 });
    }
    throw error;
  }
}
```

`constructEvent` is **async** — unlike Stripe's synchronous equivalent. It is built
on WebCrypto rather than `node:crypto` so the SDK also runs on Edge, Workers and
Bun. It is available as a free function (a webhook route rarely has a client in
scope) and as `genesispay.webhooks.constructEvent(…)`. Default replay tolerance is
300 s in both directions; override with `{ toleranceSeconds }`. Multiple `v1=`
values in the header are all checked, so you can rotate an endpoint secret without
dropping deliveries.

**Read `event.data.link.asset` before you book the money.** The payment payload
carries `amount` (a decimal string) and the `asset` it is denominated in — euros
on an EURC link, dollars on a USDC one. `amountUsdc` is the deprecated alias carrying the identical value;
on an EURC link its name is simply wrong, which is why `amount` replaced it.
`amountUsdcMinor` keeps its name and its meaning: the integer minor units of that
same amount.

```ts
if (event.type === "payment.confirmed") {
  const { asset, amount, amountUsdcMinor } = event.data.link;
  // `asset` is typed optional: a delivery enqueued before 0.7.0 is retried
  // verbatim and arrives without one. Do not default it — guessing "USDC" on a
  // euro payment is the bug this field removes. A missing `asset` is genuinely
  // unbookable; that is why it, and not `amount`, is the guard.
  if (!asset) return ack("asset missing — resolving via checkout.retrieve");
  await recordRevenue({ currency: asset, amount, minorUnits: BigInt(amountUsdcMinor) });
}
```

`event.data.attempt.chainId` is the chain `attempt.txHash` is on — read the two
together, since the same hash resolves to nothing on the wrong chain. It is on
the *attempt*, not the link, because a pay-by-bank settlement mints on whatever
chain the provider uses, which need not be the link's.

A missing `chainId` is **not** the same problem as a missing `asset` — the amount
and currency are still fully determined — but what to do about it depends on you.
If your endpoint only ever receives one chain, book the payment and skip the
explorer link. If it can receive more than one, resolve through
`checkout.retrieve` before booking: an amount whose chain you cannot name is
exactly what this field exists to prevent you from mis-booking.

Either way, do not default it, and mind the polarity: `undefined !== 8453` is
`true`, so `if (chainId !== 8453)` reads a missing chain as testnet and its
mirror reads it as mainnet. Branch on presence first. And do not assume the set
is Base-only — a pay-by-bank settlement reports the provider's chain, which can
be Gnosis, Polygon or Ethereum.

**One settlement can reach you twice — handle both cases separately.**

- *Retries*: a delivery is attempted up to three times on a non-2xx response, and
  `event.id` is stable across those attempts. Dedupe on `event.id` before fulfilling.
- *The event pair*: a **single-use** link emits both `payment.confirmed` and
  `link.paid` for the same settlement. These are two distinct deliveries with two
  **different** `event.id`s, so `event.id` will not collapse them — branch on
  `event.type` and fulfil on one of them. Reusable links emit only
  `payment.confirmed`.

### Invoices

Invoices are one-off commercial billing documents. Create or reuse a customer,
build a draft, then finalize it. Finalization freezes the billing details and
creates exactly one single-use payment link; a draft cannot be paid or emailed.

```ts
const customer = await genesispay.customers.create({
  name: "Ada Lovelace",
  email: "ada@example.com",
  companyName: "Analytical Engines Ltd",
  countryCode: "GB",
});

const draft = await genesispay.invoices.create({
  customerId: customer.publicId,
  asset: "EURC",
  dueAt: "2026-08-31T23:59:59.999Z",
  taxBps: 2_300, // 23%; manual rate, not automated tax advice
  lineItems: [
    { description: "Consulting", quantity: 2, unitAmount: "450.00" },
  ],
});

const invoice = await genesispay.invoices.finalize(draft.publicId);
await genesispay.invoices.send(invoice.publicId, {
  idempotencyKey: `invoice-${invoice.publicId}-initial`,
});

invoice.hostedInvoiceUrl; // customer-facing document
invoice.pdfUrl;           // printable PDF
invoice.payment.payUrl;   // canonical GenesisPay checkout
```

All invoice money fields ending in `Minor` are integer strings. `paid` is a
read-only projection of a confirmed, non-simulated GenesisPay payment; it cannot
be set through the SDK. Finalized invoices cannot be edited. Use
`invoices.void()` to cancel collection or `invoices.markUncollectible()` to write
off an unpaid invoice.

### Subscriptions

Plans are the reusable template you create once and hand to any number of
customers. You do **not** need your own billing cron — renewals run on our
scheduler.

```ts
const plan = await genesispay.plans.create({
  title: "Pro",
  amountPerPeriod: "9.00",
  periodDays: 30,
});

// Send the customer to the hosted subscription checkout:
redirect(plan.checkoutUrl);
```

The customer signs one permit there; after that, renewals are charged without
further signatures and emit `subscription.renewed` (or `subscription.past_due`).
`genesispay.mandates.*` exposes the per-payer authorizations underneath —
`create`, `retrieve`, `charge` (per-use metering) and `revoke`.

There is deliberately **no `mandates.activate`**: activation requires the payer's
own signature over the permit, so it belongs in the payer's frontend, not in a
server holding your secret key.

**Cancelling a subscription** — list the plan's subscribers, find the payer, revoke:

```ts
let startingAfter: string | undefined;
let hasMore = true;
while (hasMore) {
  const page = await genesispay.mandates.list({
    planId: plan.publicId,
    status: "active",
    startingAfter,
  });
  const match = page.mandates.find(
    (m) => m.payerWallet.toLowerCase() === wallet.toLowerCase(),
  );
  if (match) return genesispay.mandates.revoke(match.id);
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

### Products

A product is a catalogue entry; its payable instance is **one canonical
reusable checkout link**, minted idempotently — mint again (even concurrently)
and you get the same link with `created: false`.

```ts
const product = await genesispay.products.create({
  name: "Market data report",
  price: "2.00",
  sku: "MDR-1",
  // A redirect product creates a signed, expiring entitlement on every sale.
  delivery: {
    type: "redirect",
    url: "https://your-site.example/download",
    verifiedAt: null,
  },
});

const { link, created } = await genesispay.products.createPaymentLink(
  product.publicId,
);
// Share link.payUrl — every sale of this product settles through it.
```

#### Never hardcode `link.payUrl`

The URL embeds the link's `inv_…` id, and that id is **per link, not per
product**: when a link is archived and reminted (for example during a wallet
migration) the new link gets a new `inv_…`, and every hardcoded copy of the old
`link.payUrl` — a button in your shop, a page in your docs, an email template —
silently breaks.

Store the **product's** `publicId` (`prod_…`) instead; it never changes. Because
the permanent URL is deterministic (`{baseUrl}/pay/p/{publicId}`), derive it at
render time — don't store the URL itself in a config file or env var. Then either:

- build the permanent URL — `genesispay.products.permalink(product.publicId)`
  returns `{baseUrl}/pay/p/{publicId}`: pure string builder, no network call,
  no mint, and stable across every remint because the server resolves the
  product's *current* canonical link on every request. **This is the URL to
  embed in a buy button.**
- or resolve the current link's `payUrl` at render time —
  `await genesispay.products.checkoutUrl(product.publicId)` (a convenience for
  `createPaymentLink(publicId)` → `link.payUrl`). The mint is idempotent, but
  it is still a write — don't put it in a hot render path uncached, and never
  persist the result.

A confirmed purchase fires the `product.purchased` webhook. Its payload
carries the buyer's entitlement — `entitlement.redemptionPath` is a signed,
expiring redirect (~30 days) to your fulfilment URL, with `gp_*` parameters
(`gp_entitlement`, `gp_attempt`, `gp_simulated`, …) you can verify server-side
via `GET /api/v1/entitlements/verify`. Always check `simulated`: test-mode
purchases deliver end to end, marked, so your handler must not book them as
revenue.

Use the SDK rather than trusting `gp_*` query parameters from the browser:

```ts
const verified = await genesispay.entitlements.verify(entitlementId);
if (
  !verified.valid ||
  verified.entitlement.simulated ||
  verified.entitlement.productId !== product.publicId
) {
  throw new Error("invalid entitlement");
}
// Insert verified.entitlement.publicId under a unique constraint, then fulfil.
```

### Product-backed API gate

For an API you operate, define the resource and its price once in the catalogue.
The product link—not browser input or route code—is the authority for the USDC
amount, Base network, destination, fee snapshot and product metadata:

```ts
const forecast = await genesispay.products.create({
  name: "Forecast API call",
  price: "0.02",
  sku: "prediction-forecast-v1",
  delivery: {
    type: "gate",
    method: "POST",
    resourceUrl: "https://predictionengine.xyz/api/v1/forecast",
  },
});

await genesispay.products.gate(forecast.publicId).prime();
```

Protect the route with that product. Validate request shape before calling
`protect`, and make handler effects idempotent by `purchase.payment.attemptId`:

```ts
const forecastGate = genesispay.products.gate("prod_...");

export async function POST(request: Request) {
  const rawBody = await request.clone().text();
  validateForecastJson(rawBody); // invalid requests never create a payment attempt

  return forecastGate.protect(request, async (_request, purchase) => {
    const cached = await readForecast(purchase.payment.attemptId);
    if (cached) return Response.json(cached);

    const result = await runForecast(rawBody);
    await saveForecastOnce(purchase.payment.attemptId, result);
    return Response.json(result);
  });
}
```

On the initial request, `protect` returns the standard `402 Payment Required`.
GenesisPay creates a pending attempt before that response and advertises a
reserved `gp_attempt` value in the x402 resource URL. On the signed retry, the
SDK sends only the request fingerprint to GenesisPay; it never sends forecast
inputs. A confirmed replay returns the same payment receipt with
`idempotentReplay: true`; handlers may therefore execute more than once and
must keep their own result cache.

`products.list({ includeArchived: true })`, `products.retrieve`,
`products.archive` complete the namespace. Archiving stops **new** link mints;
the existing canonical link stays payable. The price is copied onto the link
at mint — a later catalogue edit never changes what a buyer already sees.

### Testing the paid path

```ts
const session = await genesispay.checkout.simulatePayment(publicId);
// session.paid === true, and the real webhooks have fired.
```

Test keys only — a `gp_sk_live_…` key gets a 403, and on a mainnet deployment the
endpoint does not exist at all. The resulting attempt has `txHash: null` (no
transaction happened) and `simulated: true`; branch on that flag rather than on
the missing hash, because a *pending real* attempt has no hash either.

### Fulfilment guide

GenesisPay reports payment truth as **confirmed attempts**; it cannot know whether
*your* action — shipping, unlocking, granting access — actually succeeded, so
there is deliberately no `fulfilled` field on the SDK or the API. Fulfilment is
merchant-owned. Key each fulfilment idempotently so a webhook retry or a repeated
handler run never double-delivers.

| Product | Fulfil on | Deduplicate by |
|---|---|---|
| Standalone single-use checkout | a verified `payment.confirmed` webhook, or an authenticated `checkout.retrieve()` | the link `publicId` (fulfil once per link) |
| Standalone reusable checkout | each verified `payment.confirmed` attempt | `attempt.id` — never the link-level `paid`, which means "ever paid" |
| Redirect product | a verified, non-simulated entitlement (see Products) | the entitlement `publicId` |
| Product-backed gate | the confirmed purchase inside `protect` | `purchase.payment.attemptId` |

Webhook deliveries are retried (up to three attempts, stable `event.id`), and a
single-use link emits both `payment.confirmed` and `link.paid` for one settlement —
dedupe on `event.id`, and branch on `event.type` so you fulfil once (see
Webhooks above).

### Correlation, and the `cs` query parameter

The hosted checkout may carry a `cs` query parameter. That is GenesisPay's
**internal payer checkout-session identity**, not a merchant correlation field —
do not read it or rely on it. To correlate a payment back to your own records,
send `clientReferenceId` and `metadata` on `checkout.create`; both are echoed back
to you.

The echo contract is exact:

- Non-empty `metadata` keys and values round-trip **unchanged** on `create`,
  `retrieve`, and the payment-link webhook payloads.
- An empty `metadata` object is normalised to `null`.
- `clientReferenceId` is **trimmed**; a blank value is normalised to `null`.
- Both appear on `create`/`retrieve` responses and on the `payment.confirmed` /
  `link.paid` webhook payloads.

### Limits

| Field | Limit |
|---|---|
| `metadata` | 20 keys; keys ≤ 40 chars; values must be strings, ≤ 500 chars; ≤ 4096 bytes serialized |
| `clientReferenceId` | ≤ 200 chars |
| `returnUrl` / `cancelUrl` | ≤ 2048 chars, `https` only (`http` allowed for `localhost` / `127.0.0.1`) |

The `returnUrl`/`cancelUrl` limits and the amount-conflict check are validated
**locally** and throw `GenesisPayValidationError` before any request is sent. The
remaining limits (`metadata`, `clientReferenceId`) are enforced server-side and
fail the `checkout.create` call with a 422.

### Note on `paid` for reusable links

`session.paid` is derived from `confirmedPaymentCount > 0`. For a `reusable` link
that counter only ever grows, so `paid` stays `true` from the first payment
onward — it answers "has this link ever been paid", not "has *this* buyer paid".
For per-buyer fulfilment on a reusable link, use a webhook, or track
`confirmedPaymentCount` as a delta.

Options: `baseUrl` (override the mode default — https, http only for localhost;
both modes default to the GenesisPay facilitator, so it is optional), `configTtlMs`
(seller-config cache TTL, default 5 min), `expectedPayTo` (recommended for `live`
keys — a local pin that fail-closes if the resolved wallet ever differs), `fetchFn`.
The client fails **closed**: an unreachable backend returns `503` and a seller with
no wallet returns a `402` `payment_not_configured` — the paid handler never runs
without a valid destination. It also refuses to advertise a wallet whose network
doesn't match the SDK's native-USDC table or the key mode.

The low-level `createPaymentGate` / `genesisPaySettlement` primitives below remain
available for advanced cases (custom wallet/network per gate, self-hosting).

## Quick start (Next.js route handler)

```ts
// app/api/premium/route.ts
import { createPaymentGate, genesisPaySettlement } from "@genesis-tech/genesispay-seller";

const gate = createPaymentGate({
  amountUsdc: "0.10",
  payTo: "0xYourWalletAddress",
  description: "Premium market data",
  network: "base-sepolia", // or "base" for mainnet
});

const verifySettlement = genesisPaySettlement({
  facilitatorBaseUrl: "https://your-genesispay-instance.example",
  apiKey: process.env.GENESISPAY_SELLER_KEY!, // gp_sk_...
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
import { createPaymentGate, genesisPaySettlement } from "@genesis-tech/genesispay-seller";

const gate = createPaymentGate({
  amountUsdc: "0.05",
  payTo: "0xYourWalletAddress",
  description: "Paid API call",
  network: "base-sepolia",
});

const gated = gate.wrap(
  async () => Response.json({ ok: true }),
  {
    verifySettlement: genesisPaySettlement({
      facilitatorBaseUrl: "https://your-genesispay-instance.example",
      apiKey: process.env.GENESISPAY_SELLER_KEY!,
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
built-in `genesisPaySettlement({ facilitatorBaseUrl, apiKey })`, which POSTs the
payment to GenesisPay's facilitator (`/api/v1/facilitator/settle`). GenesisPay
broadcasts the EIP-3009 authorization on-chain, verifies the USDC transfer,
and returns the receipt. `facilitatorBaseUrl` is optional and defaults to the
public development facilitator (`DEFAULT_FACILITATOR_BASE_URL`,
`https://dev.genesispay.finance`), so you can omit it in dev —
set it explicitly for production. Or supply your own hook:

```ts
import type { VerifySettlement } from "@genesis-tech/genesispay-seller";

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
- Get a seller API key (`gp_sk_...`) from your GenesisPay dashboard under
  Developers.
