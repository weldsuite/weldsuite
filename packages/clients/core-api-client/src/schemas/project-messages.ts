import { z } from 'zod';

export const createProjectMessageSchema = z.object({
  projectId: z.string(),
  authorId: z.string().nullish(),
  body: z.string(),
  attachments: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProjectMessageSchema = createProjectMessageSchema.partial();
export type CreateProjectMessageInput = z.infer<typeof createProjectMessageSchema>;
export type UpdateProjectMessageInput = z.infer<typeof updateProjectMessageSchema>;
