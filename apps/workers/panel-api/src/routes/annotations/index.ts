/**
 * Chart annotations: /api/panel/annotations/*.
 *
 *   GET    /       → ?projectId&from&to(&reportId): the project-wide ones, plus that report's
 *   POST   /       → new annotation (project-wide, or on a report the caller may see)
 *   GET    /:id    → one annotation
 *   PATCH  /:id    → date, label, description, report
 *   DELETE /:id    → soft delete
 *
 * Reading needs `panel_reports:read`; one on a report the caller may not see
 * is a 404. Changing or deleting is for its author, or for
 * `panel_projects:manage`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelAnnotationSchema,
  panelAnnotationListQuerySchema,
  updatePanelAnnotationSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelAnnotation } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { canChange, canSee, getReport, projectExists, type Actor } from '../../services/saved-objects';
import {
  annotationEventData,
  createAnnotation,
  deleteAnnotation,
  getAnnotation,
  listAnnotations,
  toAnnotationDto,
  updateAnnotation,
} from '../../services/annotations';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function actorOf(c: Ctx): Promise<Actor> {
  return { userId: c.get('userId'), canManage: await hasContextPermission(c, 'panel_projects:manage') };
}

function publish(c: Ctx, annotation: PanelAnnotation, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_annotation', entityId: annotation.id, action, data: annotationEventData(annotation) });
}

/** Whether `reportId` is a report of `projectId` the caller may see. */
async function reportVisible(c: Ctx, reportId: string, projectId: string): Promise<boolean> {
  const report = await getReport(c.get('tenantDb'), reportId);
  return !!report && report.projectId === projectId && canSee(report, await actorOf(c));
}

/** The annotation when the caller may see it, or the answer to send instead. */
async function visible(c: Ctx): Promise<PanelAnnotation | Response> {
  const id = c.req.param('id') ?? '';
  const annotation = await getAnnotation(c.get('tenantDb'), id);
  if (!annotation) return error.notFound(c, 'Annotation', id);
  if (annotation.reportId && !(await reportVisible(c, annotation.reportId, annotation.projectId))) return error.notFound(c, 'Annotation', id);
  return annotation;
}

/** The annotation when the caller may change it, or the answer to send instead. */
async function editable(c: Ctx): Promise<PanelAnnotation | Response> {
  const found = await visible(c);
  if (found instanceof Response) return found;
  if (!canChange({ ownerUserId: found.createdByUserId, visibility: 'workspace' }, await actorOf(c))) {
    return error.forbidden(c, 'Only the author can change this annotation');
  }
  return found;
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', panelAnnotationListQuerySchema), async (c) => {
  const query = c.req.valid('query');
  if (query.reportId && !(await reportVisible(c, query.reportId, query.projectId))) return error.notFound(c, 'Report', query.reportId);
  const annotations = await listAnnotations(c.get('tenantDb'), query);
  return list(c, annotations.map(toAnnotationDto), cursorPagination(annotations.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelAnnotationSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  if (input.reportId && !(await reportVisible(c, input.reportId, input.projectId))) return error.notFound(c, 'Report', input.reportId);

  const annotation = await createAnnotation(db, input, userId);
  publish(c, annotation, 'created');
  return success(c, toAnnotationDto(annotation), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const found = await visible(c);
  if (found instanceof Response) return found;
  return success(c, toAnnotationDto(found));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelAnnotationSchema), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const input = c.req.valid('json');
  if (input.reportId && !(await reportVisible(c, input.reportId, found.projectId))) return error.notFound(c, 'Report', input.reportId);

  const annotation = await updateAnnotation(c.get('tenantDb'), found.id, input);
  if (!annotation) return error.notFound(c, 'Annotation', found.id);
  publish(c, annotation, 'updated');
  return success(c, toAnnotationDto(annotation));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const found = await editable(c);
  if (found instanceof Response) return found;
  const annotation = await deleteAnnotation(c.get('tenantDb'), found.id);
  if (!annotation) return error.notFound(c, 'Annotation', found.id);
  publish(c, annotation, 'deleted');
  return noContent(c);
});

export default app;
