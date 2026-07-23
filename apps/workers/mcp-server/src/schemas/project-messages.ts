// AUTO-COPIED from @weldsuite/core-api-client/schemas/project-messages
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

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
