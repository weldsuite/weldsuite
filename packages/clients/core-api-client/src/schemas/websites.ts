import { z } from 'zod';

export const createWebsiteSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.string().max(30).optional(),
  themeId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateWebsiteSchema = createWebsiteSchema.partial();
export type CreateWebsiteInput = z.infer<typeof createWebsiteSchema>;
export type UpdateWebsiteInput = z.infer<typeof updateWebsiteSchema>;
