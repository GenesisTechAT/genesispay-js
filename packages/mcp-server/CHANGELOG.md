# Changelog

## 0.2.0 — BREAKING: every identifier is now `genesispay`

The legacy/visible name split is retired. This release renames the
public surface with **no compatibility window** — the old names are not accepted
alongside the new ones. Update all of the following at once:

- `PEERPAY_AGENT_KEY` / `PEERPAY_BASE_URL` → `GENESISPAY_AGENT_KEY` /
  `GENESISPAY_BASE_URL` in every MCP client config (Claude Code, Claude
  Desktop, Codex, OpenClaw, Hermes).
- Agent keys now use the `gp_ag_` prefix.
- The tool names (`genesispay_discover`, `genesispay_pay`,
  `genesispay_payment_status`, `genesispay_account`) are unchanged.

There is no functional change in this release. It is a rename.

## 0.1.0

First release. Published as `@genesis-tech/genesispay-mcp`; the legacy `genesispay-mcp`
name was never published (ADR-0044).

### Added

- Stdio MCP server exposing four tools: `genesispay_discover`,
  `genesispay_pay`, `genesispay_payment_status`, `genesispay_account`.
- Ships the `genesispay-mcp` binary; configured with `GENESISPAY_AGENT_KEY` and
  `GENESISPAY_BASE_URL` (those env names are deliberately unchanged — ADR-0013).
- Setup for Claude Code, Codex, Claude Desktop, OpenClaw and Hermes.

### Safety

The tool results are written for a model that will act on them, so the guidance
is part of the contract rather than decoration:

- `genesispay_pay` **generates an `idempotencyKey` per call** when the caller
  omits one, and returns the effective key on success *and* on failure — a
  default the model never sees is the same as no default, because its retry
  would mint a new one and buy the thing twice.
- When an outcome cannot be determined, the result carries an explicit *do not
  buy this again* instruction and the payment id, and the generic "retry with
  the same key" line is removed so one payload never says both.
- Retry guidance is withheld entirely when the server said nothing was created
  (a policy block, a rejection, a `failed` payment), because there the same key
  can only ever conflict — and a `failed` original is told to use a **new** key,
  since nothing was signed.
- Over-limit payments come back as an approval link, never as silent spending.
