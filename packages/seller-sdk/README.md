# @genesis-tech/genesispay-seller

Framework-agnostic payment and x402 SDK for GenesisPay sellers.

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

Synchronous facilitator success is also fail-closed. The built-in adapter
requires a full transaction hash, the exact requested network and integer minor
amount, the exact payer when the signed payload identifies one, and explicit
`authorizationVerified: true` plus `settlementVerified: true` extensions. An
HTTP 2xx response or `success: true` without that complete evidence never runs
the paid handler.

When GenesisPay accepts a facilitator settlement asynchronously (HTTP 202), the
SDK requires a version-1 acceptance for the exact requested plan and, for the
generic facilitator flow, its canonical plan status URL. Every later status
body must repeat that same version and plan before the SDK trusts it. The SDK
polls the seller-authenticated status endpoint internally. Your paid handler
still runs only after the seller transfer is receipt-verified and has a real
transaction hash. Queue acceptance and a hash-bearing but unconfirmed
`submitted` state never release the resource. The default poll deadline is 120
seconds; set `settlementPollTimeoutMs` on `genesisPaySettlement` when a resource
server needs a smaller bound. A terminal `failed` or `expired` poll returns HTTP
409 or 410 respectively, never a 2xx resource response and never a
`PAYMENT-RESPONSE` settlement receipt. Once any valid poll reports submitted
transaction hash H, later malformed, unavailable, terminal or contradictory
polls retain H as outcome-unknown evidence; the SDK never weakens it into a
hashless retry path or replaces it with a conflicting hash. A valid payer-
broadcast hash is retained the same way when the initial 202 acceptance is
malformed or polling fails before the server reports a transaction hash. A
replayed acceptance is checked once even after its issuance window, so durable
submitted/settled evidence remains discoverable; otherwise queued polling stops
at that acceptance deadline. Once an exact-plan submitted hash is observed,
reconciliation continues for the configured local polling budget.

## Install

This README targets the coordinated **1.3.0 release candidate**. npm currently
serves 0.13.2. The candidate requires protocol 0.5.0 and the matching backend;
install it only after those versions are published and the deployment is ready.

```bash
npm install @genesis-tech/genesispay-seller@1.3.0
```

## Quick start

The `GenesisPay` client configures from **just the seller API key**. The key prefix
(`gp_sk_test_…` / `gp_sk_live_…`) determines the mode and base URL, and the payout
wallet + network are resolved from the key via the GenesisPay backend and cached.

```ts
import { GenesisPay } from "@genesis-tech/genesispay-seller";

const genesispay = new GenesisPay({ apiKey: process.env.GENESISPAY_SELLER_API_KEY! });

// Human hosted checkout — the wallet is defaulted server-side from the key.
// `metadata` and `clientReferenceId` come back on retrieve() and on the webhook,
// so you never need your own table just to map a link back to a buyer:
const { publicId, payUrl } = await genesispay.checkout.create(
  {
    title: "50 credits",
    amount: "5.00", // decimal string in `asset` — see "Amounts and assets" below
    taxConfig: { version: 1, treatment: "taxable", rateBps: 2000, note: null },
    clientReferenceId: order.id,
    metadata: { buyerId: user.id, plan: "starter" },
    returnUrl: "https://shop.example.com/thanks",
    cancelUrl: "https://shop.example.com/cart",
  },
  { idempotencyKey: `checkout-${order.id}` },
);

// Tolerant checkout views are for display and polling only. They are not
// fulfilment authority; use fulfillment.verify as shown below.
const session = await genesispay.checkout.retrieve(publicId);
renderPaymentStatus(session.paid);
// An unknown id throws GenesisPayNotFoundError, not GenesisPayConfigError — so a
// typo'd id is distinguishable from a broken key or an unreachable backend.

// Agent x402 gate — payTo + network resolved from the key, settlement auto-wired:
export const GET = genesispay.gate({ amountUsdc: "0.02" }).wrap(
  async () => Response.json({ data: "the good stuff" }),
);
```

### Strict fulfilment authority (1.0)

Fulfil only after `genesispay.fulfillment.verify()` returns `verified: true`.
The method retrieves seller-scoped evidence from GenesisPay, parses every known
authority field strictly, validates the Base asset deployment, and compares it
with your immutable expected contract. It does not accept an evidence object,
so a fabricated SDK-shaped value cannot authorize fulfilment.

```ts
import {
  GenesisPay,
  GenesisPayContractMismatchError,
  GenesisPayEvidenceError,
  GenesisPayVersionError,
  type ExpectedProductContract,
} from "@genesis-tech/genesispay-seller";

const genesispay = new GenesisPay({
  apiKey: process.env.GENESISPAY_SELLER_API_KEY!,
});

const expected: ExpectedProductContract = {
  kind: "product",
  productId: "prod_starter",
  sku: "starter-credits",
  grossAmountMinor: 1_000_000n,
  network: {
    mode: "live",
    network: "base",
    chainId: 8453,
    asset: "USDC",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    minorUnitScale: 6,
  },
  settlementDestination: process.env.GENESISPAY_EXPECTED_PAY_TO! as `0x${string}`,
  delivery: {
    type: "url",
    url: "https://shop.example.com/deliver/starter",
    gate: null,
  },
};

try {
  const result = await genesispay.fulfillment.verify({
    // Redirect/webhook entitlement ID is only a locator, never proof itself.
    locator: { entitlementId },
    expected,
  });

  if (result.verified) {
    await fulfilOnce(result.payment.attemptId);
  } else {
    // not_found, not_confirmed, simulated, or entitlement_invalid are normal
    // negative outcomes. None authorizes fulfilment.
    logPaymentPending(result.reason, result.requestId);
  }
} catch (error) {
  if (
    error instanceof GenesisPayContractMismatchError ||
    error instanceof GenesisPayEvidenceError ||
    error instanceof GenesisPayVersionError
  ) {
    alertPaymentAuthorityFailure({
      code: error.code,
      requestId: error.requestId,
      apiVersion: error.apiVersion,
      mismatches:
        error instanceof GenesisPayContractMismatchError ? error.mismatches : undefined,
    });
  }
  throw error;
}
```

The strict API is explicitly versioned with
`GENESISPAY-Version: 2026-08-26`; the SDK sends that header and requires the
same version plus `GENESISPAY-Request-Id` in the response headers and body.
Amounts cross the wire as bounded canonical decimal strings and become
`bigint` only after validation. `simulated: false` is required literally and
is accepted only with the supported authority provenance version.

`2026-08-26` is a stable protocol identifier, not the SDK release date. Updating
the SDK package version does not change stored payment provenance.

For account-bound or per-order delivery, store the created `checkout.linkId`
alongside your order and buyer. After verification, require that the verified
link belongs to that order and authenticated buyer, and atomically claim the
attempt before granting credits or goods. A matching product contract alone
does not bind a payment to the currently signed-in customer.

Fee quotes and fee deductions are different: a `record_only` quote may equal
the gross amount, while the seller still received full gross. A quote above
gross is invalid, and a `payer_authorized` fee must leave a positive seller
amount. Never deduct a record-only quote from the verified seller amount.

For URL delivery, use the entitlement locator as above: it also checks current
expiry and revocation. An attempt or link locator proves the immutable payment
even after an entitlement is revoked or expires, for reconciliation. If you use
one of those locators to release URL delivery, also require a non-null
`result.payment.entitlement` with `valid === true` before fulfilling.

Use a key whose mode matches the payment chain: `test` for Base Sepolia and
`live` for Base mainnet. Strict direct/product checkout link creation/replay and
product-gate
requests reject `409 seller_mode_mismatch` before exposing or settling a payment
the same key cannot verify. A `baseUrl` override does not change key mode.

### Return URL — parse the hint, then verify authority

When you pass `returnUrl` to `checkout.create`, the hosted checkout shows a
"Return to …" button and appends
`?genesispay_link_id=<publicId>&genesispay_status=paid` only when the payer
selects it — there is no timed auto-redirect. Those parameters are a **UI hint
only**: they are unsigned, and a payer can navigate to that URL directly without
paying. **Never fulfil on the query string**; use authenticated webhooks as a
trigger and strict verification as authority.

Use `parseCheckoutReturnHint` only to locate the payment, then call the strict
seller-authenticated verifier with the expected immutable contract:

```ts
import { parseCheckoutReturnHint } from "@genesis-tech/genesispay-seller";

export async function GET(request: Request) {
  const hint = parseCheckoutReturnHint(new URL(request.url));
  if (!hint) return Response.json({ ok: true }); // no return params — nothing to do

  const result = await genesispay.fulfillment.verify({
    locator: { linkId: hint.linkId },
    expected: expectedSingleUseLinkContract,
  });
  if (result.verified) await fulfilOnce(result.payment.attemptId);

  return Response.json({ ok: true });
}
```

`parseCheckoutReturnHint(url)` returns `{ linkId, status: "paid" }` only when the
URL carries a non-empty `genesispay_link_id` and an exact `genesispay_status=paid`.
Anything else — a missing id, an unknown status like `refunded`, a hand-built URL
— returns `null`. It performs **no verification**: treat it as a prompt to look
the link up with your key, never as a receipt.

This locator is suitable only for a single-use link. A reusable link can have
many confirmed attempts, so a link-only locator is ambiguous; use the attempt ID
from the webhook or recovery response. The browser return remains an untrusted
UX/recovery hint.

### Payment requests and products

`checkout.create()` creates a single-use payment request. Omit `linkType` or
pass `"single"`; `"reusable"` is rejected locally and by the API (HTTP 422).
For repeat sales, create a Product and mint its canonical payment link with
`products.createPaymentLink()`. Each hosted Buy starts a separate checkout
session. Completed checkouts do not offer a pay-again action. Legacy standalone
reusable links become single-use requests; previously paid ones are closed,
while their payments and documents remain available. No npm publication is
implied by this repository change.

### Amounts and settlement

During the beta, every new hosted checkout link settles in **USDC on Base**. An
amount is therefore a decimal dollar string — never a number:

```ts
// 5 USDC / 5 dollars:
await genesispay.checkout.create(
  { title: "Credits", amount: "5.00" },
  { idempotencyKey: "order-123-create" },
);
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
    if (event.type === "payment.confirmed") {
      const verified = await genesispay.fulfillment.verify({
        locator: { attemptId: event.data.attempt.id },
        expected: expectedContractFor(event.data.link.publicId),
      });
      if (verified.verified) await fulfilOnce(verified.payment.attemptId);
    }
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

A missing or conflicting chain is not fulfillment evidence. Recover the attempt
through authenticated `fulfillment.verify` against the expected network; do not
infer the environment, default the chain, or book from tolerant checkout display.
Strict evidence supports the explicit Base deployment tuple in your contract.

**One settlement can reach you through multiple triggers.**

- *Retries*: nine sends per cycle, with stable source `event.id` across endpoints,
  retries and audited replay. Persist inbox work before acknowledging.
- *Event types*: strict payments emit `payment.fulfilled` alongside legacy
  `payment.confirmed`, `link.paid` and product notifications as applicable. Distinct
  event IDs do not collapse one payment across event types or browser/recovery
  triggers. Always use the shared verified-attempt/intent credit transaction
  described in the fulfillment guide below.

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
  calculationVersion: 2,
  lineItems: [
    { description: "Consulting", quantity: 2, unitAmount: "450.00",
      taxConfig: { version: 1, treatment: "taxable", rateBps: 2300, note: null } },
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

New invoices use inclusive per-line tax: `unitAmount` includes tax. Each line
requires `taxConfig`; invoice-wide `taxBps` is zero. Existing v1 drafts keep
their original exclusive calculation; send `calculationVersion: 1` when editing
one. To explicitly upgrade a draft, supply `calculationVersion: 2`, `taxBps: 0`
and a confirmed `taxConfig` for every line. Finalized history cannot be upgraded.

All invoice money fields ending in `Minor` are integer strings. `paid` is a
read-only projection of a confirmed, non-simulated GenesisPay payment; it cannot
be set through the SDK. Finalized invoices cannot be edited. Use
`invoices.void()` to cancel collection or `invoices.markUncollectible()` to write
off an unpaid invoice.

### Browse invoice summaries

`listSummaries` is prepared in this repository; this change does not publish an
SDK release. If your installed release lacks the method, use the authenticated
HTTP endpoint after deploying this backend change:

```ts
const response = await fetch(`${baseUrl}/api/v1/invoices/summaries?limit=25`, {
  headers: { Authorization: `Bearer ${sellerApiKey}` },
});
if (!response.ok) throw new Error(`Invoice list failed: ${response.status}`);
const summaries = await response.json();
```

Use `invoices.listSummaries()` for bounded pages. The default limit is 25, with
an integer maximum of 100. Pass the opaque `nextCursor` back as `after`; a null
cursor means the end. Ordering is newest first by creation time and ID, so
inserts above your current page do not duplicate older rows. This is a live
list: status can change between requests.

```ts
let page = await genesispay.invoices.listSummaries({ limit: 25 });
for (const invoice of page.invoices) {
  console.log(invoice.publicId, invoice.customer.name, invoice.totalMinor);
}
if (page.nextCursor) {
  page = await genesispay.invoices.listSummaries({ limit: 25, after: page.nextCursor });
}
if (page.invoices[0]) {
  const fullInvoice = await genesispay.invoices.retrieve(page.invoices[0].publicId);
}
```

Each summary has `id`, `publicId`, nullable `invoiceNumber`, `status`, `asset`,
`chainId`, exact integer-string `totalMinor`, `customer: { name, companyName }`,
`dueAt`, `createdAt`, and nullable `paidAt`. Finalized customer names come from
the issued snapshot. A summary intentionally has no line items, delivery
history, seller profile or payment detail; retrieve an invoice to read those.
The existing `invoices.list()` still returns its newest 100 full invoices with
every nested line and delivery. It does not accept pagination options.

### Hosted checkout documents

Every new confirmed, non-simulated hosted human checkout creates one immutable
invoice identity and two PDF artifacts: invoice and payment receipt. New human
authorizations require complete, attested KYB-approved issuer details and an
explicit item tax assertion; missing configuration blocks checkout, not silently
zero tax. Historical v1 enhanced receipts remain readable.
GenesisPay does not determine the seller's tax rate or require an Avalara or
Stripe Tax account. This archive is separate
from seller-authored `invoices`: do not try to create, edit, or number these
documents through the SDK.

```ts
const documents = await genesispay.checkoutDocuments.list();
const oneDocument = await genesispay.checkoutDocuments.get("doc_…");

for (const document of documents) {
  console.log(document.kind, document.invoiceNumber, document.totalMinor);
  // document.snapshot is the buyer/seller/tax snapshot frozen before payment.
}
```

Amounts ending in `Minor` are integer strings. A `null` `invoiceNumber` means
the document is an enhanced receipt, not an invoice with a missing number.
`checkoutDocuments.list()` returns the seller's newest 100 documents.
The authenticated PDF download is
`GET /api/v1/checkout-documents/:publicId/pdf` (invoice) and
`GET /api/v1/checkout-documents/:publicId/pdf?kind=receipt` (payment receipt).
V2 snapshots include per-line inclusive totals, item treatment, and the reviewed
seller profile version. Neither document creates another payable invoice.

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

Every per-use charge requires a stable idempotency key. Reuse it after any
timeout or 503; never generate a second key for the same metered operation:

```ts
await genesispay.mandates.charge(mandateId, {
  amount: "0.08",
  idempotencyKey: usageRequestId,
  resourceUrl: "https://api.example/forecast",
});
```

If the pull was submitted but its receipt is not definitive, the promise rejects
with `GenesisPayMandateChargePendingError`. Its `status`, `code` and `charge`
fields preserve the API's 503 locator (including `charge.txHash` when known), so
the caller can record the unknown outcome and retry only with the same key.

`createMandateGate` likewise requires the protected request to carry
`Idempotency-Key`. An outcome-unknown pull stays 503 with its charge locator and
the wrapped handler is not opened until the original charge is settled. The
gate treats HTTP success as transport only: the response must also name a
settled charge, the exact requested integer minor amount and a full transaction
hash. A missing, submitted, hashless or contradictory 2xx body fails closed as
503 and the same idempotency key remains authoritative.

There is deliberately **no `mandates.activate`**: activation requires the payer's
own signature over the permit, so it belongs in the payer's frontend, not in a
server holding your secret key.

`MandateStatus` also includes terminal `cancelled`: GenesisPay stopped an
unbroadcast permit because seller eligibility changed. That authority never
wakes after recovery; create a new proposal and obtain a fresh payer signature.

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
  price: "2.00", // inclusive customer total
  taxConfig: { version: 1, treatment: "taxable", rateBps: 2000, note: null },
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

#### Item tax and existing catalogue entries

`taxConfig` is `{ version: 1, treatment, rateBps, note }`. `rateBps` is an integer
(2000 = 20%), from 1 to 10000 for `taxable`. `zero_rated`, `exempt`, and
`not_collected` require rate 0 and a nonempty seller-provided explanation in
`note`. There is no automatic reverse charge or country-based tax determination.
Omitted tax on legacy API product/link creation remains **unconfigured**, not 0%;
new human checkout cannot start until the item and verified seller are ready.
Agent/x402 behavior remains separate. `checkout.create` accepts the same taxConfig.

Publish a tax correction using the exact configuration you last read:

```ts
await genesispay.products.update(product.publicId, {
  expectedTaxConfig: product.taxConfig, // null for an unconfigured product
  taxConfig: { version: 1, treatment: "taxable", rateBps: 1000, note: null },
});
// Standalone links only; product-backed links are changed through products.update:
await genesispay.checkout.updateTax(link.publicId, {
  expectedTaxConfig: link.taxConfig,
  taxConfig: { version: 1, treatment: "taxable", rateBps: 1000, note: null },
});
```

The server atomically publishes product tax to its live link without repricing
it. A concurrent edit returns 409: re-read and review before retrying. Existing
payment snapshots and issued documents never change. Archived and manual-invoice
links reject generic tax updates.

For an immutable per-order checkout, assert the complete current product
contract and create an explicitly identified single-use link. Both calls are
versioned; creation requires seller-account-scoped idempotency, so API-key
rotation does not break a retry:

```ts
await genesispay.products.assertContract(expectedProductContract);

const checkout = await genesispay.products.createCheckout(
  {
    expected: expectedProductContract,
    clientReferenceId: order.id,
    metadata: { buyerId: order.buyerId },
    returnUrl: "https://shop.example.com/thanks",
  },
  { idempotencyKey: `product-checkout-${order.id}` },
);

checkout.linkId; // GenesisPay link identity — there is no ambiguous checkout.id
checkout.payUrl;
```

The checkout copies the product's tax configuration inside the same transaction
that freezes its price and delivery contract. Tax never changes the signed gross
amount or serves as fulfilment authority.

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
via the tolerant entitlement view for migration and display. Those parameters,
the webhook object, and `entitlements.verify` are not fulfilment authority in
1.0. Test-mode purchases still deliver end to end with an explicit simulation
marker, but only the strict verifier can return an authority-bearing success.

Use the strict authority verifier rather than trusting `gp_*` query parameters
or the tolerant entitlement view:

```ts
const verified = await genesispay.fulfillment.verify({
  locator: { entitlementId },
  expected: expectedProductContract,
});
if (verified.verified) await fulfilOnce(verified.payment.attemptId);
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
import { createGateRequestFingerprint } from "@genesis-tech/genesispay-seller";

const forecastGate = genesispay.products.gate("prod_...");

export async function POST(request: Request) {
  const rawBody = await request.clone().text();
  validateForecastJson(rawBody); // invalid requests never create a payment attempt

  const expectedForRequest = {
    ...expectedForecastContract,
    delivery: {
      ...expectedForecastContract.delivery,
      gate: {
        ...expectedForecastContract.delivery.gate,
        fingerprint: await createGateRequestFingerprint(request),
      },
    },
  };

  return forecastGate.protect(request, expectedForRequest, async (_request, purchase) => {
    const cached = await readForecast(purchase.payment.attemptId);
    if (cached) return Response.json(cached);

    const result = await runForecast(rawBody);
    await saveForecastOnce(purchase.payment.attemptId, result);
    return Response.json(result);
  });
}
```

`protect` validates the method, canonical resource URL, and request fingerprint
against the expected immutable contract before negotiation. Its challenge sends
that complete contract to GenesisPay, which compares it with the exact frozen
payable link before creating an attempt or returning a `402 Payment Required`;
the SDK never reconstructs authority from mutable catalogue presentation.
GenesisPay creates a pending attempt before that response and advertises a
reserved `gp_attempt` value in the x402 resource URL. On the signed retry, the
SDK sends only the request fingerprint to GenesisPay; it never sends forecast
inputs. After settlement it retrieves strict evidence by attempt ID and invokes
the handler only after every authority field matches. If evidence is unavailable
it returns a recoverable `503` carrying `GENESISPAY-Payment-Attempt-Id` and
preserves a matching `PAYMENT-RESPONSE`. A transient response is `retryable: true` and
carries `Retry-After: 2`; a permanent inconsistency is `retryable: false` and
deliberately carries no retry instruction. The gate transport also negotiates
`GENESISPAY-Version: 2026-08-26`, while unversioned 0.x gate traffic keeps its
legacy wire contract. If the settlement connection drops after commit, the SDK
recovers the untrusted attempt locator from the signed x402 payload and returns
the same retryable 503; only `fulfillment.verify` can turn that locator into
authority. Handlers may execute more than once and must keep their own result
cache.

An interrupted verification response stream is transient; a completed malformed
evidence response is permanent. A settlement naming a different attempt drops
that unrelated receipt and reports `settlement_outcome_unknown` with the signed
attempt locator. Missing strict settlement metadata or a negative
`not_found`/`not_confirmed` verification likewise cannot claim confirmation.
Only independently verified evidence allows the handler to run.

You may retry the original signed request after its authorization expires if
that attempt was already confirmed. GenesisPay verifies the persisted attempt,
signature and original on-chain payment before replaying success; it does not
broadcast or collect a fee again. An unpaid expired authorization remains
rejected. Keep the same attempt locator and signature when recovering a payment.
Failed/expired attempts are terminal even if their signature is still valid or
the original link has been archived (`409 attempt_failed` / `attempt_expired`).

`products.list({ includeArchived: true })`, `products.retrieve`,
`products.archive` complete the namespace. Archiving stops **new** link mints;
the existing canonical link stays payable. The price is copied onto the link
at mint — a later catalogue edit never changes what a buyer already sees.

#### Prepare requests for body-priced resources

Before an agent signs, it asks your resource to freeze the exact settlement
plan: a request carrying `GENESISPAY-Settlement-Prepare: 1`. A client that
puts its plan parameters in a second header,
`GENESISPAY-Settlement-Prepare-Params` (base64 JSON
`{ payer, idempotencyKey, feeMode, authority? }`, decoded by
`decodeSettlementPrepareParamsHeader` from `@genesis-tech/genesispay-protocol`),
sends that preparation as a **repeat of the purchase request** — same method,
URL (plus the reserved `gp_attempt` query), `content-type` and body.

**Rollout:** the GenesisPay agent engine does not send the params header yet;
that is a server follow-up. Until it ships, agents send the legacy form
described below, so a body-validated route must still accept the legacy
preparation body — or hand any request carrying
`GENESISPAY-Settlement-Prepare: 1` to `protect` before its own validation.

For a client that sends the header, your route needs no special case. Parse and
validate the body as for any purchase — read it from `request.clone()` (or pass
a re-created `Request`) so the gate can still read the body and recompute the
fingerprint; a consumed body answers `422 { code: "invalid_request" }` — select
the gate for it (for example the generic gate for a
request tier, or the product whose registered resource serves that tier) and
call `protect` or the wrapped handler. A body-priced API needs one gate
resource per price: a product gate is unique per method and resource URL, so
each tier is its own registered resource (or its own generic gate). The gate
recognises the preparation by its header, never runs your handler for it, and
answers with the plan:

- **Product gates** recompute the method, canonical resource URL and request
  fingerprint and require them to equal your expected gate intent, exactly as
  for the challenge and the signed retry. A preparation for a different request
  answers `422 { code: "contract_mismatch", mismatches }` and nothing reaches
  GenesisPay. The forwarded `prepare` action is unchanged.
- **The generic gate** (`createPaymentGate`) prices by configuration and binds
  no request fingerprint; it reads the parameters from the header and treats
  the body as opaque purchase content.
- A present but malformed params header answers
  `422 { code: "invalid_request" }`; the gate never falls back to the body.

Without the params header, both gates keep the legacy form, in which the body
carries the plan parameters. It stays supported for GET resources, hosted
payment links and the current agent engine — but a route that rejects any body
other than its own purchase schema will refuse it, so such a route must
recognise the prepare header before its own validation until clients send the
header form. The decision is
recorded in ADR-0083 of the GenesisPay repository.

### Testing the paid path

```ts
const session = await genesispay.checkout.simulatePayment(publicId);
// session.paid === true, and the real webhooks have fired.
```

Test keys only — a `gp_sk_live_…` key gets a 403, and on a mainnet deployment the
endpoint does not exist at all. The resulting attempt has `txHash: null` (no
transaction happened) and `simulated: true` in tolerant display responses. Never
use that response to fulfil: strict `fulfillment.verify` returns the normal
negative reason `simulated`, while a pending real attempt can also have no hash.

### Fulfilment guide

GenesisPay reports payment truth as **confirmed attempts**; it cannot know whether
*your* action — shipping, unlocking, granting access — actually succeeded, so
there is deliberately no `fulfilled` field on the SDK or the API. Fulfilment is
merchant-owned. Key each fulfilment idempotently so a webhook retry or a repeated
handler run never double-delivers.

| Product | Fulfil on | Deduplicate by |
|---|---|---|
| Standalone single-use checkout | strict `fulfillment.verify` by link or attempt | confirmed `payment.attemptId` |
| Product without digital delivery | strict `fulfillment.verify` by attempt | `payment.attemptId` — never link-level `paid` |
| Redirect product | strict `fulfillment.verify` by entitlement or attempt | `payment.attemptId` |
| Product-backed gate | strict evidence returned after confirmed settlement | `payment.attemptId` |

`payment.fulfilled` is the canonical notification. Its `data` is the strict
FulfillmentEvidence wire shape plus explicit nullable `clientReferenceId`; its
envelope has `apiVersion: "2026-08-26"` and `livemode`. Simulation does not emit
it. `constructEvent` verifies raw bytes before parsing and validates known evidence
fields, preserving integer amount strings. It does **not** return VerifiedPayment:
always call authenticated `fulfillment.verify({ locator, expected })` afterward.
The name does not claim that your application has delivered anything.

`livemode` is not present on every event type. Do not discard an event because
`!event.livemode` is true: an absent field also passes that check. For
`payment.fulfilled`, `livemode: false` means Base Sepolia, and
`data.simulation.simulated` is explicitly false. Network and simulation are
separate facts; never substitute `livemode` for the event's simulation field.
Use authenticated `fulfillment.verify` before granting credits or fulfilling
an order.

Persist a purchase intent (account, credits, expected contract) before checkout.
Use its ID as `clientReferenceId` and the checkout idempotency key. Store the
returned link ID and require `verified.payment.linkId` to match it before credit.
If the webhook precedes that response, keep it pending and recover the same
checkout; never assign a payment to an account from webhook metadata alone.

New event IDs are stable across endpoints, retries and explicit replay. Dedupe
inbox processing by event ID, but **atomically claim verified attempt ID and
purchase intent with the credit balance/ledger update** across every trigger.
Different event types, browser return and reconciliation must converge there.
Keep a conflicting binding for investigation; never grant a second credit.
Persist the inbox before acknowledging 2xx and let a worker retry verification.

There are nine sends per delivery cycle: initial plus 30s, 2m, 5m, 15m, 1h, 6h,
12h, 24h delays (±10% jitter), maximum72h. Minute scheduling rounds due work up to
the next tick. Only explicit audited operator replay opens another cycle, with
identical body and event ID. Acknowledgement loss permits duplicates. Outbox
producers/worker must be deployed and measured before relying on these targets.

### Recover missing notifications

```ts
let cursor: string | undefined;
do {
  const page = await genesispay.fulfillment.listAttempts({
    clientReferenceId: intent.id,
    confirmedAfter: intent.createdAt,
    limit: 50,
    cursor,
  });
  for (const candidate of page.data) {
    const verified = await genesispay.fulfillment.verify({
      locator: { attemptId: candidate.attemptId }, expected: intent.expected,
    });
    if (verified.verified && verified.payment.linkId === intent.linkId) {
      // Your shared transaction claims attempt + intent and writes credits.
      await creditVerifiedPurchaseOnce(intent, verified.payment);
    }
  }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

Listing requires the strict API version and seller key and enforces seller/mode
scope. Optional exact reference (max200), inclusive ISO confirmedAfter/Before,
limit1..100(default50) and opaque cursor are supported. Keep filters unchanged
between pages. A cursor fixes the upper bound and preserves database microseconds.
Repeat scans for late commits; include abandoned, expired and cancelled browser
flows. `authorityVersion: null` is a historical diagnostic, never permission to
credit. No listing row is authority, even when it names a confirmed attempt.

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

### Note on `paid` for product links

`session.paid` is derived from `confirmedPaymentCount > 0`. For a `reusable` link
that counter only ever grows, so `paid` stays `true` from the first payment
onward — it answers "has this link ever been paid", not "has *this* buyer paid".
For per-purchase fulfilment on a product link, use a webhook as a trigger and then
strictly verify its attempt ID. Never use `confirmedPaymentCount` as authority.

Options: `baseUrl` (override the mode default — https, http only for localhost;
both modes default to the GenesisPay facilitator, so it is optional), `configTtlMs`
(seller-config cache TTL, default 5 min), `expectedPayTo` (recommended for `live`
keys — a local pin that fail-closes if the resolved wallet ever differs), `fetchFn`.
The pin also applies to `checkout.retrieve`, `products.assertContract`,
`products.createCheckout`, `products.gate(...).protect`, and `fulfillment.verify`.
Checkout retrieval checks the raw destination before its display mapper runs;
strict methods refuse a conflicting expected destination before a network request.
Missing or conflicting destinations fail closed. An explicit expected contract
cannot override the client pin, including on historical verification.
After a wallet rotation, reconcile old payments with a separate client pinned
to the original destination recorded in your immutable order contract. Keep the
current client pinned to the new wallet; neither pin rewrites payment history.
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
plan-aware prepare request before an agent signs, then forwards the signed
authorization with its immutable settlement-plan id. Clients that omit the
prepare handshake are refused before broadcast with `settlement_plan_required`.
The hook sends preparation and settlement to GenesisPay's facilitator. GenesisPay
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

### Beta: new mandate authority answers 409

During the GenesisPay beta, a deployment may lock the creation of **new** mandate
authority. While it is locked, `mandates.create`, the `contract_mandate_v1`
helpers (`mandates.createContractSubscription`, `mandates.createContractPerUse`,
`mandates.proposeContractUsage`) and `plans.create` reject with HTTP `409` and
code `mandate_authority_locked_for_beta`. There is no `Retry-After` — waiting
does not change the answer, so treat it as a capability that is off rather than a
transient failure.

`mandates.submitContractUsage`, `mandates.getContractUsage`, revocation, every
list/read, and the whole x402 payment-gate path are unaffected, as is any mandate
a payer already approved. A retry of a request made before the lock still returns
its original charge, mandate or payment identity — keep using the SAME
idempotency key, exactly as you would without the lock. In particular a
`mandates.charge` retry whose key already names a charge still comes back with
that charge (settled, or `submitted` with its locator) rather than the 409, so a
`409 mandate_authority_locked_for_beta` always means no charge exists for that
key. Never retry with a fresh key to work around it.

### Experimental gated contract subscriptions

`mandates.createContractSubscription` explicitly requests the two-signature
`contract_mandate_v1` protocol. It requires an ISO expiry and validates both
returned signing payloads. This capability is off by default; the reviewed
contract registry must permit the deployment. Mainnet also requires legal/audit
and completed legacy-authority cutover evidence.

```ts
const proposal = await genesispay.mandates.createContractSubscription({
  payerWallet, allowance: "108", capPerCharge: "9", amountPerPeriod: "9",
  periodDays: 30, validUntil: "2027-09-01T00:00:00Z",
});
// In the payer frontend, sign approval.termsTypedData, then approval.permitTypedData.
// POST /api/v1/mandates/:id/activate:
// { protocol: "contract_mandate_v1", termsSignature, permitSignature }
```

HTTP202 is acceptance, not activation or payment confirmation. Retry the same
signatures after an unknown HTTP outcome. A409 `mandate_proposal_stale` requires a
new proposal and two new approvals. The legacy `mandates.create` method keeps its
one-permit contract and cannot silently switch protocols.

`mandates.revoke(id)` requests local cancellation for contract mandates; inspect
`revocationStatus`. The payer signs `revocationTypedData` from the returned API
mandate and any relay can POST `{ protocol: "contract_mandate_v1", signature }`
to `/api/v1/mandates/:id/revoke-signed`. Only `confirmed` means the permanent
on-chain revocation exists. An independent relay may instead call the bound
executor's `revokeWithSignature(payer, mandateId, signature)`; the payer can call
`revoke(mandateId)` directly. Neither path requires an API session. Do not use
`approve(0)` as proof that old signed permits are invalid.

Contract subscription renewals are admitted by the worker or cron and become paid
only after canonical atomic receipt verification. First charge is eligible at
activation; later charges wait the signed interval after successful settlement.
Downtime does not create catch-up charges. A confirmed revert may receive a new
attempt only after exact receipt and unused-authority verification.

Contract billing webhooks add `protocol: "contract_mandate_v1"`, `contractEvent`
(immutable chain/block/log, logical identity, sequence and split amounts), and
`mandateStateContext: { kind: "projection_snapshot", observedAt }`. `occurredAt`
is the event's block time; `mandate` is the state when that event was projected,
which can be later. Deliveries may arrive out of order: an old `mandate.active`
event can carry an already revoked snapshot. Order event facts by block/log and
retrieve current state before enabling access. Deduplicate the envelope `id`;
replays preserve its original bytes, including the original snapshot.

### Experimental gated signed per-use mandates

`mandates.createContractPerUse({ payerWallet, allowance, capPerCharge, validUntil })`
returns the same two bounded approvals as the contract subscription API. It has
no recurring amount or interval. After the payer signs both approvals and the
activation confirms, each usage request requires its own payer signature:

```ts
const charge = await genesispay.mandates.proposeContractUsage({
  mandate: approvedMandate, // the saved createContractPerUse result
  amountMinor: "80000", // gross integer minor units, including any fee
  idempotencyKey: "forecast-request-001",
  resourceUrl: "https://example.com/forecast",
});
// The payer's wallet signs charge.chargeTypedData. The seller SDK never signs.
const accepted = await genesispay.mandates.submitContractUsage(charge, payerSignature);
const current = await genesispay.mandates.getContractUsage(accepted);
// Fulfill only after current.status === "settled", verified against your order.
```

The SDK independently builds the charge EIP-712 message from the saved mandate
consent and exact requested gross. It checks chain, executor, mandate, fee,
request metadata and signing fields. Submission and polling preserve the original
charge identity and deadline. HTTP202 means pending; queue acceptance is not a
confirmed payment. A retry uses the same idempotency key and saved proposal.
Changing a request under that key returns a conflict, including after failure.

The server retains the proposal before a wallet prompt. If no signature arrives,
it closes the source only after finalized proof that the charge is unused and
its authority expired or was revoked. The old `mandates.charge` and metering gate
are legacy-only and refuse contract mandates; they cannot silently replace the
required signature. These contract APIs remain gated and unreleased on Mainnet.
Agent policy/signing integration and per-use successors after a mined revert
remain separate pending implementation work.
