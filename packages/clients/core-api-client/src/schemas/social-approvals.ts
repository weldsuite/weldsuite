import { z } from 'zod';

export const createSocialApprovalSchema = z.object({
  postId: z.string().nullish(),
  approverId: z.string().nullish(),
  status: z.string().max(30).optional(),
  comment: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSocialApprovalSchema = createSocialApprovalSchema.partial();
export type CreateSocialApprovalInput = z.infer<typeof createSocialApprovalSchema>;
export type UpdateSocialApprovalInput = z.infer<typeof updateSocialApprovalSchema>;
