import { z } from 'zod';

export const createGithubConnectionSchema = z.object({
  installationId: z.string().nullish(),
  accountLogin: z.string().max(255).optional(),
  status: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateGithubConnectionSchema = createGithubConnectionSchema.partial();
export type CreateGithubConnectionInput = z.infer<typeof createGithubConnectionSchema>;
export type UpdateGithubConnectionInput = z.infer<typeof updateGithubConnectionSchema>;
