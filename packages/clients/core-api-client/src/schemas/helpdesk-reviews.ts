import { z } from 'zod';

// `/api/helpdesk-reviews` — backed by `helpdesk_reviews`.

export const createHelpdeskReviewSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  customerName: z.string().max(255).optional(),
  customerEmail: z.string().email().max(255).optional(),
  ticketId: z.string().nullish(),
  isPublished: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskReviewSchema = createHelpdeskReviewSchema.partial();

export type CreateHelpdeskReviewInput = z.infer<typeof createHelpdeskReviewSchema>;
export type UpdateHelpdeskReviewInput = z.infer<typeof updateHelpdeskReviewSchema>;

/** A `helpdesk_reviews` row, as /api/helpdesk-reviews returns it. */
export const helpdeskReviewSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    type: z.string(),
    status: z.string(),
    rating: z.number(),
    title: z.string(),
    content: z.string(),
    reviewerId: z.string(),
    reviewerName: z.string(),
    reviewerEmail: z.string(),
    reviewerAvatar: z.string().nullable(),
    conversationId: z.string().nullable(),
    isVerified: z.boolean(),
    isPinned: z.boolean(),
    isFeatured: z.boolean(),
    helpfulCount: z.number(),
    helpfulVoters: z.unknown(),
    response: z.unknown(),
    metadata: z.unknown(),
  })
  .passthrough();
