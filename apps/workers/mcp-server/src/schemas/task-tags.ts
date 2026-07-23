// AUTO-COPIED from @weldsuite/core-api-client/schemas/task-tags
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createTaskTagSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(50).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateTaskTagSchema = createTaskTagSchema.partial();
export type CreateTaskTagInput = z.infer<typeof createTaskTagSchema>;
export type UpdateTaskTagInput = z.infer<typeof updateTaskTagSchema>;
