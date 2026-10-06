import { z } from "zod";
import { externalServiceIdSchema } from "./external-service.js";
import { preparedReviewResponseSchema, publishedReviewResponseSchema, publicReviewsResponseSchema } from "./reviews.js";

export const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local_product"), productId: z.string().min(1).max(128), title: z.string().max(300).optional() }),
  z.object({ kind: z.literal("external_service"), serviceId: externalServiceIdSchema, title: z.string().max(300).optional() }),
]);
export const preparedPurchaseReviewSchema = preparedReviewResponseSchema.shape.review.omit({ productId: true }).extend({ target: reviewTargetSchema });
export const publishedPurchaseReviewSchema = publishedReviewResponseSchema.shape.review.omit({ productId: true }).extend({ target: reviewTargetSchema });
export const preparedPurchaseReviewResponseSchema = z.object({ review: preparedPurchaseReviewSchema });
export const publishedPurchaseReviewResponseSchema = z.object({ review: publishedPurchaseReviewSchema });
export const publicPurchaseReviewsSchema = publicReviewsResponseSchema.omit({ productId: true }).extend({ target: reviewTargetSchema });
export const purchaseReviewsRequestSchema = z.object({
  id: z.union([z.string().regex(/^prod_[A-Za-z0-9_-]{8,64}$/), externalServiceIdSchema]),
  limit: z.number().int().min(1).max(50).default(10), cursor: z.string().max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export const reviewOpportunitySchema = z.object({
  paymentId: z.uuid(), state: z.enum(["eligible", "not_ready", "unsupported", "already_submitted", "draft"]),
  permission: z.enum(["enabled", "required"]), target: reviewTargetSchema.optional(),
  promptKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  nextAction: z.enum(["ask_after_use", "show_existing_draft", "ask_to_replace_draft"]).optional(),
  draft: preparedPurchaseReviewSchema.optional(),
});
export type ReviewOpportunity = z.infer<typeof reviewOpportunitySchema>;
export type PurchaseReviewTarget = z.infer<typeof reviewTargetSchema>;
export type PreparedPurchaseReview = z.infer<typeof preparedPurchaseReviewSchema>;
export type PublishedPurchaseReview = z.infer<typeof publishedPurchaseReviewSchema>;
