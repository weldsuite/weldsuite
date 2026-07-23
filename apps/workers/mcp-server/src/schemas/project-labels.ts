// AUTO-COPIED from @weldsuite/core-api-client/schemas/project-labels
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createProjectLabelSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(50).optional(),
  projectId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProjectLabelSchema = createProjectLabelSchema.partial();
export type CreateProjectLabelInput = z.infer<typeof createProjectLabelSchema>;
export type UpdateProjectLabelInput = z.infer<typeof updateProjectLabelSchema>;
