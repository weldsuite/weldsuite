// AUTO-COPIED from @weldsuite/core-api-client/schemas/articles
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

// `/api/articles` — Knowledge-base articles backed by `helpdesk_articles`.

/** Editorial lifecycle. Only `published` articles are eligible for the public help center. */
export const ARTICLE_STATUSES = ['draft', 'review', 'published', 'archived', 'outdated'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/**
 * Who may read a published article on the help center and in the widget:
 * `public` everyone, `logged_in` readers with a verified email, `groups`
 * readers at one of `audienceCompanyIds` (CRM companies), `internal` the
 * team only.
 */
export const ARTICLE_VISIBILITIES = ['public', 'logged_in', 'groups', 'internal'] as const;
export type ArticleVisibility = (typeof ARTICLE_VISIBILITIES)[number];

/** A language tag: `nl`, `en`, `pt-br`. Stored lower-cased. */
export const ARTICLE_LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

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
    audienceCompanyIds: z.array(z.string().min(1).max(30)).max(100).optional(),
    locale: z.string().regex(ARTICLE_LOCALE_PATTERN, 'Invalid locale').nullish(),
    tags: z.array(z.string()).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

export const updateArticleSchema = createArticleSchema.partial();

export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
