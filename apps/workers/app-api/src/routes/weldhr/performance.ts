/**
 * /api/weldhr/coaching, /api/weldhr/evaluation-forms, /api/weldhr/evaluations,
 * /api/weldhr/kpis, /api/weldhr/kpi-values, /api/weldhr/milestones
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrCoachingLogSchema,
  createHrEvaluationFormSchema,
  createHrEvaluationSchema,
  createHrKpiDefinitionSchema,
  createHrKpiValueSchema,
  createHrMilestoneSchema,
  importHrKpiValuesSchema,
  updateHrCoachingLogSchema,
  updateHrEvaluationFormSchema,
  updateHrEvaluationSchema,
  updateHrKpiDefinitionSchema,
  updateHrKpiValueSchema,
  updateHrMilestoneSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { noContent, success } from '../../lib/response';
import {
  createCoachingLog,
  createEvaluation,
  createEvaluationForm,
  createKpiDefinition,
  createKpiValue,
  createMilestone,
  deleteCoachingLog,
  deleteEvaluation,
  deleteEvaluationForm,
  deleteKpiDefinition,
  deleteKpiValue,
  deleteMilestone,
  importKpiValues,
  listCoachingLogs,
  listEvaluationForms,
  listEvaluations,
  listKpiDefinitions,
  listKpiValues,
  listMilestones,
  requireCoachingLog,
  requireEvaluation,
  requireKpiValue,
  requireMilestone,
  updateCoachingLog,
  updateEvaluation,
  updateEvaluationForm,
  updateKpiDefinition,
  updateKpiValue,
  updateMilestone,
} from '../../services/weldhr/performance';
import { actor, db, emit, param } from './helpers';

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (value: string | undefined) => (value && isoDate.test(value) ? value : undefined);

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

export const coachingRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

coachingRoutes.get('/', requirePermission('coaching:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listCoachingLogs(db(c), {
      employeeId: q.employeeId || undefined,
      companyId: q.companyId || undefined,
      status: q.status || undefined,
      category: q.category || undefined,
      from: dateParam(q.from),
      to: dateParam(q.to),
      followUpDue: q.followUpDue === 'true',
    }),
  );
});

coachingRoutes.get('/:coachingId', requirePermission('coaching:read'), async (c) => {
  return success(c, await requireCoachingLog(db(c), param(c, 'coachingId')));
});

coachingRoutes.post('/', requirePermission('coaching:create'), zValidator('json', createHrCoachingLogSchema), async (c) => {
  const row = await createCoachingLog(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_coaching_log', 'created', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, row, 201);
});

coachingRoutes.patch('/:coachingId', requirePermission('coaching:update'), zValidator('json', updateHrCoachingLogSchema), async (c) => {
  const row = await updateCoachingLog(db(c), param(c, 'coachingId'), c.req.valid('json'));
  emit(c, 'hr_coaching_log', 'updated', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, row);
});

coachingRoutes.delete('/:coachingId', requirePermission('coaching:delete'), async (c) => {
  const row = await requireCoachingLog(db(c), param(c, 'coachingId'));
  await deleteCoachingLog(db(c), row.id);
  emit(c, 'hr_coaching_log', 'deleted', row.id, { employeeId: row.employeeId });
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Evaluation forms (settings)
// ---------------------------------------------------------------------------

export const evaluationFormsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

evaluationFormsRoutes.get('/', requirePermission('evaluations:read'), async (c) => {
  return success(c, await listEvaluationForms(db(c), c.req.query('activeOnly') !== 'true'));
});

evaluationFormsRoutes.post('/', requirePermission('employees:manage'), zValidator('json', createHrEvaluationFormSchema), async (c) => {
  return success(c, await createEvaluationForm(db(c), c.req.valid('json')), 201);
});

evaluationFormsRoutes.patch('/:formId', requirePermission('employees:manage'), zValidator('json', updateHrEvaluationFormSchema), async (c) => {
  return success(c, await updateEvaluationForm(db(c), param(c, 'formId'), c.req.valid('json')));
});

evaluationFormsRoutes.delete('/:formId', requirePermission('employees:manage'), async (c) => {
  await deleteEvaluationForm(db(c), param(c, 'formId'));
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export const evaluationsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

evaluationsRoutes.get('/', requirePermission('evaluations:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listEvaluations(db(c), {
      employeeId: q.employeeId || undefined,
      companyId: q.companyId || undefined,
      status: q.status || undefined,
      formId: q.formId || undefined,
      from: dateParam(q.from),
      to: dateParam(q.to),
    }),
  );
});

evaluationsRoutes.get('/:evaluationId', requirePermission('evaluations:read'), async (c) => {
  return success(c, await requireEvaluation(db(c), param(c, 'evaluationId')));
});

evaluationsRoutes.post('/', requirePermission('evaluations:create'), zValidator('json', createHrEvaluationSchema), async (c) => {
  const row = await createEvaluation(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_evaluation', row.status === 'submitted' ? 'submitted' : 'created', row.id, {
    employeeId: row.employeeId,
    status: row.status,
  });
  return success(c, row, 201);
});

evaluationsRoutes.patch('/:evaluationId', requirePermission('evaluations:update'), zValidator('json', updateHrEvaluationSchema), async (c) => {
  const before = await requireEvaluation(db(c), param(c, 'evaluationId'));
  const row = await updateEvaluation(db(c), before.id, c.req.valid('json'));
  const justSubmitted = before.status === 'draft' && row.status === 'submitted';
  emit(c, 'hr_evaluation', justSubmitted ? 'submitted' : 'updated', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, row);
});

evaluationsRoutes.delete('/:evaluationId', requirePermission('evaluations:delete'), async (c) => {
  const row = await requireEvaluation(db(c), param(c, 'evaluationId'));
  await deleteEvaluation(db(c), row.id);
  emit(c, 'hr_evaluation', 'deleted', row.id, { employeeId: row.employeeId });
  return noContent(c);
});

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export const kpisRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

kpisRoutes.get('/', requirePermission('evaluations:read'), async (c) => {
  return success(
    c,
    await listKpiDefinitions(db(c), {
      companyId: c.req.query('companyId') || undefined,
      includeInactive: c.req.query('includeInactive') === 'true',
    }),
  );
});

kpisRoutes.post('/', requirePermission('employees:manage'), zValidator('json', createHrKpiDefinitionSchema), async (c) => {
  return success(c, await createKpiDefinition(db(c), c.req.valid('json')), 201);
});

kpisRoutes.patch('/:kpiId', requirePermission('employees:manage'), zValidator('json', updateHrKpiDefinitionSchema), async (c) => {
  return success(c, await updateKpiDefinition(db(c), param(c, 'kpiId'), c.req.valid('json')));
});

kpisRoutes.delete('/:kpiId', requirePermission('employees:manage'), async (c) => {
  return success(c, await deleteKpiDefinition(db(c), param(c, 'kpiId')));
});

export const kpiValuesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

kpiValuesRoutes.get('/', requirePermission('evaluations:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listKpiValues(db(c), {
      employeeId: q.employeeId || undefined,
      kpiId: q.kpiId || undefined,
      companyId: q.companyId || undefined,
      from: dateParam(q.from),
      to: dateParam(q.to),
    }),
  );
});

kpiValuesRoutes.post('/', requirePermission('evaluations:create'), zValidator('json', createHrKpiValueSchema), async (c) => {
  const row = await createKpiValue(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_kpi_value', 'created', row.id, { employeeId: row.employeeId, companyId: row.companyId });
  return success(c, row, 201);
});

kpiValuesRoutes.post('/import', requirePermission('evaluations:create'), zValidator('json', importHrKpiValuesSchema), async (c) => {
  return success(c, await importKpiValues(db(c), c.req.valid('json'), actor(c)));
});

kpiValuesRoutes.patch('/:kpiValueId', requirePermission('evaluations:update'), zValidator('json', updateHrKpiValueSchema), async (c) => {
  const row = await updateKpiValue(db(c), param(c, 'kpiValueId'), c.req.valid('json'));
  emit(c, 'hr_kpi_value', 'updated', row.id, { employeeId: row.employeeId, companyId: row.companyId });
  return success(c, row);
});

kpiValuesRoutes.delete('/:kpiValueId', requirePermission('evaluations:delete'), async (c) => {
  const row = await requireKpiValue(db(c), param(c, 'kpiValueId'));
  await deleteKpiValue(db(c), row.id);
  emit(c, 'hr_kpi_value', 'deleted', row.id, { employeeId: row.employeeId });
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export const milestonesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

milestonesRoutes.get('/', requirePermission('evaluations:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listMilestones(db(c), {
      employeeId: q.employeeId || undefined,
      companyId: q.companyId || undefined,
      status: q.status || undefined,
    }),
  );
});

milestonesRoutes.post('/', requirePermission('evaluations:create'), zValidator('json', createHrMilestoneSchema), async (c) => {
  const row = await createMilestone(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_milestone', row.status === 'achieved' ? 'achieved' : 'created', row.id, {
    employeeId: row.employeeId,
    status: row.status,
  });
  return success(c, row, 201);
});

milestonesRoutes.patch('/:milestoneId', requirePermission('evaluations:update'), zValidator('json', updateHrMilestoneSchema), async (c) => {
  const { milestone, justAchieved } = await updateMilestone(db(c), param(c, 'milestoneId'), c.req.valid('json'));
  emit(c, 'hr_milestone', justAchieved ? 'achieved' : 'updated', milestone.id, {
    employeeId: milestone.employeeId,
    status: milestone.status,
  });
  return success(c, milestone);
});

milestonesRoutes.delete('/:milestoneId', requirePermission('evaluations:delete'), async (c) => {
  const row = await requireMilestone(db(c), param(c, 'milestoneId'));
  await deleteMilestone(db(c), row.id);
  emit(c, 'hr_milestone', 'deleted', row.id, { employeeId: row.employeeId });
  return noContent(c);
});
