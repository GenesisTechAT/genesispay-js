import { z } from "zod";
import { serviceContractSchema } from "./service-contract.js";

export const externalServiceIdSchema = z.string().regex(/^ext_[a-z0-9_]{3,64}$/);
export const externalServiceQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
const httpsUrl = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
});
export const externalServiceSchema = z.strictObject({
  id: externalServiceIdSchema,
  origin: z.literal("external_x402"),
  provider: z.string().min(1).max(100),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1500),
  resourceUrl: httpsUrl,
  method: z.enum(["GET", "POST"]),
  sources: z.array(httpsUrl).min(1).max(3),
  checkedAt: z.iso.datetime(),
  priceHint: z.strictObject({ asset: z.literal("USDC"), amountMinor: z.string().regex(/^[1-9][0-9]{0,77}$/), network: z.literal("eip155:8453") }),
  evidence: z.strictObject({ kind: z.literal("unsigned_402"), maxTimeoutSeconds: z.number().int().min(300).max(3600), purchaseTested: z.literal(false) }),
  contract: serviceContractSchema,
}).superRefine((value, ctx) => {
  if (value.resourceUrl !== value.contract.resourceUrl || value.method !== value.contract.method || value.checkedAt !== value.contract.provenance.checkedAt) {
    ctx.addIssue({ code: "custom", message: "Inconsistent external service observation" });
  }
});
export const externalServicePageSchema = z.strictObject({ services: z.array(externalServiceSchema).max(20) });
export type ExternalService = z.infer<typeof externalServiceSchema>;
export type ExternalServiceQuery = z.infer<typeof externalServiceQuerySchema>;
