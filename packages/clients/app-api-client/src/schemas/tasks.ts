import { z } from 'zod';

const repeatSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom']),
  interval: z.number().optional(),
  unit: z.enum(['days', 'weeks', 'months', 'years']).optional(),
});

export const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  projectId: z.string().nullish(),
  sprintId: z.string().nullish(),
  milestoneId: z.string().nullish(),
  parentTaskId: z.string().nullish(),
  stageId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  assigneeIds: z.array(z.string()).optional(),
  reporterId: z.string().nullish(),
  status: z.string().max(30).optional(),
  priority: z.string().max(20).optional(),
  type: z.string().max(50).optional(),
  dueDate: z.string().optional(),
  startDate: z.string().optional(),
  estimateMinutes: z.number().int().optional(),
  estimatedHours: z.string().optional(),
  duration: z.number().optional(),
  storyPoints: z.number().optional(),
  labels: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  customerId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  isBillable: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  repeat: repeatSchema.nullable().optional(),
  customFields: z.record(z.any()).nullable().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateTaskSchema = createTaskSchema.partial();
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// Move a task (and its subtasks) to another project. Project-scoped references
// (sprint / milestone / stage / key / board position) are cleared & reset
// server-side to the destination project's defaults.
export const moveTaskSchema = z.object({
  projectId: z.string().min(1),
});
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
