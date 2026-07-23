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
