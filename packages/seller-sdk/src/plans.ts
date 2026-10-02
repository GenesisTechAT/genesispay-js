// `genesispay.plans.*` — subscription plans over `/api/v1/plans`.
//
// A plan is the recurring sibling of a checkout link: it describes an amount
// per period and exposes a hosted `checkoutUrl` the customer signs a mandate
// on. Everything is scoped to the key's own account, so a plan owned by someone
// else answers 404 (GenesisPayNotFoundError) rather than 403 — the API is no
// plan-enumeration oracle, and the SDK does not paper over that.

import { GenesisPayConfigError } from "./errors.js";
import {
  asRecord,
  optionalString,
  requiredString,
  toAmountString,
  toCount,
  oneOf,
  type GenesisPayRequest,
} from "./resource.js";

export type SubscriptionPlanStatus = "active" | "archived";

export type SubscriptionPlan = {
  /** Internal id. Address a plan by `publicId` — that is what the routes take. */
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  asset: "USDC" | "EURC";
  /** Decimal amount charged per period, e.g. "9.00". */
  amountPerPeriod: string;
  /** Same amount in 6-decimal minor units, as a string (no precision loss). */
  amountPerPeriodMinor: string;
  periodDays: number;
  /**
   * How many periods of allowance the customer approves up front. The mandate's
   * total allowance is `amountPerPeriodMinor * prepaidCycles`; when it runs out
   * the customer signs again.
   */
  prepaidCycles: number;
  capPerChargeMinor: string;
  allowanceMinor: string;
  destinationWallet: string;
  chainId: number;
  status: SubscriptionPlanStatus;
  /**
   * The hosted subscribe flow (`/subscribe/:publicId`) — send the customer
   * here. This is the whole reason to call the API rather than build the URL
   * yourself: the host depends on the deployment the key points at.
   */
  checkoutUrl: string;
  createdAt: string;
  archivedAt: string | null;
};

export type PlanCreateInput = {
  title: string;
  /** Decimal amount per period, e.g. "9" or "9.00". */
  amountPerPeriod: string;
  /** Billing period in whole days, e.g. 30. */
  periodDays: number;
  description?: string;
  /** Periods of allowance collected in one signature. Server default applies. */
  prepaidCycles?: number;
  /** Defaults to the account's receiving wallet. */
  destinationWallet?: string;
  /** Defaults to USDC. */
  asset?: "USDC" | "EURC";
};

export interface PlansResource {
  create(input: PlanCreateInput): Promise<SubscriptionPlan>;
  list(): Promise<SubscriptionPlan[]>;
  retrieve(publicId: string): Promise<SubscriptionPlan>;
  /**
   * Stops the hosted page from taking new subscribers. Mandates already signed
   * from this plan keep billing until the payer revokes them — archiving is not
   * a cancellation. Archiving twice is a no-op that returns the same plan.
   */
  archive(publicId: string): Promise<SubscriptionPlan>;
}

export function createPlansResource(
  request: GenesisPayRequest,
  /**
   * Applies the client's `expectedPayTo` pin to the wallet the server froze
   * onto the plan. A plan's destination is where every future renewal settles,
   * so it is exactly the value the pin exists to guard.
   */
  assertPinnedDestination: (wallet: unknown, what: string) => void = () => {},
): PlansResource {
  return {
    create: async (input) => {
      const body = await request({
        method: "POST",
        path: "/api/v1/plans",
        operation: "POST /api/v1/plans",
        action: "create a subscription plan",
        body: {
          title: input.title,
          amountPerPeriod: input.amountPerPeriod,
          periodDays: input.periodDays,
          ...(input.description ? { description: input.description } : {}),
          ...(input.prepaidCycles === undefined
            ? {}
            : { prepaidCycles: input.prepaidCycles }),
          ...(input.destinationWallet
            ? { destinationWallet: input.destinationWallet }
            : {}),
          ...(input.asset ? { asset: input.asset } : {}),
        },
      });
      const plan = requirePlan(body, "POST /api/v1/plans");
      assertPinnedDestination(plan.destinationWallet, "subscription plan");
      return plan;
    },

    list: async () => {
      const body = await request({
        path: "/api/v1/plans",
        operation: "GET /api/v1/plans",
        action: "list subscription plans",
      });
      const plans = asRecord(body)?.plans;
      if (!Array.isArray(plans)) {
        // A list endpoint that answers 200 without a list is a broken contract,
        // not an old backend. Returning [] here would hide it as "no plans yet".
        throw new GenesisPayConfigError(
          `GenesisPay GET /api/v1/plans returned no plans array: ${JSON.stringify(body)}`,
        );
      }
      // Individual entries stay tolerant: one unusable row must not lose the rest.
      return plans
        .map(asRecord)
        .filter((raw): raw is Record<string, unknown> => raw !== null)
        .filter((raw) => typeof raw.publicId === "string" && raw.publicId.length > 0)
        .map(toSubscriptionPlan);
    },

    retrieve: async (publicId) => {
      const id = requirePublicId(publicId, "plans.retrieve");
      const body = await request({
        path: `/api/v1/plans/${encodeURIComponent(id)}`,
        operation: `GET /api/v1/plans/${id}`,
        action: `retrieve subscription plan "${id}"`,
        notFoundMessage: notFoundMessage(id),
      });
      return requirePlan(body, `GET /api/v1/plans/${id}`);
    },

    archive: async (publicId) => {
      const id = requirePublicId(publicId, "plans.archive");
      const body = await request({
        method: "POST",
        path: `/api/v1/plans/${encodeURIComponent(id)}/archive`,
        operation: `POST /api/v1/plans/${id}/archive`,
        action: `archive subscription plan "${id}"`,
        notFoundMessage: notFoundMessage(id),
      });
      return requirePlan(body, `POST /api/v1/plans/${id}/archive`);
    },
  };
}

function notFoundMessage(id: string): string {
  return (
    `No GenesisPay subscription plan with publicId "${id}". Check the id and that ` +
    `it belongs to the account this API key authenticates.`
  );
}

function requirePublicId(publicId: string, method: string): string {
  const id = publicId?.trim();
  if (!id) {
    throw new GenesisPayConfigError(
      `${method}(publicId) requires the publicId returned by plans.create().`,
    );
  }
  return id;
}

function requirePlan(body: unknown, operation: string): SubscriptionPlan {
  const raw = asRecord(asRecord(body)?.plan);
  if (!raw || typeof raw.publicId !== "string" || !raw.publicId) {
    throw new GenesisPayConfigError(
      `GenesisPay ${operation} returned no plan: ${JSON.stringify(body)}`,
    );
  }
  return toSubscriptionPlan(raw);
}

export function toSubscriptionPlan(raw: Record<string, unknown>): SubscriptionPlan {
  return {
    id: requiredString(raw.id),
    publicId: requiredString(raw.publicId),
    title: requiredString(raw.title),
    description: optionalString(raw.description),
    asset: oneOf(raw.asset, ["USDC", "EURC"] as const, "USDC"),
    amountPerPeriod: toAmountString(raw.amountPerPeriod),
    amountPerPeriodMinor: toAmountString(raw.amountPerPeriodMinor),
    periodDays: toCount(raw.periodDays),
    prepaidCycles: toCount(raw.prepaidCycles),
    capPerChargeMinor: toAmountString(raw.capPerChargeMinor),
    allowanceMinor: toAmountString(raw.allowanceMinor),
    destinationWallet: requiredString(raw.destinationWallet),
    chainId: toCount(raw.chainId),
    // Degrade to "archived", not "active": a status this SDK version does not
    // know (a future "paused", "deleted", …) must not read as "keep sending
    // customers to this checkoutUrl". Mirrors mandate status degrading to the
    // inert `pending_permit`.
    status: oneOf(raw.status, ["active", "archived"] as const, "archived"),
    checkoutUrl: requiredString(raw.checkoutUrl),
    createdAt: requiredString(raw.createdAt),
    archivedAt: optionalString(raw.archivedAt),
  };
}
