import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().max(255).optional(),
  description: z.string().optional(),
  parentId: z.string().nullish(),
  imageUrl: z.string().optional(),
  position: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCategorySchema = createCategorySchema.partial();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
