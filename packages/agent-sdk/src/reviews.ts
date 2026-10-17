import { z } from "zod";

export const prepareReviewInputSchema = z.object({ paymentId: z.uuid(), stars: z.number().int().min(1).max(5),
  comment: z.string().max(8000).transform(value => value.replace(/\r\n?/g, "\n").trim())
    .refine(value => Array.from(value).length <= 2000 && new TextEncoder().encode(value).length <= 8000)
    .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) }).strict();
export const publishReviewInputSchema = z.object({ reviewId: z.uuid(), version: z.number().int().min(1).max(2_147_483_647),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const withdrawReviewInputSchema = z.object({ reviewId: z.uuid() }).strict();

const content = z.object({ reviewId: z.uuid(), productId: z.string().min(1).max(128),
  pseudonym: z.string().regex(/^Buyer-[A-Za-z0-9_-]{12}$/),
  version: z.number().int().positive(), stars: z.number().int().min(1).max(5), comment: z.string().max(8000),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), draftExpiresAt: z.iso.datetime(),
  verifiedPurchase: z.literal(true), hidden: z.boolean(),
});
export const preparedReviewResponseSchema = z.object({ review: content.extend({ state: z.literal("draft"),
  publishedAt: z.null(), hidden: z.literal(false) }) });
export const publishedReviewResponseSchema = z.object({ review: content.extend({ state: z.literal("published"), publishedAt: z.iso.datetime() }) });
export const withdrawnReviewResponseSchema = z.object({ review: z.object({ reviewId: z.uuid(), state: z.literal("withdrawn") }) });
export type PrepareReviewInput = z.input<typeof prepareReviewInputSchema>;
export type PublishReviewInput = z.infer<typeof publishReviewInputSchema>;
export type PreparedReview = z.infer<typeof preparedReviewResponseSchema>["review"];
export type PublishedReview = z.infer<typeof publishedReviewResponseSchema>["review"];

export const reviewSummarySchema = z.object({ count: z.number().int().positive(), average: z.number().min(1).max(5) });
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export const publicReviewsRequestSchema = z.object({ id: z.string().regex(/^prod_[A-Za-z0-9_-]{8,64}$/),
  limit: z.number().int().min(1).max(50).default(10), cursor: z.string().max(256).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
export const publicReviewsResponseSchema = z.object({ productId: z.string(),
  rating: z.object({ count: z.number().int().nonnegative(), average: z.number().min(1).max(5).nullable() })
    .refine(value => (value.count === 0) === (value.average === null)),
  reviews: z.array(z.object({ reviewId: z.uuid(), pseudonym: z.string().regex(/^Buyer-[A-Za-z0-9_-]{12}$/),
    stars: z.number().int().min(1).max(5), comment: z.string().max(8000), publishedAt: z.iso.datetime(), verifiedPurchase: z.literal(true) })).max(50),
  nextCursor: z.string().max(256).nullable(),
});
export type PublicReviewPage = z.infer<typeof publicReviewsResponseSchema>;
