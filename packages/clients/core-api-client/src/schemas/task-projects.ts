import { z } from 'zod';

// `/api/task-projects` — backed by `task_projects`. Workflow task project
// groupings (distinct from WeldFlow `projects`).

export const createTaskProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateTaskProjectSchema = createTaskProjectSchema.partial();
export type CreateTaskProjectInput = z.infer<typeof createTaskProjectSchema>;
export type UpdateTaskProjectInput = z.infer<typeof updateTaskProjectSchema>;
