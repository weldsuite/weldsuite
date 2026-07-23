/**
 * Task Management API Types
 */

export namespace Task {
  /**
   * Task Priority Levels
   */
  /**
   * Task Status
   */
  /**
   * Task Item
   */
  /**
   * Task Project
   */
  /**
   * Task Tag
   */
  /**
   * Team Member
   */
  /**
   * Task Statistics
   */
  /**
   * Dashboard Data
   */
  export interface DashboardData {
    stats: TaskStats;
    recentTasks: TaskItem[];
    upcomingTasks: TaskItem[];
    importantTasks: TaskItem[];
  }

  /**
   * Task Comment
   */
  /**
   * Task Activity
   */
  /**
   * Create Task DTO
   */
  /**
   * Update Task DTO
   */
  /**
   * Create Project DTO
   */
  /**
   * Update Project DTO
   */
  /**
   * Create Tag DTO
   */
  /**
   * Task Filter Options
   */
  // ============================================================================
  // AUTOMATION & WORKFLOW TYPES
  // ============================================================================

  /**
   * Workflow Status
   */
  /**
   * Execution Status
   */
  /**
   * Trigger Type Categories
   */
  /**
   * Action Category
   */
  /**
   * Variable Scope
   */
  export type VariableScope = 'global' | 'workflow' | 'execution';

  /**
   * Workflow Definition
   */
  export interface Workflow {
    id: string;
    name: string;
    description?: string;
    status: WorkflowStatus;
    version: number;

    // Trigger configuration
    trigger?: Trigger;

    // Workflow steps/actions
    steps: WorkflowStep[];

    // Settings
    settings: WorkflowSettings;

    // Statistics
    executionCount: number;
    successCount: number;
    failureCount: number;
    averageExecutionTime?: number;
    lastExecutedAt?: string;

    // Metadata
    tags?: string[];
    folderId?: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    workspaceId: string;
  }

  /**
   * Workflow Step/Action
   */
  /**
   * Workflow Settings
   */
  /**
   * Trigger Definition
   */
  export interface Trigger {
    id: string;
    type: string; // Trigger type identifier
    category: TriggerCategory;
    config: TriggerConfig;
    isEnabled: boolean;
    createdAt: string;
    updatedAt: string;
  }

  /**
   * Trigger Configuration (polymorphic)
   */
  /**
   * Schedule Trigger Config
   */
  /**
   * Entity Event Trigger Config
   */
  /**
   * Entity Event
   */
  /**
   * Webhook Trigger Config
   */
  /**
   * Manual Trigger Config
   */
  /**
   * Parameter Definition
   */
  /**
   * Validation Rule
   */
  /**
   * Action Configuration
   */
  /**
   * Condition for conditional execution
   */
  /**
   * Condition Rule
   */
  /**
   * Error Handler
   */
  /**
   * Retry Policy
   */
  /**
   * Workflow Execution
   */
  export interface Execution {
    id: string;
    workflowId: string;
    workflowName: string;
    workflowVersion: number;

    status: ExecutionStatus;

    // Trigger info
    triggeredBy: string;
    triggerType: string;
    triggerData?: any;

    // Execution timeline
    startedAt: string;
    completedAt?: string;
    duration?: number; // milliseconds

    // Steps execution
    steps: ExecutionStep[];
    currentStep?: string;

    // Results
    output?: any;
    error?: ExecutionError;

    // Metadata
    executionContext?: Record<string, any>;
    workspaceId: string;
  }

  /**
   * Execution Step Result
   */
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

  /**
   * Execution Error
   */
  /**
   * Execution Log Entry
   */
  export interface ExecutionLog {
    timestamp: string;
    level: 'debug' | 'info' | 'warning' | 'error';
    message: string;
    stepId?: string;
    metadata?: Record<string, any>;
  }

  /**
   * Trigger Type Definition
   */
  export interface TriggerType {
    id: string;
    name: string;
    description: string;
    category: TriggerCategory;
    icon?: string;

    // Configuration schema
    configSchema: ConfigSchema;

    // Supported events
    supportedEvents?: string[];

    // Metadata
    isCustom?: boolean;
    isPremium?: boolean;
    documentation?: string;
  }

  /**
   * Action Type Definition
   */
  export interface ActionType {
    id: string;
    name: string;
    description: string;
    category: ActionCategory;
    icon?: string;

    // Input/Output definitions
    inputs: ActionInput[];
    outputs: ActionOutput[];

    // Configuration
    settings?: ActionSetting[];

    // Metadata
    isCustom?: boolean;
    isPremium?: boolean;
    deprecated?: boolean;
    usageCount?: number;
    documentation?: string;
    tags?: string[];
  }

  /**
   * Action Input Definition
   */
  /**
   * Action Output Definition
   */
  /**
   * Action Setting
   */
  /**
   * Configuration Schema
   */
  /**
   * Schema Property
   */
  /**
   * Workflow Template
   */
  export interface WorkflowTemplate {
    id: string;
    name: string;
    description: string;
    category: string;

    // Template content
    workflow: Partial<Workflow>;

    // Configuration
    configurationSchema?: ConfigSchema;

    // Metadata
    difficulty?: 'beginner' | 'intermediate' | 'advanced';
    usageCount: number;
    rating?: number;
    tags?: string[];
    thumbnail?: string;

    // Author info
    authorId: string;
    authorName?: string;
    isOfficial?: boolean;

    createdAt: string;
    updatedAt: string;
  }

  /**
   * Integration Definition
   */
  export interface Integration {
    id: string;
    name: string;
    type: string;
    description?: string;

    // Connection status
    status: 'connected' | 'disconnected' | 'error' | 'authenticating';

    // Credentials (encrypted)
    credentialsId?: string;

    // OAuth info
    isOAuth?: boolean;
    oauthScopes?: string[];

    // Connection details
    connectedAt?: string;
    lastSyncAt?: string;
    lastError?: string;

    // Settings
    settings?: Record<string, any>;

    // Metadata
    icon?: string;
    website?: string;
    documentation?: string;

    createdAt: string;
    updatedAt: string;
    workspaceId: string;
  }

  /**
   * Variable Definition
   */
  export interface Variable {
    id: string;
    name: string;
    value: any;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    scope: VariableScope;

    description?: string;
    isSecret?: boolean;
    isEncrypted?: boolean;

    workflowId?: string;
    workspaceId: string;

    createdAt: string;
    updatedAt: string;
  }

  /**
   * Secret (encrypted variable)
   */
  export interface Secret {
    id: string;
    name: string;
    description?: string;

    // Value is always encrypted server-side
    lastModifiedAt: string;
    expiresAt?: string;

    workspaceId: string;
    createdAt: string;
    updatedAt: string;
  }

  /**
   * Webhook Definition
   */
  export interface Webhook {
    id: string;
    name: string;
    url: string;
    secret: string;

    // Configuration
    method: 'POST' | 'PUT' | 'PATCH';
    headers?: Record<string, string>;
    validateSignature: boolean;

    // Status
    isEnabled: boolean;

    // Statistics
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    lastCalledAt?: string;

    workspaceId: string;
    createdAt: string;
    updatedAt: string;
  }

  /**
   * Webhook Event
   */
  export interface WebhookEvent {
    id: string;
    webhookId: string;

    // Request details
    method: string;
    headers: Record<string, string>;
    body: any;
    sourceIp?: string;

    // Response
    status: 'received' | 'processing' | 'completed' | 'failed';
    responseCode?: number;
    responseBody?: any;

    // Execution
    executionId?: string;
    error?: string;

    // Timing
    receivedAt: string;
    processedAt?: string;
    duration?: number;
  }

  /**
   * Schedule Definition
   */
  export interface Schedule {
    id: string;
    workflowId: string;
    workflowName: string;

    // Schedule configuration
    cronExpression?: string;
    interval?: number;
    timezone: string;

    // Time window
    startDate?: string;
    endDate?: string;

    // Status
    isEnabled: boolean;

    // Next run
    nextRunAt?: string;
    lastRunAt?: string;

    // Statistics
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;

    createdAt: string;
    updatedAt: string;
    workspaceId: string;
  }

  /**
   * Workflow Statistics
   */
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

  /**
   * Workflow Metrics
   */
  export interface WorkflowMetrics {
    workflowId: string;

    // Execution metrics
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    successRate: number;

    // Performance metrics
    averageExecutionTime: number;
    minExecutionTime: number;
    maxExecutionTime: number;

    // Trend data
    executionsByDay: Array<{ date: string; count: number; successCount: number; failureCount: number }>;

    // Step performance
    slowestSteps: Array<{ stepId: string; stepName: string; averageDuration: number }>;

    // Error analysis
    commonErrors: Array<{ error: string; count: number }>;
  }

  /**
   * Error Log
   */
  export interface ErrorLog {
    id: string;
    workflowId: string;
    workflowName: string;
    executionId: string;

    // Error details
    errorCode: string;
    errorMessage: string;
    stackTrace?: string;
    stepId?: string;
    stepName?: string;

    // Context
    input?: any;
    context?: any;

    // Status
    isAcknowledged: boolean;
    acknowledgedBy?: string;
    acknowledgedAt?: string;

    occurredAt: string;
    workspaceId: string;
  }

  /**
   * Audit Log
   */
  export interface AuditLog {
    id: string;

    // Actor
    userId: string;
    userName?: string;

    // Action
    action: string;
    resourceType: string;
    resourceId: string;
    resourceName?: string;

    // Changes
    changes?: Record<string, { old: any; new: any }>;

    // Metadata
    ipAddress?: string;
    userAgent?: string;

    timestamp: string;
    workspaceId: string;
  }

  // ============================================================================
  // CREATE/UPDATE DTOs
  // ============================================================================

  export interface CreateWorkflowDto {
    name: string;
    description?: string;
    status?: WorkflowStatus;
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

  export interface CreateIntegrationDto {
    name: string;
    type: string;
    credentials?: any;
    settings?: Record<string, any>;
  }

  export interface UpdateIntegrationDto {
    name?: string;
    credentials?: any;
    settings?: Record<string, any>;
  }

  export interface CreateVariableDto {
    name: string;
    value: any;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    scope: VariableScope;
    description?: string;
    isSecret?: boolean;
    workflowId?: string;
  }

  export interface UpdateVariableDto {
    name?: string;
    value?: any;
    description?: string;
  }

  export interface CreateSecretDto {
    name: string;
    value: string;
    description?: string;
    expiresAt?: string;
  }

  export interface UpdateSecretDto {
    value?: string;
    description?: string;
    expiresAt?: string;
  }

  export interface CreateWebhookDto {
    name: string;
    validateSignature?: boolean;
    headers?: Record<string, string>;
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

  export interface EntityTriggerDto {
    entityType: string;
    events: EntityEvent[];
    conditions?: Condition[];
  }

  export interface ScheduleTriggerDto {
    cronExpression?: string;
    interval?: number;
    timezone?: string;
    startDate?: string;
    endDate?: string;
  }

  export interface PublishTemplateDto {
    category: string;
    difficulty?: 'beginner' | 'intermediate' | 'advanced';
    thumbnail?: string;
    isPublic?: boolean;
  }

  // ============================================================================
  // FILTER TYPES
  // ============================================================================

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

  export interface ErrorFilters {
    workflowId?: string;
    isAcknowledged?: boolean;
    startDate?: string;
    endDate?: string;
  }

  export interface AuditFilters {
    userId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    startDate?: string;
    endDate?: string;
  }

  // ============================================================================
  // RESULT TYPES
  // ============================================================================

  export interface ExecutionResult {
    success: boolean;
    output?: any;
    error?: ExecutionError;
    duration: number;
    steps: ExecutionStep[];
  }

  export interface ValidationResult {
    isValid: boolean;
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
  }

  export interface CronValidation {
    isValid: boolean;
    error?: string;
    nextRuns?: string[];
    description?: string;
  }

  export interface ConnectionTestResult {
    success: boolean;
    message: string;
    latency?: number;
    error?: string;
  }

  export interface WebhookTestResult {
    success: boolean;
    executionId?: string;
    output?: any;
    error?: string;
  }

  export interface BulkOperationResult {
    total: number;
    successful: number;
    failed: number;
    errors?: Array<{ id: string; error: string }>;
  }

  export interface WorkflowPreview {
    workflow: Workflow;
    estimatedSteps: number;
    requiredIntegrations: string[];
    requiredVariables: string[];
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

  export interface PerformanceMetrics {
    totalExecutions: number;
    averageExecutionTime: number;
    p50ExecutionTime: number;
    p95ExecutionTime: number;
    p99ExecutionTime: number;
    errorRate: number;
  }

  export interface ResourceUsageStats {
    period: 'day' | 'week' | 'month';
    totalExecutions: number;
    totalExecutionTime: number;
    peakConcurrentExecutions: number;
    averageConcurrentExecutions: number;
  }

  export interface ErrorStats {
    totalErrors: number;
    errorsByType: Record<string, number>;
    errorsByWorkflow: Array<{ workflowId: string; workflowName: string; count: number }>;
    recentErrors: ErrorLog[];
  }
}
