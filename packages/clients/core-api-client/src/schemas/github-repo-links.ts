import { z } from 'zod';

export const createGithubRepoLinkSchema = z.object({
  connectionId: z.string(),
  repoFullName: z.string().min(1).max(255),
  projectId: z.string().nullish(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateGithubRepoLinkSchema = createGithubRepoLinkSchema.partial();
export type CreateGithubRepoLinkInput = z.infer<typeof createGithubRepoLinkSchema>;
export type UpdateGithubRepoLinkInput = z.infer<typeof updateGithubRepoLinkSchema>;
