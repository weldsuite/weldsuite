/**
 * /api/project-finance: project figures, weekly snapshots and cost lines by
 * source (design: weldflow-delivery-and-portfolio.md "Finance and earned
 * value"; ADR FLOW-019).
 *
 *   GET /:projectId            budget, actual, committed, PV, EV, CPI, SPI, forecast, variance, per-deliverable rows
 *   GET /:projectId/costs      cost lines by source, newest first, cursor paginated
 *   GET /:projectId/snapshots  the weekly points of the S-curve
 *   GET /settings/:projectId   the manual forecast and its history
 *   PUT /settings/:projectId   set or clear the manual forecast (merge write of the `finance` settings key)
 *
 * Permissions: projects:read (projects:update for the PUT) plus the project
 * membership boundary (FLOW-001). Amounts need `projects:finance` or managing
 * the project; everyone else gets the percentages. The cost lines are all
 * amounts, so they need the same right. Check order: permission, project (404),
 * access (403), rights (403), body or query (400).
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import {
  costsQuerySchema,
  manualForecastBodySchema,
} from '@weldsuite/app-api-client/schemas/project-finance';
import type { ProjectFinanceSettings } from '@weldsuite/db/schema/project-settings';
import { isoWeekKey, roundMoney } from '@weldsuite/flow-domain/finance';
import type { Env, Variables } from '../../types';
import { markFinanceSnapshotDue } from '../../cron/finance-snapshot';
import { canAccessProject, canManageProject } from '../../lib/project-access';
import { parseLimit } from '../../lib/query-params';
import { projectAnalyticsPayload } from '../../lib/weldflow-analytics-payload';
import {
  computeFinance,
  financeSettingsOf,
  listCostLines,
  listSnapshots,
  presentFinance,
  presentFinanceSettings,
  presentSnapshot,
  projectCurrency,
  type ProjectRow,
} from '../../services/project-finance';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const projects = schema.projects;

const PROJECT_DENIED = 'You are not a member of this project';
const AMOUNTS_DENIED = 'You do not have access to the amounts of this project';
const MANAGE_DENIED = 'Only a project manager can change the forecast';
/** The history keeps this many changes. */
const HISTORY_LIMIT = 25;

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The live project, or null. */
async function findProject(c: AppContext, id: string): Promise<ProjectRow | null> {
  const [row] = await c
    .get('tenantDb')
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Amounts are for project managers and holders of `projects:finance`. */
async function mayDecideAmounts(c: AppContext, projectId: string): Promise<boolean> {
  return (await hasContextPermission(c, 'projects:finance')) || (await canManageProject(c, projectId));
}

function badRequest(c: AppContext, message: string, issues: z.ZodIssue[]): Response {
  return error.badRequest(
    c,
    message,
    issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

// ── Settings (before /:projectId) ───────────────────────────────────────────

app.get('/settings/:projectId', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await findProject(c, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, presentFinanceSettings(project, await mayDecideAmounts(c, projectId)));
  } catch (err) {
    console.error('[flow-api/project-finance] settings read failed:', err);
    return error.internal(c, 'Failed to load the finance settings');
  }
});

app.put('/settings/:projectId', requirePermission('projects:update'), async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await findProject(c, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    if (!(await canManageProject(c, projectId))) return error.forbidden(c, MANAGE_DENIED);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return error.badRequest(c, 'Invalid JSON body');
    }
    const parsed = manualForecastBodySchema.safeParse(raw);
    if (!parsed.success) return badRequest(c, 'Invalid request body', parsed.error.issues);

    const now = new Date();
    const current = financeSettingsOf(project);
    const entry = {
      amount: parsed.data.forecast === null ? null : roundMoney(parsed.data.forecast),
      reason: parsed.data.reason ? parsed.data.reason : null,
      setBy: c.get('userId') as string,
      setAt: now.toISOString(),
    };
    const finance: ProjectFinanceSettings = {
      manualForecast: entry.amount === null ? null : entry,
      history: [entry, ...current.history].slice(0, HISTORY_LIMIT),
    };
    // A merge: only the `finance` key is written, the other settings keys stay.
    const settings = sql`coalesce(${projects.settings}, '{}'::jsonb) || jsonb_build_object('finance', ${JSON.stringify(finance)}::jsonb)`;
    await c
      .get('tenantDb')
      .update(projects)
      .set({ settings, updatedAt: now })
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'project',
      entityId: projectId,
      action: 'updated',
      data: projectAnalyticsPayload({
        ...(project as Record<string, unknown>),
        settings: { ...(project.settings ?? {}), finance },
        id: projectId,
      }),
    });
    return success(c, presentFinanceSettings({ settings: { finance } }, true));
  } catch (err) {
    console.error('[flow-api/project-finance] settings write failed:', err);
    return error.internal(c, 'Failed to save the forecast');
  }
});

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/:projectId', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await findProject(c, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    const visible = await mayDecideAmounts(c, projectId);
    const now = new Date();
    const model = await computeFinance(c.get('tenantDb'), project, now);
    // A baselined project with no snapshot yet this week brings the weekly sweep to this workspace.
    if (model.baseline && c.env.SCHEDULE_INDEX) {
      const [have] = await c
        .get('tenantDb')
        .select({ week: schema.projectFinanceSnapshots.week })
        .from(schema.projectFinanceSnapshots)
        .where(and(eq(schema.projectFinanceSnapshots.projectId, projectId), eq(schema.projectFinanceSnapshots.week, isoWeekKey(now.getTime()))))
        .limit(1);
      if (!have) markFinanceSnapshotDue(c);
    }
    return success(c, presentFinance(project, model, now, visible));
  } catch (err) {
    console.error('[flow-api/project-finance] figures failed:', err);
    return error.internal(c, 'Failed to load the project finance');
  }
});

app.get('/:projectId/costs', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await findProject(c, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    if (!(await mayDecideAmounts(c, projectId))) return error.forbidden(c, AMOUNTS_DENIED);

    const rawQuery = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
    const parsed = costsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) return badRequest(c, 'Invalid query parameters', parsed.error.issues);
    const q = parsed.data;

    const page = await listCostLines(c.get('tenantDb'), projectId, projectCurrency(project), {
      source: q.source,
      from: q.from,
      to: q.to,
      cursor: q.cursor,
      limit: parseLimit(q.limit, 25, 100),
    });
    return list(c, page.lines, cursorPagination(page.total, page.hasMore, page.cursor));
  } catch (err) {
    console.error('[flow-api/project-finance] costs failed:', err);
    return error.internal(c, 'Failed to list the project costs');
  }
});

app.get('/:projectId/snapshots', requirePermission('projects:read'), async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const project = await findProject(c, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    const visible = await mayDecideAmounts(c, projectId);
    const rows = (await listSnapshots(c.get('tenantDb'), projectId)).map((row) => presentSnapshot(row, visible));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[flow-api/project-finance] snapshots failed:', err);
    return error.internal(c, 'Failed to load the finance snapshots');
  }
});

export const projectFinanceRoutes = app;
