// AUTO-COPIED from @weldsuite/core-api-client/schemas/project-files
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createProjectFileSchema = z.object({
  projectId: z.string(),
  fileName: z.string().max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().optional(),
  url: z.string().max(2000).optional(),
  storageKey: z.string().max(500).optional(),
  uploadedBy: z.string().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProjectFileSchema = createProjectFileSchema.partial();
export type CreateProjectFileInput = z.infer<typeof createProjectFileSchema>;
export type UpdateProjectFileInput = z.infer<typeof updateProjectFileSchema>;
