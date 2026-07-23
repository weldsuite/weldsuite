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
