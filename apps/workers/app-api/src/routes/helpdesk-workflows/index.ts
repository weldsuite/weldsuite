/**
 * Workflow routes — flat /api/helpdesk-workflows/* surface backed by `helpdeskWorkflows`.
 *
 * Permissions: tickets:read | tickets:create | tickets:update | tickets:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createHelpdeskWorkflowSchema, updateHelpdeskWorkflowSchema } from '@weldsuite/core-api-client/schemas/helpdesk-workflows';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

/** Local Env extension until HELPDESK_WORKFLOW_WORKER_URL lands in src/types.ts (integration step). */
type EnvWithWorkflowWorker = Env & { HELPDESK_WORKFLOW_WORKER_URL?: string };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskWorkflows;

app.get('/', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.search) {
    conditions.push(like(t.name, `%${q.search}%`));
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] list failed:', err);
    return error.internal(c, 'Failed to list workflows');
  }
});

/**
 * GET /stats — workflow statistics (counts by status).
 * Ported from api-worker routes/helpdesk/workflows.ts GET /stats.
 * Execution counters are returned as 0, matching the legacy implementation.
 * Registered before GET /:id so the literal segment wins.
 */
app.get('/stats', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const workflowCounts = await db
      .select({ status: t.status, count: sql<number>`count(*)::int` })
      .from(t)
      .where(isNull(t.deletedAt))
      .groupBy(t.status);

    const stats: Record<string, number> = {
      totalWorkflows: 0,
      activeWorkflows: 0,
      draftWorkflows: 0,
      pausedWorkflows: 0,
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      pendingExecutions: 0,
    };

    for (const row of workflowCounts) {
      stats.totalWorkflows += row.count;
      if (row.status === 'active') stats.activeWorkflows = row.count;
      if (row.status === 'draft') stats.draftWorkflows = row.count;
      if (row.status === 'paused') stats.pausedWorkflows = row.count;
    }

    return success(c, stats);
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] stats failed:', err);
    return error.internal(c, 'Failed to fetch workflow stats');
  }
});

/**
 * GET /for-chaining — workflows available as chain targets (excludes the
 * requesting workflow via ?exclude= and any archived workflows).
 * Ported from api-worker routes/helpdesk/workflows.ts GET /for-chaining.
 */
app.get('/for-chaining', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const excludeId = c.req.query('exclude');
  try {
    const results = await db
      .select({ id: t.id, name: t.name, status: t.status })
      .from(t)
      .where(isNull(t.deletedAt));

    const filtered = results.filter((w) => w.id !== excludeId && w.status !== 'archived');
    return success(c, filtered);
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] for-chaining failed:', err);
    return error.internal(c, 'Failed to fetch workflows');
  }
});

app.get('/:id', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Workflow', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow');
  }
});

app.post('/', requirePermission('tickets:create'), zValidator('json', createHelpdeskWorkflowSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('hwfl');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'helpdesk_workflow', entityId: id, action: 'created', data: { id, name: (data as Record<string, unknown>).name } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] create failed:', err);
    return error.internal(c, 'Failed to create workflow');
  }
});

app.patch('/:id', requirePermission('tickets:update'), zValidator('json', updateHelpdeskWorkflowSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Workflow', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({ c, entityType: 'helpdesk_workflow', entityId: id, action: 'updated', data: { id, name: (update.name as string | undefined) ?? existing.name } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] update failed:', err);
    return error.internal(c, 'Failed to update workflow');
  }
});

/**
 * PATCH /:id/status — flip workflow status only.
 * Ported from api-worker routes/helpdesk/workflows.ts PATCH /:id/status.
 */
app.patch(
  '/:id/status',
  requirePermission('tickets:update'),
  zValidator('json', z.object({ status: z.enum(['draft', 'active', 'paused', 'archived']) })),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { status } = c.req.valid('json');
    try {
      const [existing] = await db.select({ id: t.id }).from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
      if (!existing) return error.notFound(c, 'Workflow', id);

      await db
        .update(t)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(t.id, id), isNull(t.deletedAt)));

      publishEntityEvent({ c, entityType: 'helpdesk_workflow', entityId: id, action: 'updated', data: { id, status } });
      return success(c, { id, status });
    } catch (err) {
      console.error('[app-api/helpdesk-workflows] status update failed:', err);
      return error.internal(c, 'Failed to update workflow status');
    }
  },
);

/**
 * POST /:id/duplicate — copy a workflow (new id, status reset to draft).
 * Ported from api-worker routes/helpdesk/workflows.ts POST /:id/duplicate.
 */
app.post(
  '/:id/duplicate',
  requirePermission('tickets:create'),
  zValidator('json', z.object({ name: z.string().optional() })),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const { name } = c.req.valid('json');
    try {
      const [original] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
      if (!original) return error.notFound(c, 'Workflow', id);

      const newId = generateId('hwfl');
      const now = new Date();
      await db.insert(t).values({
        id: newId,
        name: name || `${original.name} (Copy)`,
        description: original.description,
        status: 'draft',
        triggers: original.triggers,
        steps: original.steps,
        settings: original.settings,
        tags: original.tags,
        folderId: original.folderId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });

      const [workflow] = await db.select().from(t).where(eq(t.id, newId)).limit(1);

      publishEntityEvent({
        c,
        entityType: 'helpdesk_workflow',
        entityId: newId,
        action: 'created',
        data: { id: newId, name: name || `${original.name} (Copy)` },
      });

      return success(c, workflow, 201);
    } catch (err) {
      console.error('[app-api/helpdesk-workflows] duplicate failed:', err);
      return error.internal(c, 'Failed to duplicate workflow');
    }
  },
);

app.delete('/:id', requirePermission('tickets:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Workflow', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'helpdesk_workflow', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow');
  }
});

// ============================================================================
// Default Workflows — Seed & Reset
// (ported from api-worker routes/helpdesk/workflows.ts)
// ============================================================================

/** Stable template IDs for default workflows (must match trigger task definitions). */
const DEFAULT_WORKFLOW_TEMPLATE_IDS = [
  'hwf_tpl_collect_info',
  'hwf_tpl_welcome',
  'hwf_tpl_auto_assign',
  'hwf_tpl_csat_resolved',
] as const;

/**
 * POST /seed-defaults — seed default workflows that don't exist yet.
 */
app.post('/seed-defaults', requirePermission('tickets:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const existing = await db
      .select({ templateId: t.templateId })
      .from(t)
      .where(inArray(t.templateId, [...DEFAULT_WORKFLOW_TEMPLATE_IDS]));

    const existingIds = new Set(existing.map((w) => w.templateId));
    const missingIds = DEFAULT_WORKFLOW_TEMPLATE_IDS.filter((id) => !existingIds.has(id));

    if (missingIds.length === 0) {
      return success(c, { seeded: 0, message: 'All default workflows already exist' });
    }

    const now = new Date();
    const defaults = getDefaultWorkflowDefinitions(now);
    const toInsert = defaults.filter((wf) => (missingIds as readonly string[]).includes(wf.templateId));

    if (toInsert.length > 0) {
      await db.insert(t).values(toInsert as unknown as (typeof t.$inferInsert)[]);
      for (const wf of toInsert) {
        publishEntityEvent({ c, entityType: 'helpdesk_workflow', entityId: wf.id, action: 'created', data: { id: wf.id, name: wf.name, templateId: wf.templateId } });
      }
    }

    return success(c, { seeded: toInsert.length, templateIds: toInsert.map((w) => w.templateId) }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] seed-defaults failed:', err);
    return error.internal(c, 'Failed to seed default workflows');
  }
});

/**
 * POST /reset-defaults — hard-delete template-derived workflows and re-create them.
 */
app.post('/reset-defaults', requirePermission('tickets:update'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const deleted = await db
      .delete(t)
      .where(inArray(t.templateId, [...DEFAULT_WORKFLOW_TEMPLATE_IDS]))
      .returning({ id: t.id });

    const now = new Date();
    const defaults = getDefaultWorkflowDefinitions(now);
    await db.insert(t).values(defaults as unknown as (typeof t.$inferInsert)[]);

    for (const row of deleted) {
      publishEntityEvent({ c, entityType: 'helpdesk_workflow', entityId: row.id, action: 'deleted', data: { id: row.id } });
    }
    for (const wf of defaults) {
      publishEntityEvent({ c, entityType: 'helpdesk_workflow', entityId: wf.id, action: 'created', data: { id: wf.id, name: wf.name, templateId: wf.templateId } });
    }

    return success(c, {
      deleted: deleted.length,
      created: defaults.length,
      templateIds: defaults.map((w) => w.templateId),
    });
  } catch (err) {
    console.error('[app-api/helpdesk-workflows] reset-defaults failed:', err);
    return error.internal(c, 'Failed to reset default workflows');
  }
});

/**
 * Generate default workflow records for seeding via the API.
 * Kept byte-compatible with the api-worker originals (template IDs, triggers,
 * steps) so the helpdesk-workflow-worker trigger matching keeps working.
 */
function getDefaultWorkflowDefinitions(now: Date) {
  return [
    {
      id: generateId('hwfl'),
      name: 'Collect Customer Info',
      description: 'Asks unidentified visitors for their name and email before routing the conversation.',
      status: 'active',
      version: 1,
      sortOrder: 5,
      templateId: 'hwf_tpl_collect_info',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [{
        id: 'trg_collect_info', type: 'entity_event', name: 'New conversation from visitor', isEnabled: true,
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'created', channels: ['chat'] },
      }],
      steps: [
        { id: 'step_collect', type: 'collect_customer_info', name: 'Collect customer data', order: 1, config: {}, inputs: { message: "Hi there! Before we connect you with our team, could you share your details so we can assist you better?", fields: [{ id: 'name', label: 'Name', type: 'text', required: false, placeholder: 'Your name' }, { id: 'email', label: 'Email', type: 'email', required: true, placeholder: 'your@email.com' }] } },
        { id: 'step_confirm', type: 'send_message', name: 'Confirmation', order: 2, config: {}, inputs: { message: "Thanks! Let me connect you with our team now." } },
      ],
      settings: { logLevel: 'info' },
      createdAt: now, updatedAt: now,
    },
    {
      id: generateId('hwfl'),
      name: 'Welcome Message',
      description: 'Sends a friendly greeting when a new conversation starts. Enable this instead of "Collect Customer Info" if you don\'t need to collect visitor emails.',
      status: 'draft',
      version: 1,
      sortOrder: 10,
      templateId: 'hwf_tpl_welcome',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [{
        id: 'trg_welcome', type: 'entity_event', name: 'New conversation created', isEnabled: true,
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'created', channels: ['chat'] },
      }],
      steps: [
        { id: 'step_greet', type: 'send_message', name: 'Send welcome message', order: 1, config: {}, inputs: { message: "Welcome! We typically respond within a few minutes during business hours (Mon-Fri, 9AM-5PM). How can we help you today?" } },
      ],
      settings: { logLevel: 'info' },
      createdAt: now, updatedAt: now,
    },
    {
      id: generateId('hwfl'),
      name: 'Auto-Assign Round Robin',
      description: 'Automatically assigns new conversations to available agents in round-robin order.',
      status: 'draft',
      version: 1,
      sortOrder: 20,
      templateId: 'hwf_tpl_auto_assign',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [{
        id: 'trg_auto_assign', type: 'entity_event', name: 'New conversation created', isEnabled: true,
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'created' },
      }],
      steps: [
        { id: 'step_assign', type: 'assign_conversation', name: 'Round-robin assignment', order: 1, config: {}, inputs: { strategy: 'round_robin' } },
        { id: 'step_notify', type: 'send_notification', name: 'Notify assigned agent', order: 2, config: {}, inputs: { title: 'New conversation assigned', body: 'A new conversation has been assigned to you.' } },
      ],
      settings: { logLevel: 'info' },
      createdAt: now, updatedAt: now,
    },
    {
      id: generateId('hwfl'),
      name: 'CSAT After Resolution',
      description: 'Sends a customer satisfaction survey after a conversation is resolved.',
      status: 'draft',
      version: 1,
      sortOrder: 30,
      templateId: 'hwf_tpl_csat_resolved',
      createdBy: 'system',
      tags: ['system-default'],
      triggers: [{
        id: 'trg_csat_resolved', type: 'entity_event', name: 'Conversation resolved', isEnabled: true,
        config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'status_changed', filters: [{ field: 'status', operator: 'equals', value: 'resolved' }] },
      }],
      steps: [
        { id: 'step_delay', type: 'delay', name: 'Wait before sending survey', order: 1, config: {}, inputs: { minutes: 60 } },
        { id: 'step_send_csat', type: 'trigger_csat', name: 'Send CSAT survey', order: 2, config: {}, inputs: { delayMinutes: 0 } },
      ],
      settings: { logLevel: 'info' },
      createdAt: now, updatedAt: now,
    },
  ];
}

// ============================================================================
// Workflow Execution — Resume Interactive Steps
// ============================================================================

const resumeSchema = z.object({
  stepId: z.string(),
  response: z.record(z.unknown()),
});

/**
 * POST /executions/:executionId/resume — resume a paused workflow execution.
 *
 * Ported from api-worker routes/helpdesk/workflows.ts. PORT DECISION: the
 * api-worker original forwarded to `${HELPDESK_WORKFLOW_WORKER_URL}/internal/resume`,
 * an endpoint that does NOT exist on helpdesk-workflow-worker — so in
 * production the forward always failed (swallowed) and only the local DB flip
 * happened, leaving the CF Workflow instance stuck at waitForEvent().
 *
 * This port targets the worker's real `/respond` endpoint
 * (apps/workers/helpdesk-workflow-worker/src/index.ts:125). `/respond` looks the
 * execution up by conversationId + status='waiting_for_input' and delivers a
 * `customer_response` event to the CF Workflow instance, which then owns all
 * execution-state writes. Consequently:
 *   - the forward happens BEFORE any DB mutation (a premature status flip
 *     would make the worker's waiting_for_input lookup 404);
 *   - when the forward succeeds we do NOT touch the execution row (the CF
 *     Workflow persists status/context itself on resume);
 *   - when no worker URL is configured or the forward fails, we fall back to
 *     the legacy DB flip (status -> running, response stored in stepOutputs)
 *     so the response is at least recorded, matching old behavior.
 */
app.post(
  '/executions/:executionId/resume',
  requirePermission('tickets:update'),
  zValidator('json', resumeSchema),
  async (c) => {
    const executionId = c.req.param('executionId');
    const { stepId, response } = c.req.valid('json');
    const db = c.get('tenantDb');
    const exec = schema.helpdeskWorkflowExecutions;

    try {
      const [execution] = await db.select().from(exec).where(eq(exec.id, executionId)).limit(1);
      if (!execution) return error.notFound(c, 'Execution', executionId);

      if (execution.status !== 'waiting_for_input') {
        return error.badRequest(c, `Execution is not waiting for input (status: ${execution.status})`);
      }

      // --- Forward to helpdesk-workflow-worker /respond (real resume path) ---
      const workerUrl = (c.env as EnvWithWorkflowWorker).HELPDESK_WORKFLOW_WORKER_URL;
      const orgId = c.get('orgId');
      let forwarded = false;
      if (workerUrl && orgId && execution.conversationId) {
        try {
          const r = response as Record<string, unknown>;
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (c.env.INTERNAL_API_SECRET) headers['Authorization'] = `Bearer ${c.env.INTERNAL_API_SECRET}`;
          const fwdRes = await fetch(`${workerUrl}/respond`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              conversationId: execution.conversationId,
              workspaceId: orgId,
              executionId,
              stepId,
              selectedValue: r.selectedValue,
              selectedLabel: r.selectedLabel,
              submittedData: r.submittedData,
              rating: r.rating,
              feedback: r.feedback,
            }),
          });
          if (!fwdRes.ok) throw new Error(`Forward failed: ${fwdRes.status}`);
          forwarded = true;
        } catch (fwdErr) {
          console.error('[app-api/helpdesk-workflows] resume forward to workflow worker failed:', fwdErr);
        }
      }

      if (!forwarded) {
        // Legacy fallback: record the response and flip the execution to
        // running locally so it is not stuck in waiting_for_input forever.
        type ExecutionContext = NonNullable<typeof execution.executionContext>;
        const rawContext: ExecutionContext = execution.executionContext || {};
        const context: ExecutionContext = {
          ...rawContext,
          variables: rawContext.variables ?? {},
          stepOutputs: { ...(rawContext.stepOutputs ?? {}), [stepId]: response },
        };
        delete context.waitingForInput;

        await db
          .update(exec)
          .set({
            status: 'running',
            executionContext: context,
            currentStepIndex: (execution.currentStepIndex || 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(exec.id, executionId));
      }

      return success(c, { resumed: true, executionId, forwarded });
    } catch (err) {
      console.error('[app-api/helpdesk-workflows] resume failed:', err);
      return error.internal(c, 'Failed to resume execution');
    }
  },
);

export const helpdeskWorkflowsRoutes = app;
