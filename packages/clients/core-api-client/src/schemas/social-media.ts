import { z } from 'zod';

export const createSocialMediaSchema = z.object({
  fileName: z.string().max(500),
  contentType: z.string().max(255).optional(),
  url: z.string().max(2000).optional(),
  size: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSocialMediaSchema = createSocialMediaSchema.partial();
export type CreateSocialMediaInput = z.infer<typeof createSocialMediaSchema>;
export type UpdateSocialMediaInput = z.infer<typeof updateSocialMediaSchema>;
