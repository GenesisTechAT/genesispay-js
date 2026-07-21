import { z } from "zod";

const agentPaymentStatusSchema = z.enum([
  "pending_approval",
  "approved",
  "denied",
  "executing",
  "settled",
  "failed",
  "expired",
]);

export const agentPaymentRecordSchema = z.object({
  id: z.string(),
  agentAccountId: z.string(),
  resourceUrl: z.string(),
  description: z.string().nullable(),
  destinationWallet: z.string(),
  asset: z.enum(["USDC", "EURC"]).optional(),
  amountUsdcMinor: z.string(),
  feeUsdcMinor: z.string(),
  chainId: z.number().int(),
  status: agentPaymentStatusSchema,
  txHash: z.string().nullable(),
  failureReason: z.string().nullable(),
  approvalExpiresAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  createdAt: z.string(),
});

export const agentHttpResponseCaptureSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  bodyBase64: z.string(),
  mimeType: z.string(),
});

export const settledPayResponseSchema = z.object({
  paymentId: z.string(),
  status: z.literal("settled"),
  txHash: z.string().nullable(),
  response: agentHttpResponseCaptureSchema.nullable().optional(),
  payment: agentPaymentRecordSchema,
});

export const pendingApprovalPayResponseSchema = z.object({
  paymentId: z.string(),
  status: z.literal("pending_approval"),
  approvalUrl: z.string().optional(),
  payment: agentPaymentRecordSchema,
});

export const failedPayResponseSchema = z.object({
  paymentId: z.string(),
  status: z.literal("failed"),
  error: z.string(),
  payment: agentPaymentRecordSchema,
});

export const paymentStatusResponseSchema = z.object({
  payment: agentPaymentRecordSchema,
});

export const accountResponseSchema = z.object({
  name: z.string(),
  walletAddress: z.string(),
  chainId: z.number().int(),
  status: z.enum(["active", "paused"]),
  usdcBalance: z.string().nullable(),
  policy: z.object({
    perPaymentCapUsdcMinor: z.string().nullable(),
    dailyCapUsdcMinor: z.string().nullable(),
    monthlyCapUsdcMinor: z.string().nullable(),
    allowlistEnabled: z.boolean(),
  }),
  spentTodayUsdcMinor: z.string(),
  spentThisMonthUsdcMinor: z.string(),
});

export const discoveredServiceSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  priceUsdc: z.string(),
  kind: z.enum(["api", "link"]),
  resourceUrl: z.string(),
  category: z.string().nullable(),
});

export const discoveryResponseSchema = z.object({
  listings: z.array(discoveredServiceSchema),
});

export const apiErrorBodySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});
