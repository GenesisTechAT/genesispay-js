# Changelog

## 0.2.0 — BREAKING: every identifier is now `genesispay`

The legacy/visible name split is retired. This release renames the
public surface with **no compatibility window** — the old names are not accepted
alongside the new ones. Update all of the following at once:

- `PeerPayAgent` → `GenesisPayAgent`; every `PeerPay*Error` → `GenesisPay*Error`.
- Agent API keys now use the `gp_ag_` prefix; `pp_ag_` keys are rejected and
  must be reissued.
- `PEERPAY_AGENT_KEY` / `PEERPAY_BASE_URL` → `GENESISPAY_AGENT_KEY` /
  `GENESISPAY_BASE_URL`. Update your MCP client config, not just your code.

There is no functional change in this release. It is a rename.

## 0.1.0

First release. Published as `@genesis-tech/genesispay-agent` — the legacy
`genesispay-agent` name was versioned in-repo but never published, so this is the
only name this package has ever had on npm (ADR-0044).

### Added

- `pay(url, options)` — pay an x402-gated URL from an agent wallet, with
  `maxAmount` as a caller-side ceiling and `waitForApproval` to poll a payment
  that needs a human decision.
- `discover`, `paymentStatus`, `executePayment`, `account`.
- `idempotencyKey` on `PayOptions`. **Pass one on every call.** It is what makes
  a retry the same payment rather than a second purchase: the server refuses a
  duplicate key, and the on-chain nonce is derived from it, so even a
  re-execution cannot settle twice.

### Safety

- **`failed` means no money moved; `GenesisPayPaymentOutcomeUnknownError` means we
  do not know.** Every path that cannot rule out a charge raises the second —
  a dropped connection during `pay()`/`executePayment()`, a 5xx with no
  recognised envelope, a `waitForApproval` timeout on a payment already
  executing, and a server `unresolved` envelope. Retry those **only** with the
  same `idempotencyKey`.
- A rejection the server made *before* signing anything (a bad or unreachable
  URL, a free resource, an amount over your ceiling, a busy agent) is a
  `GenesisPayPaymentRejectedError`, never an unknown outcome — including when its
  status is 5xx, because `target_unreachable` and `agent_busy` are.
- Every error extends `GenesisPayApiError`, so one `instanceof` is exhaustive, and
  every subclass sets a `code`.
- The payment status is an **open** union: a status this version predates is
  treated as unknown-outcome rather than throwing, so an old client can still
  read the payment it most needs to see.
- Money amounts are decimal **strings**, never numbers — `0.1 + 0.2` does not
  round-trip through a payments API.
- v1 settles in **USDC on Base**.
