import { z } from 'zod';

export const createCommerceSectionSchema = z.object({
  name: z.string().max(255).optional(),
  websiteId: z.string().nullish(),
  pageId: z.string().nullish(),
  type: z.string().max(100).optional(),
  position: z.number().int().optional(),
  data: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCommerceSectionSchema = createCommerceSectionSchema.partial();
export type CreateCommerceSectionInput = z.infer<typeof createCommerceSectionSchema>;
export type UpdateCommerceSectionInput = z.infer<typeof updateCommerceSectionSchema>;
