// `genesispay.mandates.*` — payment mandates over `/api/v1/mandates`.
//
// A mandate is a bounded, revocable spending approval a payer signs once (an
// EIP-2612 permit); the seller then pulls individual charges against it with no
// further signature. Funds stay in the payer's wallet until each pull.
//
// Deliberately absent: `mandates.activate`. Activation submits the payer's
// *signature* over the permit typed data — it is authorized by the payer's
// wallet, not by a seller API key, and belongs in the payer-facing frontend
// (`POST /api/v1/mandates/:id/activate`). `mandates.create` returns the
// `permitTypedData` for exactly that purpose: hand it to the payer's wallet,
// and post the resulting signature from there. Offering activate here would
// suggest a seller can switch on a mandate by itself, which is the one thing
// the design does not allow.

import { GenesisPayConfigError } from "./errors.js";
import {
  asRecord,
  optionalAmountString,
  optionalCount,
  optionalString,
  requiredString,
  toAmountString,
  toCount,
  oneOf,
  type GenesisPayRequest,
} from "./resource.js";

export type MandateKind = "per_use" | "subscription";

export type MandateStatus =
  | "pending_permit"
  | "active"
  | "past_due"
  | "revoked"
  | "expired";

export type MandateChargeStatus = "pending" | "settled" | "failed";

export type Mandate = {
  id: string;
  kind: MandateKind;
  status: MandateStatus;
  asset: "USDC" | "EURC";
  chainId: number;
  payerWallet: string;
  destinationWallet: string;
  /**
   * The subscription plan this mandate was signed from, or `null` when it was
   * proposed directly via `mandates.create` — that path has no plan, and one
   * supplied by the caller would let a mandate be attributed to a foreign plan.
   * `null` is a valid state, not a missing value; older mandates have it too.
   */
  subscriptionPlanId: string | null;
  /** Total approved spend, in 6-decimal minor units (string — no precision loss). */
  allowanceMinor: string;
  /** Ceiling for any single charge, in minor units. */
  capPerChargeMinor: string;
  spentMinor: string;
  /** `allowanceMinor - spentMinor`, as the server computes it. */
  remainingMinor: string;
  /** Subscription mandates only; null for `per_use`. */
  amountPerPeriodMinor: string | null;
  /** Subscription mandates only; null for `per_use`. */
  periodDays: number | null;
  nextChargeAt: string | null;
  /** After this the unsubmitted permit is dead and the mandate needs re-signing. */
  permitDeadline: string;
  permitTxHash: string | null;
  createdAt: string;
  /** Set when the payer's signature was submitted — until then the mandate is inert. */
  activatedAt: string | null;
  revokedAt: string | null;
};

/**
 * The EIP-712 payload the payer's wallet signs (`eth_signTypedData_v4`).
 *
 * Passed through **verbatim** from the server rather than remapped: a signature
 * covers the exact bytes of this structure, so normalizing a field would
 * produce a signature over something other than what the contract verifies.
 */
export type PermitTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: {
    owner: string;
    spender: string;
    value: string;
    nonce: string;
    deadline: string;
  };
};

export type MandateCreateInput = {
  payerWallet: string;
  kind: MandateKind;
  /** Total spending approval as a decimal amount, e.g. "20". */
  allowance: string;
  /** Ceiling for a single charge as a decimal amount, e.g. "0.10". */
  capPerCharge: string;
  /** Required for `kind: "subscription"`. Decimal amount, e.g. "9". */
  amountPerPeriod?: string;
  /** Required for `kind: "subscription"`. Whole days, e.g. 30. */
  periodDays?: number;
  /** Defaults to USDC. */
  asset?: "USDC" | "EURC";
  /** Defaults to the account's receiving wallet. */
  destinationWallet?: string;
};

export type MandateCreateResult = {
  mandate: Mandate;
  /** Give this to the payer's wallet to sign; then activate from the frontend. */
  permitTypedData: PermitTypedData;
  /** The facilitator address the permit approves as spender. */
  spender: string;
};

export type MandateChargeInput = {
  /** Decimal amount, e.g. "0.08". Must not exceed the mandate's cap per charge. */
  amount: string;
  /** What was paid for — surfaced to the payer in their mandate history. */
  resourceUrl?: string;
  description?: string;
};

export type MandateCharge = {
  id: string;
  status: MandateChargeStatus;
  amountMinor: string;
  /** Null while the pull is still pending, and for a failed charge. */
  txHash: string | null;
};

export type MandateListOptions = {
  /**
   * A plan's **public** id (`plan.publicId`) — the identifier the routes take —
   * not the internal uuid. An unknown or foreign plan id matches nothing and
   * yields an empty page rather than an error, so it cannot be used to probe
   * which plans exist.
   */
  planId?: string;
  status?: MandateStatus;
  /** 1–100. The server defaults to 25 when omitted. */
  limit?: number;
  /** Id of the **last** mandate of the previous page — see `list`. */
  startingAfter?: string;
};

export type MandateListPage = {
  /** Newest first (`createdAt` descending), at most `limit` entries. */
  mandates: Mandate[];
  /** True when another page exists behind this one. */
  hasMore: boolean;
};

export interface MandatesResource {
  /**
   * Proposes a mandate. The returned mandate is inert (`pending_permit`) until
   * the payer signs `permitTypedData` and that signature is submitted from the
   * payer's frontend — see the note at the top of this module on `activate`.
   */
  create(input: MandateCreateInput): Promise<MandateCreateResult>;
  /**
   * One page of this account's mandates, newest first.
   *
   * This is how you find a mandate id without having kept the `mandate.active`
   * webhook: a customer who wants to cancel can be served by listing, matching
   * on `payerWallet` (or `subscriptionPlanId`), and calling `revoke`.
   *
   * **Paging is keyset-based**, so pass the id of the *last* mandate you
   * received as `startingAfter` and repeat while `hasMore` is true:
   *
   * ```ts
   * const all: Mandate[] = [];
   * let startingAfter: string | undefined;
   * for (;;) {
   *   const page = await genesispay.mandates.list({
   *     planId: "plan_1",
   *     status: "active",
   *     limit: 100,
   *     startingAfter,
   *   });
   *   all.push(...page.mandates);
   *   if (!page.hasMore) break;
   *   startingAfter = page.mandates[page.mandates.length - 1]!.id;
   * }
   * ```
   *
   * Do **not** pass the id of an arbitrary mandate: the cursor is a position in
   * `(createdAt desc, id desc)`, not a filter. A `startingAfter` that names no
   * mandate of this account is refused by the server (as a `GenesisPayConfigError`
   * — it carries no field-level detail to raise as a validation error).
   */
  list(opts?: MandateListOptions): Promise<MandateListPage>;
  /** Entitlement check: is it active, and how much approval is left? */
  retrieve(id: string): Promise<Mandate>;
  /** Pulls a single charge. Signature-free — this is the metered path. */
  charge(id: string, input: MandateChargeInput): Promise<MandateCharge>;
  /** Stops all future charges. Already-settled charges are unaffected. */
  revoke(id: string): Promise<Mandate>;
}

export function createMandatesResource(request: GenesisPayRequest): MandatesResource {
  return {
    create: async (input) => {
      const body = await request({
        method: "POST",
        path: "/api/v1/mandates",
        operation: "POST /api/v1/mandates",
        action: "create a mandate",
        body: {
          payerWallet: input.payerWallet,
          kind: input.kind,
          allowance: input.allowance,
          capPerCharge: input.capPerCharge,
          ...(input.amountPerPeriod ? { amountPerPeriod: input.amountPerPeriod } : {}),
          ...(input.periodDays === undefined ? {} : { periodDays: input.periodDays }),
          ...(input.asset ? { asset: input.asset } : {}),
          ...(input.destinationWallet
            ? { destinationWallet: input.destinationWallet }
            : {}),
        },
      });

      const record = asRecord(body);
      const mandate = requireMandate(body, "POST /api/v1/mandates");
      const permitTypedData = asRecord(record?.permitTypedData);
      if (
        !permitTypedData ||
        !asRecord(permitTypedData.message) ||
        !asRecord(permitTypedData.domain)
      ) {
        // Without the typed data the payer cannot sign, so the mandate can never
        // leave `pending_permit` — better to fail loudly than hand back a stub.
        throw new GenesisPayConfigError(
          `GenesisPay POST /api/v1/mandates returned a mandate without permitTypedData: ${JSON.stringify(body)}`,
        );
      }

      const spender = requiredString(record?.spender);
      if (!spender) {
        // Degrading to "" would hand back an address-shaped empty string for the
        // account the allowance approves. Same reasoning as permitTypedData:
        // a missing contract field is a broken response, not an old backend.
        throw new GenesisPayConfigError(
          `GenesisPay POST /api/v1/mandates returned a mandate without a spender: ${JSON.stringify(body)}`,
        );
      }

      return {
        mandate,
        // Verbatim: see the PermitTypedData docs — a signature is over these bytes.
        permitTypedData: permitTypedData as unknown as PermitTypedData,
        spender,
      };
    },

    list: async (opts = {}) => {
      const query = new URLSearchParams();
      if (opts.planId !== undefined) {
        // An explicitly empty filter is refused rather than dropped: silently
        // omitting it would widen the page from "one plan's subscribers" to
        // every mandate on the account — the opposite of what was asked for.
        query.set("planId", requireFilterValue(opts.planId, "planId"));
      }
      if (opts.status !== undefined) query.set("status", opts.status);
      if (opts.limit !== undefined) query.set("limit", String(opts.limit));
      if (opts.startingAfter !== undefined) {
        // Same reasoning, sharper failure mode: dropping an empty cursor
        // restarts at page 1, which turns a paging loop into an endless one.
        query.set(
          "startingAfter",
          requireFilterValue(opts.startingAfter, "startingAfter"),
        );
      }

      const search = query.toString();
      const body = await request({
        path: search ? `/api/v1/mandates?${search}` : "/api/v1/mandates",
        // Label without the query string: the operation is what failed, the
        // filter values are not error detail (and `planId` is caller data).
        operation: "GET /api/v1/mandates",
        action: "list mandates",
      });

      const record = asRecord(body);
      const mandates = record?.mandates;
      if (!Array.isArray(mandates)) {
        // A list endpoint answering 200 without a list is a broken contract,
        // not an old backend. Returning [] would hide it as "no mandates yet"
        // — and "this customer has no subscription" is exactly the wrong thing
        // to conclude from a malformed response.
        throw new GenesisPayConfigError(
          `GenesisPay GET /api/v1/mandates returned no mandates array: ${JSON.stringify(body)}`,
        );
      }

      return {
        // Individual entries stay tolerant: one unusable row must not lose the
        // rest of the page. A row without an id is dropped — it could not be
        // revoked or retrieved anyway.
        mandates: mandates
          .map(asRecord)
          .filter((raw): raw is Record<string, unknown> => raw !== null)
          .filter((raw) => typeof raw.id === "string" && raw.id.length > 0)
          .map(toMandate),
        // Only an explicit `true` means "there is more". Anything else stops
        // the loop above rather than spinning it against a backend that does
        // not report the flag.
        hasMore: record?.hasMore === true,
      };
    },

    retrieve: async (id) => {
      const mandateId = requireMandateId(id, "mandates.retrieve");
      const body = await request({
        path: `/api/v1/mandates/${encodeURIComponent(mandateId)}`,
        operation: `GET /api/v1/mandates/${mandateId}`,
        action: `retrieve mandate "${mandateId}"`,
        notFoundMessage: notFoundMessage(mandateId),
      });
      return requireMandate(body, `GET /api/v1/mandates/${mandateId}`);
    },

    charge: async (id, input) => {
      const mandateId = requireMandateId(id, "mandates.charge");
      const body = await request({
        method: "POST",
        path: `/api/v1/mandates/${encodeURIComponent(mandateId)}/charge`,
        operation: `POST /api/v1/mandates/${mandateId}/charge`,
        action: `charge mandate "${mandateId}"`,
        notFoundMessage: notFoundMessage(mandateId),
        body: {
          amount: input.amount,
          ...(input.resourceUrl ? { resourceUrl: input.resourceUrl } : {}),
          ...(input.description ? { description: input.description } : {}),
        },
      });

      const raw = asRecord(asRecord(body)?.charge);
      if (!raw || typeof raw.id !== "string" || !raw.id) {
        throw new GenesisPayConfigError(
          `GenesisPay POST /api/v1/mandates/${mandateId}/charge returned no charge: ${JSON.stringify(body)}`,
        );
      }
      return {
        id: raw.id,
        status: oneOf(raw.status, ["pending", "settled", "failed"] as const, "pending"),
        amountMinor: toAmountString(raw.amountMinor),
        txHash: optionalString(raw.txHash),
      };
    },

    revoke: async (id) => {
      const mandateId = requireMandateId(id, "mandates.revoke");
      const body = await request({
        method: "POST",
        path: `/api/v1/mandates/${encodeURIComponent(mandateId)}/revoke`,
        operation: `POST /api/v1/mandates/${mandateId}/revoke`,
        action: `revoke mandate "${mandateId}"`,
        notFoundMessage: notFoundMessage(mandateId),
      });
      return requireMandate(body, `POST /api/v1/mandates/${mandateId}/revoke`);
    },
  };
}

function notFoundMessage(id: string): string {
  return (
    `No GenesisPay mandate with id "${id}". Check the id and that it belongs to ` +
    `the account this API key authenticates.`
  );
}

function requireFilterValue(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new GenesisPayConfigError(
      `mandates.list({ ${field} }) was given an empty value. Omit ${field} ` +
        `entirely to list without it — an empty string would silently change ` +
        `which mandates come back.`,
    );
  }
  return trimmed;
}

function requireMandateId(id: string, method: string): string {
  const mandateId = id?.trim();
  if (!mandateId) {
    throw new GenesisPayConfigError(
      `${method}(id) requires the mandate id returned by mandates.create().`,
    );
  }
  return mandateId;
}

function requireMandate(body: unknown, operation: string): Mandate {
  const raw = asRecord(asRecord(body)?.mandate);
  if (!raw || typeof raw.id !== "string" || !raw.id) {
    throw new GenesisPayConfigError(
      `GenesisPay ${operation} returned no mandate: ${JSON.stringify(body)}`,
    );
  }
  return toMandate(raw);
}

export function toMandate(raw: Record<string, unknown>): Mandate {
  return {
    id: requiredString(raw.id),
    kind: oneOf(raw.kind, ["per_use", "subscription"] as const, "per_use"),
    // An unknown status degrades to `pending_permit`, the inert state: guessing
    // "active" for a status this SDK version has never heard of would invite a
    // caller to serve something it should not.
    status: oneOf(
      raw.status,
      ["pending_permit", "active", "past_due", "revoked", "expired"] as const,
      "pending_permit",
    ),
    asset: oneOf(raw.asset, ["USDC", "EURC"] as const, "USDC"),
    chainId: toCount(raw.chainId),
    payerWallet: requiredString(raw.payerWallet),
    destinationWallet: requiredString(raw.destinationWallet),
    subscriptionPlanId: optionalString(raw.subscriptionPlanId),
    allowanceMinor: toAmountString(raw.allowanceMinor),
    capPerChargeMinor: toAmountString(raw.capPerChargeMinor),
    spentMinor: toAmountString(raw.spentMinor),
    remainingMinor: toAmountString(raw.remainingMinor),
    amountPerPeriodMinor: optionalAmountString(raw.amountPerPeriodMinor),
    periodDays: optionalCount(raw.periodDays),
    nextChargeAt: optionalString(raw.nextChargeAt),
    permitDeadline: requiredString(raw.permitDeadline),
    permitTxHash: optionalString(raw.permitTxHash),
    createdAt: requiredString(raw.createdAt),
    activatedAt: optionalString(raw.activatedAt),
    revokedAt: optionalString(raw.revokedAt),
  };
}
