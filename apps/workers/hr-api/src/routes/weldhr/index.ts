/**
 * WeldHR routes — /api/weldhr/*, employee operations for the back office and
 * My HR (/me). Everyone who uses WeldHR is a workspace member.
 *
 * Permissions (packages/core/permissions/src/catalog.ts):
 *   employees:read|create|update|delete  directory, assignments, onboarding
 *   employees:sensitive                  decrypt/edit the sensitive block (audited)
 *   employees:manage                     settings: departments, templates, forms,
 *                                        KPI definitions, leave types, My HR switches
 *   attendance:read|create|update|delete|approve
 *   leave:read|create|update|delete|approve
 *   declarations:read|create|update|delete|approve  expense claims; approve also marks paid
 *   absences:read|create|update|delete   everyone's sick reports (employees
 *                                        report for themselves under /me)
 *   coaching:read|create|update|delete
 *   evaluations:read|create|update|delete  evaluations, KPI values, milestones
 *   announcements:read|create|update|delete  news to employees (they read theirs under /me)
 *   open shifts use attendance:*; work locations are settings (employees:manage)
 *   employees:self                       My HR: the caller's own record (/me), incl. their
 *                                        payslips, payroll details and tax forms
 *   payroll:read|prepare|approve|manage  /payroll (flag `weldhr-payroll`), see ./payroll
 *
 * Mutations of HR records publish `hr_*` entity events with ids and status
 * only (see helpers.emit). Configuration objects — departments, templates,
 * leave types, evaluation forms, KPI definitions, settings — are not
 * entities on the bus. Sensitive reads and settings changes go to
 * `hr_audit_events` instead.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { success } from '@weldsuite/worker-kit/response';
import { hrDashboard } from '../../services/weldhr/dashboard';
import { absencesRoutes } from './absences';
import { assignmentsRoutes, clientsRoutes } from './assignments';
import { declarationsRoutes } from './declarations';
import { departmentsRoutes, employeesRoutes, orgChartRoutes } from './employees';
import { db, ensureHrDefaults, toHrErrorResponse } from './helpers';
import { meRoutes } from './me';
import { checklistTemplatesRoutes, checklistsRoutes } from './lifecycle';
import {
  coachingRoutes,
  evaluationFormsRoutes,
  evaluationsRoutes,
  kpisRoutes,
  kpiValuesRoutes,
  milestonesRoutes,
} from './performance';
import { payrollRoutes } from './payroll';
import { settingsRoutes } from './settings';
import {
  attendanceRoutes,
  leaveAllowancesRoutes,
  leaveRequestsRoutes,
  leaveTypesRoutes,
  openShiftsRoutes,
  shiftRequestsRoutes,
  shiftsRoutes,
} from './time';
import { announcementsRoutes } from './announcements';
import { workLocationsRoutes } from './work-locations';

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
app.route('/shift-requests', shiftRequestsRoutes);
app.route('/open-shifts', openShiftsRoutes);
app.route('/work-locations', workLocationsRoutes);
app.route('/announcements', announcementsRoutes);
app.route('/attendance', attendanceRoutes);
app.route('/leave-types', leaveTypesRoutes);
app.route('/leave-allowances', leaveAllowancesRoutes);
app.route('/leave-requests', leaveRequestsRoutes);
app.route('/declarations', declarationsRoutes);
app.route('/absences', absencesRoutes);
app.route('/coaching', coachingRoutes);
app.route('/evaluation-forms', evaluationFormsRoutes);
app.route('/evaluations', evaluationsRoutes);
app.route('/kpis', kpisRoutes);
app.route('/kpi-values', kpiValuesRoutes);
app.route('/milestones', milestonesRoutes);
app.route('/settings', settingsRoutes);
// Payroll: gated by the `weldhr-payroll` flag; permissions payroll:read|prepare|approve|manage.
app.route('/payroll', payrollRoutes);
app.route('/me', meRoutes);

export { app as weldhrRoutes };
