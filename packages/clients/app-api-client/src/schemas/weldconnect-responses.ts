/**
 * Response shapes of connect-api's WeldConnect workflow routes, matching what
 * the routes answer (rows as Drizzle reads them: ISO timestamps, `numeric`
 * as text). Used by the conformance harness to check both backends' answers
 * (`packages/core/worker-kit/src/testing/conformance-schemas-connect.ts`).
 */

import { z } from 'zod';

const timestamp = z.string();
const nullableTimestamp = z.string().nullable();

export const weldconnectIdSchema = z.object({ id: z.string() });

export const workflowRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    version: z.number(),
    triggers: z.unknown(),
    steps: z.unknown(),
    settings: z.unknown(),
    tags: z.array(z.string()).nullable(),
    folderId: z.string().nullable(),
    createdBy: z.string().nullable(),
    executionCount: z.number().nullable(),
    successCount: z.number().nullable(),
    failureCount: z.number().nullable(),
    averageExecutionTime: z.string().nullable(),
    lastExecutedAt: nullableTimestamp,
    templateId: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: nullableTimestamp,
  })
  .passthrough();

const statusCounts = z.object({
  total: z.number(),
  active: z.number(),
  draft: z.number(),
  paused: z.number(),
  archived: z.number(),
});

const runCounts = z.object({
  total: z.number(),
  running: z.number(),
  completed: z.number(),
  failed: z.number(),
  queued: z.number(),
});

export const workflowStatsSchema = z.object({
  totalWorkflows: z.number(),
  activeWorkflows: z.number(),
  draftWorkflows: z.number(),
  pausedWorkflows: z.number(),
  totalExecutions: z.number(),
  successfulExecutions: z.number(),
  failedExecutions: z.number(),
  pendingExecutions: z.number(),
  workflows: statusCounts,
  executions: runCounts,
});

export const workflowChainingItemSchema = z.object({ id: z.string(), name: z.string(), status: z.string() });

export const workflowExecutionRowSchema = z
  .object({
    id: z.string(),
    workflowId: z.string(),
    workflowVersion: z.number(),
    workflowName: z.string().nullable(),
    status: z.string(),
    triggeredBy: z.string().nullable(),
    triggerType: z.string().nullable(),
    triggerId: z.string().nullable(),
    triggerData: z.unknown(),
    startedAt: nullableTimestamp,
    completedAt: nullableTimestamp,
    duration: z.number().nullable(),
    output: z.unknown(),
    error: z.unknown(),
    executionContext: z.unknown(),
    retryCount: z.number().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

export const workflowMetricsSchema = z.object({
  totalExecutions: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  averageExecutionTime: z.number(),
  recentExecutions: z.array(workflowExecutionRowSchema),
});

export const workflowTestRunSchema = z.object({
  executionId: z.string(),
  instanceId: z.string(),
  triggerType: z.string(),
  isTest: z.literal(true),
});

export const workflowManualRunSchema = z.object({ executionId: z.string(), instanceId: z.string() });

export const workflowStatusChangeSchema = z.object({ id: z.string(), status: z.string() });

export const workflowExecutionStepRowSchema = z
  .object({
    id: z.string(),
    executionId: z.string(),
    stepId: z.string(),
    stepName: z.string().nullable(),
    stepType: z.string().nullable(),
    stepIndex: z.number(),
    status: z.string(),
    createdAt: timestamp,
  })
  .passthrough();

export const workflowExecutionLogSchema = z
  .object({ stepId: z.string(), stepName: z.string().optional() })
  .passthrough();

export const workflowExecutionTrendsSchema = z.object({
  trends: z.array(z.object({ date: z.string(), total: z.number(), success: z.number(), failure: z.number() })),
});

export const workflowApprovalDecisionSchema = z.object({
  stepId: z.string(),
  approved: z.boolean(),
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().nullable(),
  decidedBy: z.string(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string(),
});

export const workflowRetrySchema = z.object({
  id: z.string(),
  executionId: z.string(),
  instanceId: z.string().optional(),
  retryOf: z.string(),
  skipped: z.literal(true).optional(),
});

export const workflowScheduleRowSchema = z
  .object({
    id: z.string(),
    workflowId: z.string(),
    triggerId: z.string().nullable(),
    name: z.string().nullable(),
    scheduleType: z.string(),
    cronExpression: z.string().nullable(),
    timezone: z.string(),
    isEnabled: z.boolean(),
    nextRunAt: nullableTimestamp,
    lastRunAt: nullableTimestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

export const workflowScheduleToggleSchema = z.object({ id: z.string(), isEnabled: z.boolean() });

const setupIssue = z
  .object({ code: z.string(), stepId: z.string().optional(), triggerId: z.string().optional() })
  .passthrough();

export const workflowTemplateItemSchema = z.object({
  id: z.string(),
  source: z.enum(['builtin', 'workspace']),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  icon: z.string().nullable(),
  triggers: z.array(z.unknown()),
  steps: z.array(z.unknown()),
  requiredIntegrations: z.array(z.string()),
  setupIssues: z.array(setupIssue),
  usageCount: z.number(),
  authorId: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const weldconnectCategoryCountSchema = z.object({ id: z.string(), name: z.string(), count: z.number() });

export const workflowTemplateFromWorkflowSchema = z.object({ id: z.string(), name: z.string() });

export const workflowFromTemplateSchema = z.object({ id: z.string(), templateId: z.string(), name: z.string() });

export const workflowVariableRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    value: z.unknown(),
    isSecret: z.boolean(),
    scope: z.string(),
    workflowId: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

export const workflowVariableViewSchema = z.object({
  name: z.string(),
  type: z.string(),
  isSecret: z.boolean(),
  scope: z.string(),
});

export const workflowVersionListItemSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  version: z.number(),
  name: z.string(),
  status: z.string(),
  createdBy: z.string().nullable(),
  createdAt: timestamp,
  reason: z.string().nullable(),
  restoredFromVersion: z.number().nullable(),
  note: z.string().nullable(),
});

export const workflowVersionRowSchema = workflowVersionListItemSchema
  .extend({ triggers: z.unknown(), steps: z.unknown(), settings: z.unknown() })
  .passthrough();

export const workflowVersionRestoredSchema = z.object({
  workflowId: z.string(),
  version: z.number(),
  restoredFromVersion: z.number(),
});

export const workflowWebhookRowSchema = z
  .object({
    id: z.string(),
    workflowId: z.string(),
    triggerId: z.string().nullable(),
    name: z.string(),
    url: z.string(),
    isEnabled: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

export const workflowWebhookViewSchema = workflowWebhookRowSchema
  .extend({
    externalUrl: z.string(),
    hasSecret: z.boolean(),
    workflowName: z.string().nullable(),
    workflowStatus: z.string().nullable(),
    isManaged: z.boolean(),
  })
  .passthrough();

export const workflowWebhookSummarySchema = z
  .object({
    id: z.string(),
    url: z.string(),
    externalUrl: z.string(),
    hasSecret: z.boolean(),
    validateSignature: z.boolean().nullable(),
    isEnabled: z.boolean(),
  })
  .nullable();

export const workflowWebhookEventSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  timestamp: nullableTimestamp,
  status: z.string(),
  error: z.string().nullable(),
  sourceIp: z.string().optional(),
});

export const workflowTriggerRowSchema = z
  .object({
    id: z.string(),
    workflowId: z.string(),
    name: z.string(),
    category: z.string(),
    config: z.record(z.unknown()),
    isEnabled: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

export const workflowTriggerWithWorkflowSchema = workflowTriggerRowSchema.extend({ workflowName: z.string().nullable() });

export const workflowWebhookTriggerCreatedSchema = workflowTriggerRowSchema.extend({
  webhookId: z.string(),
  webhookUrl: z.string(),
  secret: z.string(),
});

const usageTriggers = z.object({ schedules: z.number(), webhooks: z.number() });

export const workflowDashboardStatsSchema = z.object({
  workflows: statusCounts,
  executions: runCounts,
  triggers: usageTriggers,
});

export const workflowResourceUsageSchema = z.object({
  workflows: z.object({ total: z.number(), active: z.number() }),
  executions: z.object({ total: z.number(), running: z.number(), completed: z.number(), failed: z.number() }),
  triggers: usageTriggers,
});

export const workflowSearchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  href: z.string(),
  type: z.string(),
});

export const workflowPerformanceSchema = z.object({
  totalExecutions: z.number(),
  completedExecutions: z.number(),
  averageDuration: z.number(),
  minDuration: z.number(),
  maxDuration: z.number(),
});

export const workflowErrorLogRowSchema = z
  .object({
    id: z.string(),
    workflowId: z.string().nullable(),
    executionId: z.string().nullable(),
    errorMessage: z.string(),
    isAcknowledged: z.boolean(),
    acknowledgedAt: nullableTimestamp,
    occurredAt: timestamp,
  })
  .passthrough();

export const workflowErrorLogsSchema = z.object({
  total: z.number(),
  unacknowledged: z.number(),
  byType: z.record(z.number()),
  byWorkflow: z.array(z.object({ workflowId: z.string().nullable(), workflowName: z.string().nullable(), count: z.number() })),
  items: z.array(workflowErrorLogRowSchema.extend({ workflowName: z.string().nullable() })),
  page: z.number(),
  limit: z.number(),
});

export const workflowErrorsAcknowledgedSchema = z.object({ acknowledged: z.number() });

export const workflowPickerItemSchema = z
  .object({ id: z.string(), name: z.string(), description: z.string(), category: z.string() })
  .passthrough();

export const workflowEntityEventEntrySchema = z
  .object({ entityType: z.string(), events: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) })
  .passthrough();

const builderNode = z.object({ id: z.string().optional(), kind: z.string() }).passthrough();

export const workflowBuilderDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  trigger: builderNode.nullable(),
  steps: z.array(builderNode),
  finalized: z.boolean(),
});

/** The public webhook receiver's legacy answer (no `{ data }` envelope). */
export const workflowWebhookReceivedSchema = z.object({
  success: z.literal(true),
  executionId: z.string(),
  skipped: z.literal(true).optional(),
});

// ── /api/workflow-integrations ───────────────────────────────────────────────

export const workflowIntegrationDefSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    label: z.string(),
    description: z.string(),
    category: z.string(),
    icon: z.string(),
    auth: z.object({ kind: z.enum(['oauth2', 'api_key', 'app_installation']) }).passthrough(),
    actions: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
    triggers: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
  })
  .passthrough();

export const workflowIntegrationRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    status: z.string(),
    category: z.string().nullable(),
    settings: z.unknown(),
    hasCredentials: z.boolean(),
    hasOauthTokens: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

export const workflowIntegrationStatusSchema = z.object({ id: z.string(), status: z.string() });

export const workflowIntegrationTestSchema = z.object({ success: z.boolean(), message: z.string() });

export const workflowSlackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
  isMember: z.boolean(),
});

export const workflowGithubRepoSchema = z.object({
  id: z.number(),
  fullName: z.string(),
  defaultBranch: z.string().nullable(),
  private: z.boolean(),
});

export const workflowGoogleSpreadsheetSchema = z.object({
  spreadsheetId: z.string(),
  title: z.string(),
  url: z.string(),
  sheets: z.array(z.object({ sheetId: z.number(), title: z.string() })),
});

export const workflowGoogleCalendarSchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean(),
  accessRole: z.string(),
});

export const workflowIntegrationAuthorizeSchema = z.object({ authorizeUrl: z.string(), state: z.string() });

export const workflowIntegrationConnectedSchema = z.object({
  id: z.string().optional(),
  status: z.enum(['connected', 'needs_install']),
  provider: z.string(),
});

// ── WeldFlow's GitHub App (/api/workflow-github, /api/github-*) ─────────────

const syncDirection = z.enum(['inbound', 'outbound', 'bidirectional']);

export const githubInstallUrlSchema = z.object({ url: z.string() });

/** `formatConnection(row)`: the row without its webhook secret. */
export const githubConnectionSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    installationId: z.number(),
    appSlug: z.string(),
    ownerType: z.enum(['user', 'org']),
    ownerLogin: z.string(),
    status: z.enum(['active', 'suspended', 'revoked']),
    scopes: z.array(z.string()).nullable(),
    createdBy: z.string().nullable(),
    installedAt: nullableTimestamp,
    revokedAt: nullableTimestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .extend({ deletedAt: nullableTimestamp })
  .strict();

export const githubDiscoverableInstallationSchema = z.object({
  id: z.number(),
  accountLogin: z.string(),
  accountType: z.enum(['User', 'Organization']),
  appSlug: z.string(),
  repositorySelection: z.string(),
});

export const githubAvailableRepoSchema = z.object({
  id: z.number(),
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
});

/** `serializeRepoLink(row)`. */
export const githubRepoLinkSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    connectionId: z.string(),
    projectId: z.string().nullable(),
    repoId: z.number(),
    repoFullName: z.string(),
    defaultBranch: z.string().nullable(),
    syncIssues: z.boolean(),
    syncDirection,
    lastSyncedAt: nullableTimestamp,
    syncCursor: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const githubAvailableProjectSchema = z.object({
  nodeId: z.string(),
  number: z.number(),
  title: z.string(),
  ownerType: z.enum(['user', 'org']),
  ownerLogin: z.string(),
  url: z.string(),
  shortDescription: z.string().nullable(),
  closed: z.boolean(),
});

export const githubStatusFieldsSchema = z.object({
  fieldId: z.string().nullable(),
  fieldName: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** `serializeProjectLink(row)`. */
export const githubProjectLinkSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    connectionId: z.string(),
    projectId: z.string(),
    projectV2NodeId: z.string(),
    projectV2Number: z.number(),
    projectTitle: z.string().nullable(),
    ownerType: z.enum(['user', 'org']),
    ownerLogin: z.string(),
    repoId: z.number().nullable(),
    repoFullName: z.string().nullable(),
    statusFieldId: z.string().nullable(),
    statusOptionMap: z.array(
      z.object({ githubOptionId: z.string(), githubOptionName: z.string(), stageId: z.string().nullable() }),
    ),
    syncIssues: z.boolean(),
    syncDirection,
    lastSyncedAt: nullableTimestamp,
    lastError: z.string().nullable(),
    syncCursor: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const githubSyncRunSchema = z.object({ runId: z.string() });

/** The generic `/api/github-connections` rows: Drizzle's, without `webhookSecret`. */
export const githubConnectionRowSchema = githubConnectionSchema;

/** The generic `/api/github-repo-links` rows, as Drizzle reads them. */
export const githubRepoLinkRowSchema = githubRepoLinkSchema.extend({ deletedAt: nullableTimestamp }).strict();
