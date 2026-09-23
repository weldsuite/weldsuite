/**
 * /api/weldhr/assignments and /api/weldhr/clients
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { createHrAssignmentSchema, updateHrAssignmentSchema } from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { noContent, success } from '../../lib/response';
import {
  createAssignment,
  deleteAssignment,
  listAssignments,
  listClientAccounts,
  requireAssignment,
  requireCompany,
  updateAssignment,
} from '../../services/weldhr/assignments';
import { buildClientView } from '../../services/weldhr/client-view';
import { listPortalAccess, loadPortalSettings } from '../../services/weldhr/portal';
import { actor, db, emit, param } from './helpers';

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

assignmentsRoutes.post('/', requirePermission('employees:update'), zValidator('json', createHrAssignmentSchema), async (c) => {
  const row = await createAssignment(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_client_assignment', 'created', row.id, { employeeId: row.employeeId, companyId: row.companyId });
  return success(c, row, 201);
});

assignmentsRoutes.patch('/:assignmentId', requirePermission('employees:update'), zValidator('json', updateHrAssignmentSchema), async (c) => {
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

/**
 * One client account: the full team (internal view) plus exactly what the
 * client sees in the portal, built by the same function the portal uses.
 */
clientsRoutes.get('/:companyId', requirePermission('employees:read'), async (c) => {
  const database = db(c);
  const companyId = param(c, 'companyId');
  const company = await requireCompany(database, companyId);
  const [settings, assignments, portalAccess] = await Promise.all([
    loadPortalSettings(database),
    listAssignments(database, { companyId }),
    listPortalAccess(database, { kind: 'client', companyId }),
  ]);
  const clientView = await buildClientView(database, companyId, {
    individualScores: settings.clientCanSeeIndividualScores,
  });
  return success(c, { company, assignments, portalAccess, clientView });
});
