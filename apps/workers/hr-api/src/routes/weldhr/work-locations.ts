/**
 * /api/weldhr/work-locations — where employees clock in. Configuration, like
 * leave types: no entity events. Whether a location is required at all is
 * `clockInRequiresLocation` in the WeldHR settings (`hr_settings`).
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { createHrWorkLocationSchema, updateHrWorkLocationSchema } from '@weldsuite/app-api-client/schemas/weldhr';
import { noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import {
  createWorkLocation,
  deleteWorkLocation,
  listWorkLocations,
  updateWorkLocation,
} from '../../services/weldhr/work-locations';
import { db, hrJson, param } from './helpers';

export const workLocationsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

workLocationsRoutes.get('/', requirePermission('employees:read', 'attendance:read', 'employees:manage'), async (c) =>
  success(c, await listWorkLocations(db(c), { includeInactive: c.req.query('includeInactive') === 'true' })),
);

workLocationsRoutes.post('/', requirePermission('employees:manage'), hrJson(createHrWorkLocationSchema), async (c) => {
  const row = await createWorkLocation(db(c), c.req.valid('json'));
  return success(c, row, 201);
});

workLocationsRoutes.patch('/:locationId', requirePermission('employees:manage'), hrJson(updateHrWorkLocationSchema), async (c) => {
  const row = await updateWorkLocation(db(c), param(c, 'locationId'), c.req.valid('json'));
  return success(c, row);
});

workLocationsRoutes.delete('/:locationId', requirePermission('employees:manage'), async (c) => {
  await deleteWorkLocation(db(c), param(c, 'locationId'));
  return noContent(c);
});
