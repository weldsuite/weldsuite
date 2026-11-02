import { z } from 'zod';

// `/api/helpdesk-faqs` — backed by `helpdesk_faqs`.

export const createHelpdeskFaqSchema = z.object({
  question: z.string().min(1),
  answer: z.string(),
  category: z.string().max(100).optional(),
  sortOrder: z.number().int().optional(),
  isPublished: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskFaqSchema = createHelpdeskFaqSchema.partial();

export type CreateHelpdeskFaqInput = z.infer<typeof createHelpdeskFaqSchema>;
export type UpdateHelpdeskFaqInput = z.infer<typeof updateHelpdeskFaqSchema>;

/** A `helpdesk_faqs` row, as /api/helpdesk-faqs returns it. */
export const helpdeskFaqSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    question: z.string(),
    answer: z.string(),
    category: z.string().nullable(),
    order: z.number().nullable(),
    isPublished: z.boolean(),
    publishedAt: z.string().nullable(),
    viewCount: z.number().nullable(),
    helpfulCount: z.number().nullable(),
    notHelpfulCount: z.number().nullable(),
    relatedFAQs: z.unknown(),
    relatedArticles: z.unknown(),
    tags: z.unknown(),
  })
  .passthrough();
