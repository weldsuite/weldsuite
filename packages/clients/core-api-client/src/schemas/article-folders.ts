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
