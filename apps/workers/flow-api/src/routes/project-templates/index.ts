/**
 * Project templates: /api/project-templates/*, backed by `project_templates`
 * (design: weldflow-delivery-and-portfolio.md, "Create from a template";
 * ADR FLOW-021; slice F).
 *
 *   GET    /                         the templates this person may use (shared, or their own)
 *   GET    /:id                      one template with its blueprint
 *   POST   /                         a template from a blueprint in the body
 *   PATCH  /:id                      edit
 *   DELETE /:id                      soft delete
 *   POST   /from-project/:projectId  "Save as template": a blueprint built from a project
 *   POST   /:id/instantiate          "Create project": the whole project in one batch
 *
 * Permissions: creating, editing, sharing and deleting a template takes
 * `project_templates:manage`; using a shared template (list, read, create a
 * project) takes `projects:create`, or the manage key. The checks run in a
 * fixed order so every backend answers alike: permission, then the template
 * (404), then project access (403), then the body (400), then the rules.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { schema } from '@weldsuite/worker-kit/db';
import {
  blueprintSchema,
  createTemplateSchema,
  instantiateTemplateSchema,
  templateFromProjectSchema,
  updateTemplateSchema,
  type InstantiateResult,
} from '@weldsuite/app-api-client/schemas/project-closing';
import {
  TEMPLATE_MESSAGES,
  blueprintIntegrityError,
  buildBlueprint,
  instantiateRolesError,
  neededTaskNumbers,
  planInstantiation,
  readBlueprint,
  resolveCopy,
} from '@weldsuite/flow-domain/project-templates';
import { TASK_SEQUENCE, allocateNumbers } from '@weldsuite/flow-domain/task-numbering';
import type { Env, Variables } from '../../types';
import { canAccessProject } from '../../lib/project-access';
import { containsPattern, parseLimit, queryBoolean } from '../../lib/query-params';
import { PROJECT_DENIED, parseBody, readQuery, type AppContext } from '../../lib/closing-input';
import { findLiveProject } from '../../services/project-closing';
import {
  findVisibleTemplate,
  loadBlueprintSource,
  publishPlannedEvents,
  planStatements,
  presentTemplate,
  presentTemplateDetail,
  templateEventData,
  usageCounts,
  type TemplateRow,
} from '../../services/project-templates';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectTemplates;

const TEMPLATE_LABEL = 'Template';

const listQuerySchema = z.object({
  search: z.string().optional(),
  shared: queryBoolean.optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

type TemplateAction = 'created' | 'updated' | 'deleted';

function publishTemplate(c: AppContext, action: TemplateAction, row: TemplateRow) {
  publishEntityEvent({ c, entityType: 'project_template', entityId: row.id, action, data: templateEventData(row) });
}

/** The template with its blueprint and use count, as the detail routes answer it. */
async function detailOf(c: AppContext, row: TemplateRow) {
  const usage = await usageCounts(c.get('tenantDb'), [row.id]);
  return presentTemplateDetail(row, usage.get(row.id) ?? 0);
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:create', 'project_templates:manage'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const query = readQuery(c, listQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 50, 100);

  // A shared template, or the caller's own.
  const conditions: SQL[] = [isNull(t.deletedAt), or(eq(t.shared, true), eq(t.createdBy, userId)) as SQL];
  if (q.shared !== undefined) conditions.push(eq(t.shared, q.shared));
  if (q.search) conditions.push(or(ilike(t.name, containsPattern(q.search)), ilike(t.description, containsPattern(q.search))) as SQL);
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`);
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const usage = await usageCounts(db, data.map((row) => row.id));
    return list(
      c,
      data.map((row) => presentTemplate(row, usage.get(row.id) ?? 0)),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-templates] list failed:', err);
    return error.internal(c, 'Failed to list templates');
  }
});

// ── Save as template ────────────────────────────────────────────────────────

// MUST be before /:id routes that share its verb.
app.post('/from-project/:projectId', requirePermission('project_templates:manage'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  const project = await findLiveProject(db, projectId);
  if (!project) return error.notFound(c, 'Project', projectId);
  if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
  const body = await parseBody(c, templateFromProjectSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  try {
    const blueprint = buildBlueprint(await loadBlueprintSource(db, project), input.roleLabels);
    // What the builder made has to be something the schema and the rules accept, or it could never be used.
    if (!blueprintSchema.safeParse(blueprint).success || blueprintIntegrityError(blueprint)) {
      return error.badRequest(c, TEMPLATE_MESSAGES.cannotSave);
    }

    const now = new Date();
    const id = generateId('tpl');
    await db.insert(t).values({
      id,
      name: input.name,
      description: input.description ?? null,
      blueprint,
      sourceProjectId: projectId,
      shared: input.shared ?? false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.internal(c, 'Failed to save the template');
    publishTemplate(c, 'created', row);
    const detail = await detailOf(c, row);
    if (!detail) return error.internal(c, 'Failed to save the template');
    return success(c, detail, 201);
  } catch (err) {
    console.error('[flow-api/project-templates] save failed:', err);
    return error.internal(c, 'Failed to save the template');
  }
});

app.get('/:id', requirePermission('projects:create', 'project_templates:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findVisibleTemplate(db, id, c.get('userId'));
    if (!row) return error.notFound(c, TEMPLATE_LABEL, id);
    const detail = await detailOf(c, row);
    if (!detail) return error.conflict(c, TEMPLATE_MESSAGES.invalidBlueprint);
    return success(c, detail);
  } catch (err) {
    console.error('[flow-api/project-templates] get failed:', err);
    return error.internal(c, 'Failed to fetch template');
  }
});

// ── Create, edit, delete ────────────────────────────────────────────────────

app.post('/', requirePermission('project_templates:manage'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createTemplateSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  const broken = blueprintIntegrityError(input.blueprint);
  if (broken) return error.badRequest(c, broken);

  try {
    const now = new Date();
    const id = generateId('tpl');
    await db.insert(t).values({
      id,
      name: input.name,
      description: input.description ?? null,
      blueprint: input.blueprint,
      sourceProjectId: null,
      shared: input.shared ?? false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.internal(c, 'Failed to create template');
    publishTemplate(c, 'created', row);
    const detail = await detailOf(c, row);
    if (!detail) return error.internal(c, 'Failed to create template');
    return success(c, detail, 201);
  } catch (err) {
    console.error('[flow-api/project-templates] create failed:', err);
    return error.internal(c, 'Failed to create template');
  }
});

app.patch('/:id', requirePermission('project_templates:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findVisibleTemplate(db, id, c.get('userId'));
  if (!existing) return error.notFound(c, TEMPLATE_LABEL, id);
  const body = await parseBody(c, updateTemplateSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (input.blueprint) {
    const broken = blueprintIntegrityError(input.blueprint);
    if (broken) return error.badRequest(c, broken);
  }

  try {
    const set: Partial<typeof t.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description ?? null;
    if (input.blueprint !== undefined) set.blueprint = input.blueprint;
    if (input.shared !== undefined) set.shared = input.shared;
    await db.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt)));
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, TEMPLATE_LABEL, id);
    publishTemplate(c, 'updated', row);
    const detail = await detailOf(c, row);
    if (!detail) return error.conflict(c, TEMPLATE_MESSAGES.invalidBlueprint);
    return success(c, detail);
  } catch (err) {
    console.error('[flow-api/project-templates] update failed:', err);
    return error.internal(c, 'Failed to update template');
  }
});

app.delete('/:id', requirePermission('project_templates:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findVisibleTemplate(db, id, c.get('userId'));
    if (!existing) return error.notFound(c, TEMPLATE_LABEL, id);
    const now = new Date();
    await db.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishTemplate(c, 'deleted', existing);
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-templates] delete failed:', err);
    return error.internal(c, 'Failed to delete template');
  }
});

// ── Create project from a template ──────────────────────────────────────────

app.post('/:id/instantiate', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const template = await findVisibleTemplate(db, id, userId);
  if (!template) return error.notFound(c, TEMPLATE_LABEL, id);
  const body = await parseBody(c, instantiateTemplateSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const read = readBlueprint(template.blueprint);
  if (!read.ok) return error.conflict(c, read.message);
  const blueprint = read.blueprint;
  const roles = input.roles ?? {};
  const roleError = instantiateRolesError(blueprint, roles);
  if (roleError) return error.badRequest(c, roleError);

  try {
    const now = new Date();
    const copy = resolveCopy(input.copy);
    // The only counter every project shares: its numbers are allocated up front, in one step.
    const taskNumbers = await allocateNumbers(db, TASK_SEQUENCE, neededTaskNumbers(blueprint, copy));
    const plan = planInstantiation(blueprint, {
      projectId: generateId('prj'),
      userId,
      now,
      name: input.name,
      start: new Date(`${input.startDate}T00:00:00.000Z`),
      clientId: input.clientId ?? null,
      roles,
      copy,
      templateId: template.id,
      newId: generateId,
      taskNumbers,
    });
    await atomically(db, (handle) => planStatements(handle, plan));

    // A project made with a report schedule is drafted from the next tick on, like one whose
    // schedule was set through PUT /api/project-status-reports/settings/:projectId.
    if (plan.project.settings?.statusReport && c.env.SCHEDULE_INDEX) {
      c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'status_report_due', c.get('clerkOrgId'), now));
    }

    await publishPlannedEvents(c, plan);
    publishEntityEvent({
      c,
      entityType: 'project_template',
      entityId: template.id,
      action: 'instantiated',
      data: { ...templateEventData(template), projectId: plan.projectId },
    });

    const result: InstantiateResult = {
      project: {
        id: plan.projectId,
        name: input.name,
        startDate: (plan.project.startDate as Date).toISOString(),
        endDate: plan.endDate.toISOString(),
        projectManagerId: plan.project.projectManagerId ?? null,
      },
      counts: plan.counts,
    };
    return success(c, result, 201);
  } catch (err) {
    console.error('[flow-api/project-templates] instantiate failed:', err);
    return error.internal(c, 'Failed to create the project');
  }
});

export const projectTemplatesRoutes = app;
