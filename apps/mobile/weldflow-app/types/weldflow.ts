/**
 * WeldFlow domain types for the mobile app.
 *
 * Local copies of the shapes returned by app-api's flat object routes
 * (`/api/projects`, `/api/tasks`, `/api/my-tasks`, `/api/project-members`,
 * `/api/project-labels`). Replaces the type imports from the obsolete
 * `@weldsuite/core-api-client` package (legacy `/api/weldflow/*` surface).
 */

// ============================================================================
// Enumerations
// ============================================================================

export type ProjectStatus = 'Planning' | 'Active' | 'OnHold' | 'Completed' | 'Cancelled';

export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'testing'
  | 'done'
  | 'cancelled';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type TaskType = 'task' | 'bug' | 'story' | 'epic' | 'feature' | 'improvement' | 'subtask';

// ============================================================================
// Response envelopes (app-api: { data } / { data, pagination })
// ============================================================================

export interface DataResponse<T> {
  data: T;
}

export interface PaginationMeta {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export interface ListResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

// ============================================================================
// Query params
// ============================================================================

export interface ListProjectsQuery {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: string;
  isActive?: boolean;
}

export interface ListTasksQuery {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: string;
  priority?: string;
  assigneeId?: string;
  sprintId?: string;
  milestoneId?: string;
  type?: string;
  parentTaskId?: string;
}

export interface ListMyTasksQuery {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: string;
  priority?: string;
  projectId?: string;
}

// ============================================================================
// Inputs
// ============================================================================

export interface TaskRepeat {
  frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
  interval?: number;
  unit?: 'days' | 'weeks' | 'months' | 'years';
}

export type TaskRepeatInput = TaskRepeat;

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: string;
  stageId?: string | null;
  priority?: string;
  type?: string;
  assigneeId?: string | null;
  assigneeIds?: string[];
  reporterId?: string | null;
  sprintId?: string | null;
  milestoneId?: string | null;
  parentTaskId?: string | null;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: string;
  storyPoints?: number;
  tags?: string[];
  labels?: string[];
  isBillable?: boolean;
  duration?: number;
  repeat?: TaskRepeatInput | null;
}

export interface UpdateTaskInput extends Partial<CreateTaskInput> {
  progress?: string;
  completedDate?: string | null;
  calendarEventId?: string | null;
}

export interface UpdateTaskStatusInput {
  status: TaskStatus;
}

export interface CreateLabelInput {
  name: string;
  color: string;
}

// ============================================================================
// Entities
// ============================================================================

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
    icon?: string | null;
    status: string;
  } | null;
}

/** app-api `/api/project-members` row (user join uses `avatar`, not `picture`). */
export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  allocationPercentage?: string | null;
  hourlyRate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  user: {
    id: string | null;
    name: string | null;
    email: string | null;
    avatar: string | null;
  } | null;
}

export interface ProjectLabel {
  id: string;
  name: string;
  color: string;
  /** Present on app-api list responses (usage aggregated from tasks.labels). */
  usageCount?: number;
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
