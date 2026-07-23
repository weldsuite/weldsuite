import { z } from 'zod';

// `/api/articles` — Knowledge-base articles backed by `helpdesk_articles`.

/** Editorial lifecycle. Only `published` articles are eligible for the public help center. */
export const ARTICLE_STATUSES = ['draft', 'review', 'published', 'archived', 'outdated'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/**
 * Visibility model. The public help center is unauthenticated, so only
 * `public` articles are ever served there; `internal` articles stay
 * staff-only inside the platform. (Legacy tiers `private` / `logged_in` /
 * `specific_users` were removed — they could never be enforced.)
 */
export const ARTICLE_VISIBILITIES = ['public', 'internal'] as const;
export type ArticleVisibility = (typeof ARTICLE_VISIBILITIES)[number];

export const createArticleSchema = z
  .object({
    title: z.string().min(1).max(500),
    slug: z.string().max(500).optional(),
    excerpt: z.string().optional(),
    content: z.string().optional(),
    // Legacy aliases still accepted from older callers; the route maps
    // either onto the canonical `content` column.
    body: z.string().optional(),
    bodyHtml: z.string().optional(),
    // `folderId` is the UI-facing name; it maps to the `category_id` FK.
    // `categoryId` is also accepted for callers that already speak the column name.
    folderId: z.string().nullish(),
    categoryId: z.string().nullish(),
    authorId: z.string().nullish(),
    authorName: z.string().max(255).optional(),
    status: z.enum(ARTICLE_STATUSES).optional(),
    visibility: z.enum(ARTICLE_VISIBILITIES).optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

export const updateArticleSchema = createArticleSchema.partial();

export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
