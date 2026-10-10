/**
 * /api/weldhr/payroll/* — WeldHR payroll (docs/plans/weldhr-payroll.md).
 *
 * Gated by the `weldhr-payroll` feature flag: without it every path here is a
 * 404. Permissions (packages/core/permissions/src/catalog.ts):
 *
 *   payroll:read     overview, runs, payslips, filings, employee payroll data
 *   payroll:prepare  employee setup, compensation, components, elections,
 *                    payment details; create, collect, calculate, cancel runs
 *   payroll:approve  approve and pay runs, the payment file, the journal
 *   payroll:manage   employers, pay schedules, submitting and recording filings
 *
 * The employee's own payslips, details and tax forms are under /me and the
 * workforce portal (`self-service.ts`), not here.
 *
 * Mutations of runs and filings publish `hr_pay_run`, `hr_payslip` and
 * `hr_payroll_filing` events with ids and status only. Setup objects
 * (employers, schedules, compensation…) are configuration, not entities on
 * the bus; sensitive changes go to `hr_audit_events`.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../../types';
import { payrollOverview } from '../../../services/weldhr/payroll/overview';
import { todayIso } from '../../../services/weldhr/shared';
import { db } from '../helpers';
import { payrollDeps, sendingAvailable } from './deps';
import { filingsRoutes, payslipsRoutes } from './documents';
import { requirePayrollFlag } from './flag';
import { runsRoutes } from './runs';
import { compensationsRoutes, componentsRoutes, employeesRoutes, employersRoutes, schedulesRoutes } from './setup';

export const payrollRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

payrollRoutes.use('*', requirePayrollFlag);

payrollRoutes.get('/overview', requirePermission('payroll:read'), async (c) =>
  success(c, await payrollOverview(db(c), payrollDeps(c).keyring, { today: todayIso(), digipoortAvailable: (await sendingAvailable(c)).available })),
);

payrollRoutes.route('/employers', employersRoutes);
payrollRoutes.route('/schedules', schedulesRoutes);
payrollRoutes.route('/employees', employeesRoutes);
payrollRoutes.route('/compensations', compensationsRoutes);
payrollRoutes.route('/components', componentsRoutes);
payrollRoutes.route('/runs', runsRoutes);
payrollRoutes.route('/payslips', payslipsRoutes);
payrollRoutes.route('/filings', filingsRoutes);
