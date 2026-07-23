import { z } from 'zod';

export const createSocialTeamMemberSchema = z.object({
  userId: z.string(),
  role: z.string().max(50).optional(),
  accountIds: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateSocialTeamMemberSchema = createSocialTeamMemberSchema.partial();
export type CreateSocialTeamMemberInput = z.infer<typeof createSocialTeamMemberSchema>;
export type UpdateSocialTeamMemberInput = z.infer<typeof updateSocialTeamMemberSchema>;
