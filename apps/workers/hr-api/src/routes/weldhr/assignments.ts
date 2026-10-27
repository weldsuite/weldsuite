/**
 * /api/weldhr/assignments and /api/weldhr/clients
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { createHrAssignmentSchema, updateHrAssignmentSchema } from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { noContent, success } from '@weldsuite/worker-kit/response';
import {
  createAssignment,
  deleteAssignment,
  listAssignments,
  listClientAccounts,
  requireAssignment,
  requireCompany,
  updateAssignment,
} from '../../services/weldhr/assignments';
import { actor, hrJson, db, emit, param } from './helpers';

export const assignmentsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

assignmentsRoutes.get('/', requirePermission('employees:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listAssignments(db(c), {
      employeeId: q.employeeId || undefined,
      companyId: q.companyId || undefined,
      activeOnly: q.active === 'true',
    }),
  );
});

assignmentsRoutes.post('/', requirePermission('employees:update'), hrJson(createHrAssignmentSchema), async (c) => {
  const row = await createAssignment(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_client_assignment', 'created', row.id, { employeeId: row.employeeId, companyId: row.companyId });
  return success(c, row, 201);
});

assignmentsRoutes.patch('/:assignmentId', requirePermission('employees:update'), hrJson(updateHrAssignmentSchema), async (c) => {
  const row = await updateAssignment(db(c), param(c, 'assignmentId'), c.req.valid('json'));
  emit(c, 'hr_client_assignment', 'updated', row.id, { employeeId: row.employeeId, companyId: row.companyId });
  return success(c, row);
});

assignmentsRoutes.delete('/:assignmentId', requirePermission('employees:update'), async (c) => {
  const existing = await requireAssignment(db(c), param(c, 'assignmentId'));
  await deleteAssignment(db(c), existing.id);
  emit(c, 'hr_client_assignment', 'deleted', existing.id, { employeeId: existing.employeeId, companyId: existing.companyId });
  return noContent(c);
});

export const clientsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

clientsRoutes.get('/', requirePermission('employees:read'), async (c) => success(c, await listClientAccounts(db(c))));

/** One client account and everyone who works, or has worked, on it. */
clientsRoutes.get('/:companyId', requirePermission('employees:read'), async (c) => {
  const database = db(c);
  const companyId = param(c, 'companyId');
  const company = await requireCompany(database, companyId);
  const assignments = await listAssignments(database, { companyId });
  return success(c, { company, assignments });
});
