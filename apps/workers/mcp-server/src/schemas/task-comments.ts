// AUTO-COPIED from @weldsuite/core-api-client/schemas/task-comments
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createTaskCommentSchema = z.object({
  taskId: z.string(),
  authorId: z.string().nullish(),
  body: z.string(),
  mentions: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateTaskCommentSchema = createTaskCommentSchema.partial();
export type CreateTaskCommentInput = z.infer<typeof createTaskCommentSchema>;
export type UpdateTaskCommentInput = z.infer<typeof updateTaskCommentSchema>;
