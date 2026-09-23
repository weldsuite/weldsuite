/**
 * /api/weldhr/checklist-templates and /api/weldhr/checklists
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrChecklistTaskSchema,
  createHrChecklistTemplateSchema,
  startHrChecklistSchema,
  updateHrChecklistTaskSchema,
  updateHrChecklistTemplateSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { noContent, success } from '../../lib/response';
import {
  addTask,
  cancelChecklist,
  createTemplate,
  deleteChecklist,
  deleteTask,
  deleteTemplate,
  listChecklists,
  listTemplates,
  requireChecklist,
  requireTask,
  startChecklist,
  updateTask,
  updateTemplate,
  type ChecklistOutcome,
} from '../../services/weldhr/lifecycle';
import { actor, db, emit, param, type HrContext } from './helpers';

export const checklistTemplatesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

checklistTemplatesRoutes.get('/', requirePermission('employees:read'), async (c) => {
  return success(c, await listTemplates(db(c), c.req.query('kind') || undefined));
});

checklistTemplatesRoutes.post('/', requirePermission('employees:manage'), zValidator('json', createHrChecklistTemplateSchema), async (c) => {
  return success(c, await createTemplate(db(c), c.req.valid('json')), 201);
});

checklistTemplatesRoutes.patch('/:templateId', requirePermission('employees:manage'), zValidator('json', updateHrChecklistTemplateSchema), async (c) => {
  return success(c, await updateTemplate(db(c), param(c, 'templateId'), c.req.valid('json')));
});

checklistTemplatesRoutes.delete('/:templateId', requirePermission('employees:manage'), async (c) => {
  await deleteTemplate(db(c), param(c, 'templateId'));
  return noContent(c);
});

export const checklistsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Publish the knock-on events of a task change (checklist done, employee on/offboarded). */
function emitOutcome(c: HrContext, checklistId: string, outcome: ChecklistOutcome) {
  if (!outcome.checklistCompleted) return;
  emit(c, 'hr_checklist', 'completed', checklistId, { employeeId: outcome.employeeId, status: 'completed' });
  if (outcome.employeeStatus === 'active') {
    emit(c, 'hr_employee', 'onboarded', outcome.employeeId, { status: 'active' });
  } else if (outcome.employeeStatus === 'terminated') {
    emit(c, 'hr_employee', 'offboarded', outcome.employeeId, { status: 'terminated' });
  }
}

checklistsRoutes.get('/', requirePermission('employees:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listChecklists(db(c), {
      employeeId: q.employeeId || undefined,
      status: q.status || undefined,
      kind: q.kind || undefined,
    }),
  );
});

/** Start a template on an employee: `POST /checklists { employeeId, templateId }`. */
checklistsRoutes.post(
  '/',
  requirePermission('employees:update'),
  zValidator('json', startHrChecklistSchema.extend({ employeeId: z.string().min(1).max(30) })),
  async (c) => {
    const { employeeId, ...input } = c.req.valid('json');
    const checklist = await startChecklist(db(c), employeeId, input, actor(c));
    emit(c, 'hr_checklist', 'created', checklist.id, { employeeId, status: checklist.status });
    return success(c, checklist, 201);
  },
);

checklistsRoutes.post('/:checklistId/cancel', requirePermission('employees:update'), async (c) => {
  const checklist = await cancelChecklist(db(c), param(c, 'checklistId'));
  emit(c, 'hr_checklist', 'updated', checklist.id, { employeeId: checklist.employeeId, status: checklist.status });
  return success(c, checklist);
});

checklistsRoutes.delete('/:checklistId', requirePermission('employees:update'), async (c) => {
  const checklist = await requireChecklist(db(c), param(c, 'checklistId'));
  await deleteChecklist(db(c), checklist.id);
  emit(c, 'hr_checklist', 'deleted', checklist.id, { employeeId: checklist.employeeId });
  return noContent(c);
});

checklistsRoutes.post('/:checklistId/tasks', requirePermission('employees:update'), zValidator('json', createHrChecklistTaskSchema), async (c) => {
  const checklistId = param(c, 'checklistId');
  const task = await addTask(db(c), checklistId, c.req.valid('json'));
  emit(c, 'hr_checklist', 'updated', checklistId, { employeeId: task.employeeId });
  return success(c, task, 201);
});

checklistsRoutes.patch('/tasks/:taskId', requirePermission('employees:update'), zValidator('json', updateHrChecklistTaskSchema), async (c) => {
  const { task, outcome } = await updateTask(db(c), param(c, 'taskId'), c.req.valid('json'), actor(c));
  emit(c, 'hr_checklist', 'updated', task.checklistId, { employeeId: task.employeeId });
  emitOutcome(c, task.checklistId, outcome);
  return success(c, { task, outcome });
});

checklistsRoutes.delete('/tasks/:taskId', requirePermission('employees:update'), async (c) => {
  const task = await requireTask(db(c), param(c, 'taskId'));
  const outcome = await deleteTask(db(c), task.id);
  emit(c, 'hr_checklist', 'updated', task.checklistId, { employeeId: task.employeeId });
  emitOutcome(c, task.checklistId, outcome);
  return noContent(c);
});
