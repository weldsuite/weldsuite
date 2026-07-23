import { z } from 'zod';

// `/api/helpdesk-news` — backed by `helpdesk_news`.

export const createHelpdeskNewsSchema = z.object({
  title: z.string().min(1).max(500),
  excerpt: z.string().optional(),
  body: z.string().optional(),
  publishedAt: z.string().optional(),
  authorId: z.string().nullish(),
  isPublished: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskNewsSchema = createHelpdeskNewsSchema.partial();

export type CreateHelpdeskNewsInput = z.infer<typeof createHelpdeskNewsSchema>;
export type UpdateHelpdeskNewsInput = z.infer<typeof updateHelpdeskNewsSchema>;
