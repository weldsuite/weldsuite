/**
 * /api/weldhr/absences — sick reports, for the back office.
 *
 * Employees report themselves sick and recovered under /api/weldhr/me/absences;
 * these routes are for HR and managers, who see everyone's reports and can
 * file, correct, close and remove them on an employee's behalf.
 *
 * The `hr_absence` events carry the report id and nothing else. Every
 * workspace member can subscribe to the topic, and an employee id next to it
 * would tell all of them who is ill.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrAbsenceSchema,
  recoverHrAbsenceSchema,
  updateHrAbsenceSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createAbsence,
  deleteAbsence,
  listAbsences,
  recoverAbsence,
  requireAbsence,
  updateAbsence,
} from '../../services/weldhr/absences';
import { actor, db, emit, param } from './helpers';

export const absencesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

absencesRoutes.get('/', requirePermission('absences:read'), async (c) => {
  const q = c.req.query();
  const result = await listAbsences(db(c), {
    status: q.status === 'ongoing' || q.status === 'completed' ? q.status : undefined,
    employeeId: q.employeeId || undefined,
    departmentId: q.departmentId || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    cursor: q.cursor || undefined,
  });
  return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

absencesRoutes.post('/', requirePermission('absences:create'), zValidator('json', createHrAbsenceSchema), async (c) => {
  const row = await createAbsence(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_absence', 'created', row.id);
  return success(c, row, 201);
});

absencesRoutes.patch('/:absenceId', requirePermission('absences:update'), zValidator('json', updateHrAbsenceSchema), async (c) => {
  const row = await updateAbsence(db(c), param(c, 'absenceId'), c.req.valid('json'), actor(c));
  emit(c, 'hr_absence', 'updated', row.id);
  return success(c, row);
});

absencesRoutes.post(
  '/:absenceId/recover',
  requirePermission('absences:update'),
  zValidator('json', recoverHrAbsenceSchema),
  async (c) => {
    const row = await recoverAbsence(db(c), param(c, 'absenceId'), c.req.valid('json').endDate, actor(c));
    emit(c, 'hr_absence', 'recovered', row.id);
    return success(c, row);
  },
);

absencesRoutes.delete('/:absenceId', requirePermission('absences:delete'), async (c) => {
  const row = await requireAbsence(db(c), param(c, 'absenceId'));
  await deleteAbsence(db(c), row.id);
  emit(c, 'hr_absence', 'deleted', row.id);
  return noContent(c);
});
