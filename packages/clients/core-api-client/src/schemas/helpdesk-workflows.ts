import { z } from 'zod';

// `/api/helpdesk-workflows` — backed by `helpdesk_workflows`. CRUD only;
// trigger/execute actions stay in api-worker until the workflow binding
// lands in app-api.

export const createHelpdeskWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  trigger: z.string().max(50).optional(),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskWorkflowSchema = createHelpdeskWorkflowSchema.partial();

export type CreateHelpdeskWorkflowInput = z.infer<typeof createHelpdeskWorkflowSchema>;
export type UpdateHelpdeskWorkflowInput = z.infer<typeof updateHelpdeskWorkflowSchema>;

/** A `helpdesk_workflows` row, as the list, GET /:id and POST /:id/duplicate return it. */
export const helpdeskWorkflowSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    version: z.number(),
    triggers: z.array(z.unknown()).nullable(),
    steps: z.array(z.unknown()).nullable(),
    settings: z.record(z.unknown()).nullable(),
    createdBy: z.string().nullable(),
    folderId: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    executionCount: z.number().nullable(),
    successCount: z.number().nullable(),
    failureCount: z.number().nullable(),
    /** `numeric(10, 2)`: a string. */
    averageExecutionTime: z.string().nullable(),
    lastExecutedAt: z.string().nullable(),
    sortOrder: z.number(),
    templateId: z.string().nullable(),
  })
  .passthrough();

/** GET /api/helpdesk-workflows/stats. The execution counters are always 0. */
export const helpdeskWorkflowStatsSchema = z.object({
  totalWorkflows: z.number(),
  activeWorkflows: z.number(),
  draftWorkflows: z.number(),
  pausedWorkflows: z.number(),
  totalExecutions: z.number(),
  successfulExecutions: z.number(),
  failedExecutions: z.number(),
  pendingExecutions: z.number(),
});

/** A row of GET /api/helpdesk-workflows/for-chaining. */
export const helpdeskWorkflowChainTargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

/** PATCH /api/helpdesk-workflows/:id/status. */
export const helpdeskWorkflowStatusResultSchema = z.object({
  id: z.string(),
  status: z.enum(['draft', 'active', 'paused', 'archived']),
});

/**
 * POST /api/helpdesk-workflows/seed-defaults: `{ seeded, templateIds }` (201),
 * or `{ seeded: 0, message }` when every default exists.
 */
export const helpdeskWorkflowSeedResultSchema = z.union([
  z.object({ seeded: z.number(), templateIds: z.array(z.string()) }).strict(),
  z.object({ seeded: z.literal(0), message: z.string() }).strict(),
]);

/** POST /api/helpdesk-workflows/reset-defaults. */
export const helpdeskWorkflowResetResultSchema = z.object({
  deleted: z.number(),
  created: z.number(),
  templateIds: z.array(z.string()),
});

/** POST /api/helpdesk-workflows/executions/:executionId/resume. */
export const helpdeskWorkflowResumeResultSchema = z.object({
  resumed: z.literal(true),
  executionId: z.string(),
  forwarded: z.boolean(),
});
