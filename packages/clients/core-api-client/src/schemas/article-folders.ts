import { z } from 'zod';

// `/api/article-folders` — KB article folder/category, backed by
// `helpdesk_article_folders`.

export const createArticleFolderSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().max(255).optional(),
  description: z.string().optional(),
  parentId: z.string().nullish(),
  icon: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
  sortOrder: z.number().int().optional(),
  isPublic: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateArticleFolderSchema = createArticleFolderSchema.partial();

export type CreateArticleFolderInput = z.infer<typeof createArticleFolderSchema>;
export type UpdateArticleFolderInput = z.infer<typeof updateArticleFolderSchema>;

/** A `helpdesk_article_folders` row, as /api/article-folders returns it. */
export const helpdeskArticleFolderSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    slug: z.string().nullable(),
    description: z.string().nullable(),
    parentId: z.string().nullable(),
    path: z.string().nullable(),
    level: z.number(),
    sortOrder: z.number(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    articleCount: z.number(),
  })
  .passthrough();
