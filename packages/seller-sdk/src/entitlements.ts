import { GenesisPayConfigError } from "./errors.js";
import { asRecord, optionalString, requiredString, type GenesisPayRequest } from "./resource.js";

export type VerifiedEntitlement = {
  valid: boolean;
  entitlement: {
    publicId: string;
    productId: string;
    sku: string | null;
    paymentAttemptId: string;
    simulated: boolean;
    expiresAt: string;
    redemptionCount: number;
  };
};

export interface EntitlementsResource {
  /** Seller-scoped hard check for a redirect entitlement. */
  verify(entitlementId: string): Promise<VerifiedEntitlement>;
}

export function createEntitlementsResource(request: GenesisPayRequest): EntitlementsResource {
  return {
    async verify(entitlementId) {
      const id = entitlementId?.trim();
      if (!id?.startsWith("ent_")) throw new GenesisPayConfigError("entitlements.verify requires an ent_… id.");
      const body = await request({
        path: `/api/v1/entitlements/verify?entitlement=${encodeURIComponent(id)}`,
        operation: "GET /api/v1/entitlements/verify",
        action: `verify entitlement "${id}"`,
        notFoundMessage: "The entitlement does not exist or does not belong to this seller.",
      });
      const root = asRecord(body); const raw = asRecord(root?.entitlement);
      if (!raw) throw new GenesisPayConfigError("GenesisPay entitlement verification returned no entitlement.");
      return {
        valid: root?.valid === true,
        entitlement: {
          publicId: requiredString(raw.publicId), productId: requiredString(raw.productId), sku: optionalString(raw.sku),
          paymentAttemptId: requiredString(raw.paymentAttemptId), simulated: raw.simulated === true,
          expiresAt: requiredString(raw.expiresAt), redemptionCount: typeof raw.redemptionCount === "number" ? raw.redemptionCount : 0,
        },
      };
    },
  };
}
