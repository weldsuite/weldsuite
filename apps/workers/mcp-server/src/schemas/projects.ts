// AUTO-COPIED from @weldsuite/app-api-client/schemas/projects
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.string().max(30).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  ownerId: z.string().nullish(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProjectSchema = createProjectSchema.partial();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
