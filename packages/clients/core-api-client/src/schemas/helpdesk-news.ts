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

/** A `helpdesk_news` row, as /api/helpdesk-news returns it. */
export const helpdeskNewsItemSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    title: z.string(),
    content: z.string(),
    excerpt: z.string().nullable(),
    category: z.string().nullable(),
    tags: z.unknown(),
    status: z.string(),
    featuredImage: z.string().nullable(),
    authorId: z.string(),
    authorName: z.string().nullable(),
    publishedAt: z.string().nullable(),
    viewCount: z.number().nullable(),
    likeCount: z.number().nullable(),
    commentCount: z.number().nullable(),
    isPinned: z.boolean().nullable(),
  })
  .passthrough();
