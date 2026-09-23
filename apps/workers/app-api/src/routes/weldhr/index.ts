/**
 * WeldHR routes — /api/weldhr/*, employee operations for the back office.
 * The public workforce portal is `routes/public-hr-portal`.
 *
 * Permissions (packages/core/permissions/src/catalog.ts):
 *   employees:read|create|update|delete  directory, assignments, onboarding
 *   employees:sensitive                  decrypt/edit the sensitive block (audited)
 *   employees:manage                     settings: departments, templates, forms,
 *                                        KPI definitions, leave types, portal
 *   attendance:read|create|update|delete|approve
 *   leave:read|create|update|delete|approve
 *   coaching:read|create|update|delete
 *   evaluations:read|create|update|delete  evaluations, KPI values, milestones
 *
 * Mutations of HR records publish `hr_*` entity events with ids and status
 * only (see helpers.emit). Configuration objects — departments, templates,
 * leave types, evaluation forms, KPI definitions, portal settings — are not
 * entities on the bus. Sensitive reads and portal access changes go to
 * `hr_audit_events` instead.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { success } from '../../lib/response';
import { hrDashboard } from '../../services/weldhr/dashboard';
import { assignmentsRoutes, clientsRoutes } from './assignments';
import { departmentsRoutes, employeesRoutes, orgChartRoutes } from './employees';
import { db, ensureHrDefaults, toHrErrorResponse } from './helpers';
import { checklistTemplatesRoutes, checklistsRoutes } from './lifecycle';
import {
  coachingRoutes,
  evaluationFormsRoutes,
  evaluationsRoutes,
  kpisRoutes,
  kpiValuesRoutes,
  milestonesRoutes,
} from './performance';
import { portalRoutes } from './portal';
import {
  attendanceRoutes,
  leaveAllowancesRoutes,
  leaveRequestsRoutes,
  leaveTypesRoutes,
  shiftsRoutes,
} from './time';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Same boundary pattern as WeldPass: the services throw typed errors and this
// turns them into the standard envelope. A sub-app's onError survives
// `parent.route()`, so anything not ours gets the global handler's treatment.
app.onError((err, c) => {
  const response = toHrErrorResponse(err, c);
  if (response) return response;
  console.error('[weldhr] unhandled error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500);
});

app.use('*', async (c, next) => {
  await ensureHrDefaults(c);
  await next();
});

app.get(
  '/dashboard',
  requirePermission('employees:read', 'attendance:read', 'leave:read', 'coaching:read', 'evaluations:read'),
  async (c) => success(c, await hrDashboard(db(c))),
);

app.route('/employees', employeesRoutes);
app.route('/org-chart', orgChartRoutes);
app.route('/departments', departmentsRoutes);
app.route('/assignments', assignmentsRoutes);
app.route('/clients', clientsRoutes);
app.route('/checklist-templates', checklistTemplatesRoutes);
app.route('/checklists', checklistsRoutes);
app.route('/shifts', shiftsRoutes);
app.route('/attendance', attendanceRoutes);
app.route('/leave-types', leaveTypesRoutes);
app.route('/leave-allowances', leaveAllowancesRoutes);
app.route('/leave-requests', leaveRequestsRoutes);
app.route('/coaching', coachingRoutes);
app.route('/evaluation-forms', evaluationFormsRoutes);
app.route('/evaluations', evaluationsRoutes);
app.route('/kpis', kpisRoutes);
app.route('/kpi-values', kpiValuesRoutes);
app.route('/milestones', milestonesRoutes);
app.route('/portal', portalRoutes);

export { app as weldhrRoutes };
