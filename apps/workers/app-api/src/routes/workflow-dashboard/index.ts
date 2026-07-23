/**
 * Workflow dashboard routes — /api/workflow-dashboard/*
 *
 * Dashboard / analytics / search endpoints, plus the static action / trigger
 * / entity-event catalogs the visual editor's pickers render.
 *
 * Permissions: tasks:read for queries, tasks:update for acknowledge.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import { ACTION_TYPES, TRIGGER_TYPES, ENTITY_EVENTS } from './static-catalogs';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/stats', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { workflows, workflowExecutions, workflowSchedules, workflowWebhooks } = schema;

    const [workflowCounts, executions, scheduleCount, webhookCount] = await Promise.all([
      db
        .select({ status: workflows.status, count: sql<number>`count(*)::int` })
        .from(workflows)
        .where(isNull(workflows.deletedAt))
        .groupBy(workflows.status),
      db.select().from(workflowExecutions),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowSchedules)
        .where(and(eq(workflowSchedules.isEnabled, true), isNull(workflowSchedules.deletedAt))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowWebhooks)
        .where(and(eq(workflowWebhooks.isEnabled, true), isNull(workflowWebhooks.deletedAt))),
    ]);

    const stats = {
      workflows: { total: 0, active: 0, draft: 0, paused: 0, archived: 0 },
      executions: {
        total: executions.length,
        running: executions.filter((e) => e.status === 'running').length,
        completed: executions.filter((e) => e.status === 'completed').length,
        failed: executions.filter((e) => e.status === 'failed').length,
        queued: executions.filter((e) => e.status === 'queued').length,
      },
      triggers: {
        schedules: scheduleCount[0]?.count ?? 0,
        webhooks: webhookCount[0]?.count ?? 0,
      },
    };
    for (const row of workflowCounts) {
      stats.workflows.total += row.count;
      if (row.status === 'active') stats.workflows.active = row.count;
      else if (row.status === 'draft') stats.workflows.draft = row.count;
      else if (row.status === 'paused') stats.workflows.paused = row.count;
      else if (row.status === 'archived') stats.workflows.archived = row.count;
    }
    return success(c, stats);
  } catch (err) {
    console.error('[app-api/workflow-dashboard] stats failed:', err);
    return error.internal(c, 'Failed to fetch dashboard stats');
  }
});

app.get(
  '/search',
  requirePermission('tasks:read'),
  zValidator('query', z.object({ q: z.string().optional(), limit: z.coerce.number().max(50).default(15) })),
  async (c) => {
    const db = c.get('tenantDb');
    const { q: query, limit } = c.req.valid('query');
    try {
      const { workflows, workflowTemplates, workflowExecutions } = schema;
      type SearchResult = { id: string; title: string; description?: string; href: string; type: string };
      const results: SearchResult[] = [];

      if (!query || query.length < 2) {
        const recent = await db
          .select()
          .from(workflows)
          .where(isNull(workflows.deletedAt))
          .orderBy(desc(workflows.updatedAt))
          .limit(5);
        for (const w of recent) {
          results.push({
            id: w.id,
            title: w.name,
            description: w.status || 'Workflow',
            href: `/weldconnect/workflows/${w.id}`,
            type: 'workflow',
          });
        }
        return success(c, results);
      }

      const term = `%${query}%`;
      const [wfRows, tplRows, execRows] = await Promise.all([
        db
          .select()
          .from(workflows)
          .where(and(isNull(workflows.deletedAt), or(like(workflows.name, term), like(workflows.description, term))))
          .limit(5),
        db
          .select()
          .from(workflowTemplates)
          .where(
            and(isNull(workflowTemplates.deletedAt), or(like(workflowTemplates.name, term), like(workflowTemplates.description, term))),
          )
          .limit(5),
        db
          .select({ execution: workflowExecutions, workflowName: workflows.name })
          .from(workflowExecutions)
          .leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
          .where(like(workflows.name, term))
          .orderBy(desc(workflowExecutions.startedAt))
          .limit(5),
      ]);

      for (const w of wfRows) {
        results.push({
          id: w.id,
          title: w.name,
          description: w.status || 'Workflow',
          href: `/weldconnect/workflows/${w.id}`,
          type: 'workflow',
        });
      }
      for (const t of tplRows) {
        results.push({
          id: t.id,
          title: t.name,
          description: t.category || 'Template',
          href: `/weldconnect/templates/${t.id}`,
          type: 'template',
        });
      }
      for (const r of execRows) {
        results.push({
          id: r.execution.id,
          title: r.workflowName || 'Execution',
          description: r.execution.status || 'Execution',
          href: `/weldconnect/executions/${r.execution.id}`,
          type: 'execution',
        });
      }
      return success(c, results.slice(0, limit));
    } catch (err) {
      console.error('[app-api/workflow-dashboard] search failed:', err);
      return error.internal(c, 'Failed to search');
    }
  },
);

app.get(
  '/performance',
  requirePermission('tasks:read'),
  zValidator('query', z.object({ workflowId: z.string().optional() })),
  async (c) => {
    const db = c.get('tenantDb');
    const { workflowId } = c.req.valid('query');
    try {
      const { workflowExecutions } = schema;
      const rows = workflowId
        ? await db.select().from(workflowExecutions).where(eq(workflowExecutions.workflowId, workflowId))
        : await db.select().from(workflowExecutions);

      const completed = rows.filter((e) => e.status === 'completed' && e.duration);
      const durations = completed.map((e) => e.duration ?? 0);
      const avg = completed.length ? durations.reduce((s, n) => s + n, 0) / completed.length : 0;

      return success(c, {
        totalExecutions: rows.length,
        completedExecutions: completed.length,
        averageDuration: avg,
        minDuration: durations.length ? Math.min(...durations) : 0,
        maxDuration: durations.length ? Math.max(...durations) : 0,
      });
    } catch (err) {
      console.error('[app-api/workflow-dashboard] performance failed:', err);
      return error.internal(c, 'Failed to fetch performance metrics');
    }
  },
);

app.get(
  '/errors',
  requirePermission('tasks:read'),
  zValidator(
    'query',
    z.object({
      workflowId: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(100).default(20),
      isAcknowledged: z.coerce.boolean().optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const { workflowId, page, limit, isAcknowledged } = c.req.valid('query');
    try {
      const { workflowErrorLogs } = schema;
      const conditions: any[] = [];
      if (workflowId) conditions.push(eq(workflowErrorLogs.workflowId, workflowId));
      if (isAcknowledged === false) conditions.push(isNull(workflowErrorLogs.acknowledgedAt));

      const errors = conditions.length
        ? await db.select().from(workflowErrorLogs).where(and(...conditions)).orderBy(desc(workflowErrorLogs.createdAt))
        : await db.select().from(workflowErrorLogs).orderBy(desc(workflowErrorLogs.createdAt));

      const byType: Record<string, number> = {};
      for (const e of errors) {
        const t = e.errorType || 'unknown';
        byType[t] = (byType[t] || 0) + 1;
      }

      const start = (page - 1) * limit;
      return success(c, {
        total: errors.length,
        unacknowledged: errors.filter((e) => !e.acknowledgedAt).length,
        byType,
        items: errors.slice(start, start + limit),
        page,
        limit,
      });
    } catch (err) {
      console.error('[app-api/workflow-dashboard] errors failed:', err);
      return error.internal(c, 'Failed to fetch error stats');
    }
  },
);

app.patch('/errors/:id/acknowledge', requirePermission('tasks:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const { workflowErrorLogs } = schema;
    await db
      .update(workflowErrorLogs)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: userId, isAcknowledged: true })
      .where(eq(workflowErrorLogs.id, id));
    const [row] = await db.select().from(workflowErrorLogs).where(eq(workflowErrorLogs.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Error log', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/workflow-dashboard] acknowledge failed:', err);
    return error.internal(c, 'Failed to acknowledge error');
  }
});

app.get('/resource-usage', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { workflows, workflowExecutions, workflowSchedules, workflowWebhooks } = schema;
    const [wfStats, exStats, schedStats, whStats] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where status = 'active')::int`,
        })
        .from(workflows)
        .where(isNull(workflows.deletedAt)),
      db
        .select({
          total: sql<number>`count(*)::int`,
          running: sql<number>`count(*) filter (where status = 'running')::int`,
          completed: sql<number>`count(*) filter (where status = 'completed')::int`,
          failed: sql<number>`count(*) filter (where status = 'failed')::int`,
        })
        .from(workflowExecutions),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowSchedules)
        .where(and(eq(workflowSchedules.isEnabled, true), isNull(workflowSchedules.deletedAt))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowWebhooks)
        .where(and(eq(workflowWebhooks.isEnabled, true), isNull(workflowWebhooks.deletedAt))),
    ]);
    return success(c, {
      workflows: { total: wfStats[0]?.total ?? 0, active: wfStats[0]?.active ?? 0 },
      executions: {
        total: exStats[0]?.total ?? 0,
        running: exStats[0]?.running ?? 0,
        completed: exStats[0]?.completed ?? 0,
        failed: exStats[0]?.failed ?? 0,
      },
      triggers: { schedules: schedStats[0]?.count ?? 0, webhooks: whStats[0]?.count ?? 0 },
    });
  } catch (err) {
    console.error('[app-api/workflow-dashboard] resource-usage failed:', err);
    return error.internal(c, 'Failed to fetch resource usage');
  }
});

app.get(
  '/action-types',
  requirePermission('tasks:read'),
  zValidator('query', z.object({ category: z.string().optional(), search: z.string().optional() })),
  async (c) => {
    const { category, search } = c.req.valid('query');
    let filtered = ACTION_TYPES;
    if (category) filtered = filtered.filter((a) => a.category === category);
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter((a) => a.name.toLowerCase().includes(s) || a.description.toLowerCase().includes(s));
    }
    return success(c, filtered);
  },
);

app.get(
  '/trigger-types',
  requirePermission('tasks:read'),
  zValidator('query', z.object({ category: z.string().optional(), search: z.string().optional() })),
  async (c) => {
    const { category, search } = c.req.valid('query');
    let filtered = TRIGGER_TYPES;
    if (category) filtered = filtered.filter((t) => t.category === category);
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter((t) => t.name.toLowerCase().includes(s) || t.description.toLowerCase().includes(s));
    }
    return success(c, filtered);
  },
);

app.get('/entity-events', requirePermission('tasks:read'), (c) => success(c, ENTITY_EVENTS));

export const workflowDashboardRoutes = app;
