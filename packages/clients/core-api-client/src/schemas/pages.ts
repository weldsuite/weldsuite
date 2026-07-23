import { z } from 'zod';

export const createPageSchema = z.object({
  title: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  websiteId: z.string().nullish(),
  content: z.unknown().optional(),
  status: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updatePageSchema = createPageSchema.partial();
export type CreatePageInput = z.infer<typeof createPageSchema>;
export type UpdatePageInput = z.infer<typeof updatePageSchema>;
