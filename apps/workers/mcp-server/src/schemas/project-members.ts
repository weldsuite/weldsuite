// AUTO-COPIED from @weldsuite/core-api-client/schemas/project-members
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createProjectMemberSchema = z.object({
  projectId: z.string(),
  userId: z.string(),
  role: z.string().max(50).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProjectMemberSchema = createProjectMemberSchema.partial();
export type CreateProjectMemberInput = z.infer<typeof createProjectMemberSchema>;
export type UpdateProjectMemberInput = z.infer<typeof updateProjectMemberSchema>;
