import { z } from 'zod';

export const projectStatusEnum = z.enum([
  'Planning',
  'Active',
  'OnHold',
  'Completed',
  'Cancelled',
]);

export const taskStatusEnum = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'testing',
  'done',
  'cancelled',
]);

export const taskPriorityEnum = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'none',
]);

export const taskTypeEnum = z.enum([
  'task',
  'bug',
  'story',
  'epic',
  'feature',
  'improvement',
  'subtask',
]);

export const listProjectsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.string().optional(),
  customerId: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  customerId: z.string().nullish(),
  projectManagerId: z.string().nullish(),
  status: z.string().default('Planning'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  budgetedHours: z.string().optional(),
  budgetedAmount: z.string().optional(),
  billingMethod: z.string().optional(),
  hourlyRate: z.string().optional(),
  isBillable: z.boolean().default(true),
  trackTime: z.boolean().default(true),
  priority: z.string().optional(),
  type: z.string().optional(),
  methodology: z.string().optional(),
  visibility: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const listTasksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  assigneeId: z.string().optional(),
  sprintId: z.string().optional(),
  milestoneId: z.string().optional(),
  type: z.string().optional(),
  parentTaskId: z.string().optional(),
});

export const listMyTasksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  projectId: z.string().optional(),
});

export const taskRepeatSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom']),
  interval: z.number().int().positive().optional(),
  unit: z.enum(['days', 'weeks', 'months', 'years']).optional(),
});

export const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.string().default('todo'),
  stageId: z.string().nullish(),
  priority: z.string().default('medium'),
  type: z.string().default('task'),
  assigneeId: z.string().nullish(),
  assigneeIds: z.array(z.string()).optional(),
  reporterId: z.string().nullish(),
  sprintId: z.string().nullish(),
  milestoneId: z.string().nullish(),
  parentTaskId: z.string().nullish(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  estimatedHours: z.string().optional(),
  storyPoints: z.number().optional(),
  tags: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  isBillable: z.boolean().default(true),
  duration: z.number().int().positive().optional(),
  repeat: taskRepeatSchema.optional(),
});

export const updateTaskSchema = createTaskSchema.partial().extend({
  progress: z.string().optional(),
  completedDate: z.string().nullable().optional(),
  calendarEventId: z.string().nullable().optional(),
});

export const updateTaskStatusSchema = z.object({
  status: taskStatusEnum,
});

export const createLabelSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().min(1).max(50),
});
export type CreateLabelInput = z.infer<typeof createLabelSchema>;

export interface ProjectLabel {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export const LABEL_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#6b7280',
] as const;

export type ProjectStatus = z.infer<typeof projectStatusEnum>;
export type TaskStatus = z.infer<typeof taskStatusEnum>;
export type TaskPriority = z.infer<typeof taskPriorityEnum>;
export type TaskType = z.infer<typeof taskTypeEnum>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuery>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuery>;
export type ListMyTasksQuery = z.infer<typeof listMyTasksQuery>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusSchema>;
export type TaskRepeatInput = z.infer<typeof taskRepeatSchema>;

export interface Project {
  id: string;
  name: string;
  code?: string | null;
  description?: string | null;
  customerId?: string | null;
  projectManagerId?: string | null;
  status: string;
  startDate?: string | null;
  endDate?: string | null;
  actualStartDate?: string | null;
  actualEndDate?: string | null;
  budgetedHours?: string | null;
  budgetedAmount?: string | null;
  actualHours?: string | null;
  actualAmount?: string | null;
  billingMethod?: string | null;
  hourlyRate?: string | null;
  isBillable: boolean;
  isActive: boolean;
  trackTime: boolean;
  key?: string | null;
  priority?: string | null;
  type?: string | null;
  health?: string | null;
  progress: string;
  methodology?: string | null;
  visibility?: string | null;
  totalTasks: number;
  completedTasks: number;
  openTasks: number;
  totalMilestones: number;
  completedMilestones: number;
  color?: string | null;
  icon?: string | null;
  coverImage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRepeat {
  frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
  interval?: number;
  unit?: 'days' | 'weeks' | 'months' | 'years';
}

export interface ProjectTask {
  id: string;
  projectId?: string | null;
  sprintId?: string | null;
  milestoneId?: string | null;
  parentTaskId?: string | null;
  stageId?: string | null;
  title: string;
  description?: string | null;
  key?: string | null;
  status: string;
  priority: string;
  progress: string;
  type?: string | null;
  category?: string | null;
  tags?: string[] | null;
  labels?: string[] | null;
  assigneeId?: string | null;
  assigneeIds?: string[] | null;
  reporterId?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  completedDate?: string | null;
  estimatedHours?: string | null;
  actualHours?: string | null;
  storyPoints?: number | null;
  duration?: number | null;
  repeat?: TaskRepeat | null;
  calendarEventId?: string | null;
  isBillable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskWithProject extends ProjectTask {
  project?: {
    id: string;
    name: string;
    color?: string | null;
    status: string;
  } | null;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  allocationPercentage?: string | null;
  hourlyRate?: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    userId: string;
    name: string | null;
    email: string | null;
    picture: string | null;
  } | null;
}
