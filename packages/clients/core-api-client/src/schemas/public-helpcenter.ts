/**
 * The public help center feed (/public/helpcenter/*, desk-api) that the
 * helpcenter renderer reads: branding, the category tree and the published
 * public articles. The lists are page-based, not cursor-based.
 */
import { z } from 'zod';

/** GET /config: the branding and SEO of an enabled help center. */
export const publicHelpcenterConfigSchema = z.object({
  siteName: z.string().nullable(),
  logo: z.string().nullable(),
  logoDark: z.string().nullable(),
  favicon: z.string().nullable(),
  primaryColor: z.string().nullable(),
  accentColor: z.string().nullable(),
  heroTitle: z.string().nullable(),
  heroSubtitle: z.string().nullable(),
  /** 0 or 1. */
  showSearch: z.number().int().nullable(),
  showCategories: z.number().int().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  ogImage: z.string().nullable(),
  footerText: z.string().nullable(),
  socialLinks: z.record(z.string()).nullable(),
  customCss: z.string().nullable(),
  googleAnalyticsId: z.string().nullable(),
});

/** GET /folders: one category, with its count of published public articles. */
export const publicHelpcenterFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  sortOrder: z.number().int(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  articleCount: z.number().int().nonnegative(),
});

const pageSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/** An article in GET /articles. */
export const publicHelpcenterArticleSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  folderId: z.string().nullable(),
  viewCount: z.number().int(),
  helpfulCount: z.number().int(),
  notHelpfulCount: z.number().int(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** GET /articles: `{ data, pagination }` with page-based pagination. */
export const publicHelpcenterArticlePageSchema = z.object({
  data: z.array(publicHelpcenterArticleSummarySchema),
  pagination: pageSchema,
});

/** GET /articles/:slug: the article with its content, the view just counted. */
export const publicHelpcenterArticleSchema = publicHelpcenterArticleSummarySchema.extend({ content: z.string() });

/** POST /articles/:id/feedback. */
export const publicHelpcenterFeedbackSchema = z.object({ recorded: z.literal(true) });

/** A hit in GET /search. */
export const publicHelpcenterSearchHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  folderId: z.string().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

/** GET /search: `{ data, pagination }` with page-based pagination. */
export const publicHelpcenterSearchPageSchema = z.object({
  data: z.array(publicHelpcenterSearchHitSchema),
  pagination: pageSchema,
});
