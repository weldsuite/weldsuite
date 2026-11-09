import { z } from 'zod';

// `/api/articles` — Knowledge-base articles backed by `helpdesk_articles`.

/** Editorial lifecycle. Only `published` articles are eligible for the public help center. */
export const ARTICLE_STATUSES = ['draft', 'review', 'published', 'archived', 'outdated'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/**
 * Who may read a published article on the help center and in the widget:
 * - `public`: everyone;
 * - `logged_in`: a reader with a verified email (signed in on the help center,
 *   or a widget visitor the customer's site identified);
 * - `groups`: a reader whose verified email belongs to a CRM person at one of
 *   `audienceCompanyIds` (CRM companies);
 * - `internal`: the team only, never served publicly.
 * (`specific_users` is a legacy value no write accepts.)
 */
export const ARTICLE_VISIBILITIES = ['public', 'logged_in', 'groups', 'internal'] as const;
export type ArticleVisibility = (typeof ARTICLE_VISIBILITIES)[number];

/** A language tag: `nl`, `en`, `pt-br`. Stored lower-cased. */
export const ARTICLE_LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
export const articleLocaleSchema = z.string().regex(ARTICLE_LOCALE_PATTERN, 'Invalid locale');

/** CRM company ids for visibility `groups`. */
export const articleAudienceSchema = z.array(z.string().min(1).max(30)).max(100);

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
    audienceCompanyIds: articleAudienceSchema.optional(),
    /** The article's language; null = the help center's default language. */
    locale: articleLocaleSchema.nullish(),
    tags: z.array(z.string()).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

export const updateArticleSchema = createArticleSchema.partial();

export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;

/**
 * `POST /api/articles/:id/translations`: a language version of the article
 * (`:id` may be the original or one of its versions). Title and content
 * default to the original's, for the translator to replace; it starts as a
 * draft with the original's visibility, audience and folder.
 */
export const createArticleTranslationSchema = z.object({
  locale: articleLocaleSchema,
  title: z.string().min(1).max(500).optional(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
});

export type CreateArticleTranslationInput = z.infer<typeof createArticleTranslationSchema>;

/** One language version of an article, as `GET /api/articles/:id/translations` lists it (the original first). */
export const articleVersionSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  status: z.string(),
  visibility: z.string(),
  locale: z.string().nullable(),
  translationOfId: z.string().nullable(),
  updatedAt: z.string(),
});

export type ArticleVersion = z.infer<typeof articleVersionSchema>;

/** A `helpdesk_articles` row, as /api/articles returns it. */
export const helpdeskArticleSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    title: z.string(),
    slug: z.string(),
    content: z.string(),
    excerpt: z.string().nullable(),
    category: z.string().nullable(),
    categoryId: z.string().nullable(),
    categoryName: z.string().nullable(),
    subcategoryId: z.string().nullable(),
    sectionId: z.string().nullable(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    keywords: z.unknown(),
    authorId: z.string(),
    authorName: z.string().nullable(),
    reviewerId: z.string().nullable(),
    status: z.string(),
    visibility: z.string(),
    audienceCompanyIds: z.array(z.string()),
    locale: z.string().nullable(),
    translationOfId: z.string().nullable(),
    publishedAt: z.string().nullable(),
    unpublishedAt: z.string().nullable(),
    scheduledPublishAt: z.string().nullable(),
    version: z.number().nullable(),
    isDraft: z.boolean().nullable(),
    previousVersionId: z.string().nullable(),
    tableOfContents: z.string().nullable(),
    readTime: z.number().nullable(),
    difficulty: z.string().nullable(),
    featuredImage: z.string().nullable(),
    attachments: z.unknown(),
    videos: z.unknown(),
    viewCount: z.number().nullable(),
    likeCount: z.number().nullable(),
    dislikeCount: z.number().nullable(),
    helpfulCount: z.number().nullable(),
    notHelpfulCount: z.number().nullable(),
    relatedArticles: z.unknown(),
    relatedProducts: z.unknown(),
    relatedTickets: z.unknown(),
    tags: z.unknown(),
    customFields: z.unknown(),
    isPinned: z.boolean().nullable(),
    allowComments: z.boolean().nullable(),
    requiresLogin: z.boolean().nullable(),
  })
  .passthrough();
