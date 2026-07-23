/**
 * Task Module Types for Mobile App
 * Based on platform types from apps/web/platform/lib/api/types/apps/task.types.ts
 */

// ============================================================================
// PERSONAL TASK MANAGEMENT TYPES
// ============================================================================

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'completed' | 'cancelled';

export interface TaskItem {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: string;
  assigneeId?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeAvatar?: string;
  projectId?: string;
  projectName?: string;
  tags?: string[];
  isImportant?: boolean;
  isArchived?: boolean;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  taskCount?: number;
  completedTaskCount?: number;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
  taskCount?: number;
  workspaceId: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role?: string;
  assignedTaskCount?: number;
  completedTaskCount?: number;
}

export interface TaskStats {
  total: number;
  todo: number;
  inProgress: number;
  completed: number;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
}

export interface TaskDashboardData {
  stats: TaskStats;
  recentTasks: TaskItem[];
  upcomingTasks: TaskItem[];
  importantTasks: TaskItem[];
}

export interface TaskComment {
  id: string;
  taskId: string;
  content: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivity {
  id: string;
  taskId: string;
  type: 'created' | 'updated' | 'completed' | 'commented' | 'assigned' | 'status_changed';
  description: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  createdAt: string;
  metadata?: Record<string, any>;
}

// DTOs
export interface CreateTaskDto {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string;
  assigneeId?: string;
  projectId?: string;
  tags?: string[];
  isImportant?: boolean;
}

export interface UpdateTaskDto {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string;
  assigneeId?: string;
  projectId?: string;
  tags?: string[];
  isImportant?: boolean;
  isArchived?: boolean;
}

export interface CreateProjectDto {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface UpdateProjectDto {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface CreateTagDto {
  name: string;
  color?: string;
}

export interface TaskFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string;
  projectId?: string;
  tags?: string[];
  isImportant?: boolean;
  isArchived?: boolean;
  dueBefore?: string;
  dueAfter?: string;
  search?: string;
}

// ============================================================================
// WORKFLOW AUTOMATION TYPES
// ============================================================================

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export type TriggerCategory = 'schedule' | 'entity_event' | 'webhook' | 'manual' | 'api';
export type ActionCategory = 'communication' | 'data' | 'integration' | 'logic' | 'utility' | 'ai' | 'custom';
export type VariableScope = 'global' | 'workflow' | 'execution';

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  version: number;
  trigger?: Trigger;
  steps: WorkflowStep[];
  settings: WorkflowSettings;
  executionCount: number;
  successCount: number;
  failureCount: number;
  averageExecutionTime?: number;
  lastExecutedAt?: string;
  tags?: string[];
  folderId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
}

export interface WorkflowStep {
  id: string;
  type: string;
  name: string;
  description?: string;
  config: ActionConfig;
  inputs: Record<string, any>;
  condition?: Condition;
  onError?: ErrorHandler;
  position?: { x: number; y: number };
  timeout?: number;
  retryPolicy?: RetryPolicy;
  continueOnError?: boolean;
}

export interface WorkflowSettings {
  maxConcurrentExecutions?: number;
  executionTimeout?: number;
  autoRetryOnFailure?: boolean;
  maxRetries?: number;
  notifyOnSuccess?: boolean;
  notifyOnFailure?: boolean;
  notificationChannels?: string[];
  logLevel?: 'debug' | 'info' | 'warning' | 'error';
  retentionDays?: number;
}

export interface Trigger {
  id: string;
  type: string;
  category: TriggerCategory;
  config: TriggerConfig;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TriggerConfig =
  | ScheduleTriggerConfig
  | EntityEventTriggerConfig
  | WebhookTriggerConfig
  | ManualTriggerConfig;

export interface ScheduleTriggerConfig {
  type: 'schedule';
  cronExpression?: string;
  interval?: number;
  timezone?: string;
  startDate?: string;
  endDate?: string;
}

export interface EntityEventTriggerConfig {
  type: 'entity_event';
  entityType: string;
  events: EntityEvent[];
  conditions?: Condition[];
}

export interface EntityEvent {
  eventType: 'created' | 'updated' | 'deleted' | 'status_changed';
  statusFrom?: string;
  statusTo?: string;
  fields?: string[];
}

export interface WebhookTriggerConfig {
  type: 'webhook';
  webhookId: string;
  secret: string;
  validateSignature: boolean;
  allowedIps?: string[];
}

export interface ManualTriggerConfig {
  type: 'manual';
  requiresApproval?: boolean;
  requiredParameters?: ParameterDefinition[];
}

export interface ParameterDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description?: string;
  defaultValue?: any;
}

export interface ActionConfig {
  actionTypeId: string;
  version?: string;
  settings?: Record<string, any>;
}

export interface Condition {
  operator: 'and' | 'or';
  rules: ConditionRule[];
}

export interface ConditionRule {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'greater_than' | 'less_than' | 'in' | 'not_in' | 'exists' | 'not_exists';
  value: any;
}

export interface ErrorHandler {
  strategy: 'continue' | 'retry' | 'fail' | 'custom';
  retryPolicy?: RetryPolicy;
  fallbackStep?: string;
  notifyOnError?: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
}

export interface Execution {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: ExecutionStatus;
  triggeredBy: string;
  triggerType: string;
  triggerData?: any;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  steps: ExecutionStep[];
  currentStep?: string;
  output?: any;
  error?: ExecutionError;
  executionContext?: Record<string, any>;
  workspaceId: string;
}

export interface ExecutionStep {
  stepId: string;
  stepName: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  input?: any;
  output?: any;
  error?: ExecutionError;
  retryCount?: number;
  logs?: ExecutionLog[];
}

export interface ExecutionError {
  code: string;
  message: string;
  details?: any;
  stackTrace?: string;
  stepId?: string;
}

export interface ExecutionLog {
  timestamp: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  stepId?: string;
  metadata?: Record<string, any>;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  workflow: Partial<Workflow>;
  configurationSchema?: any;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  usageCount: number;
  rating?: number;
  tags?: string[];
  thumbnail?: string;
  authorId: string;
  authorName?: string;
  isOfficial?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Schedule {
  id: string;
  workflowId: string;
  workflowName: string;
  cronExpression?: string;
  interval?: number;
  timezone: string;
  startDate?: string;
  endDate?: string;
  isEnabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
}

export interface WorkflowStats {
  totalWorkflows: number;
  activeWorkflows: number;
  pausedWorkflows: number;
  draftWorkflows: number;
  totalExecutions: number;
  executionsToday: number;
  executionsThisWeek: number;
  executionsThisMonth: number;
  successRate: number;
  averageExecutionTime: number;
  failedExecutionsToday: number;
  failedExecutionsThisWeek: number;
}

export interface WorkflowMetrics {
  workflowId: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
  averageExecutionTime: number;
  minExecutionTime: number;
  maxExecutionTime: number;
  executionsByDay: Array<{ date: string; count: number; successCount: number; failureCount: number }>;
  slowestSteps: Array<{ stepId: string; stepName: string; averageDuration: number }>;
  commonErrors: Array<{ error: string; count: number }>;
}

export interface ExecutionTrends {
  period: 'day' | 'week' | 'month';
  data: Array<{
    date: string;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    averageDuration: number;
  }>;
}

// Filter types
export interface WorkflowFilters {
  status?: WorkflowStatus;
  search?: string;
  tags?: string[];
  folderId?: string;
  createdBy?: string;
  triggerType?: string;
}

export interface ExecutionFilters {
  workflowId?: string;
  status?: ExecutionStatus;
  triggeredBy?: string;
  startDate?: string;
  endDate?: string;
}

export interface TemplateFilters {
  category?: string;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  search?: string;
  sortBy?: 'popularity' | 'name' | 'createdAt' | 'rating';
}

// Create/Update DTOs
export interface CreateWorkflowDto {
  name: string;
  description?: string;
  trigger?: Partial<Trigger>;
  steps?: WorkflowStep[];
  settings?: Partial<WorkflowSettings>;
  tags?: string[];
  folderId?: string;
}

export interface UpdateWorkflowDto {
  name?: string;
  description?: string;
  status?: WorkflowStatus;
  trigger?: Partial<Trigger>;
  steps?: WorkflowStep[];
  settings?: Partial<WorkflowSettings>;
  tags?: string[];
  folderId?: string;
}

export interface CreateScheduleDto {
  workflowId: string;
  cronExpression?: string;
  interval?: number;
  timezone?: string;
  startDate?: string;
  endDate?: string;
}

export interface UpdateScheduleDto {
  cronExpression?: string;
  interval?: number;
  timezone?: string;
  startDate?: string;
  endDate?: string;
  isEnabled?: boolean;
}
