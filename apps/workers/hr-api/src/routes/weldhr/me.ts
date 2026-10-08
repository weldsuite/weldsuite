/**
 * /api/weldhr/me/* — My HR: the signed-in member's own employee record.
 *
 * The platform twin of the workforce portal's `/employee/*` endpoints, for
 * workspace members (EMPLOYEE members above all, whose whole platform is
 * My HR plus WeldChat). Same services, same shapes; the difference is who the
 * principal is. Here it is the Clerk user, and the employee is the
 * `hr_employees` row whose `user_id` is that user — never an id from the
 * request — so a member can only ever reach their own rows.
 *
 * Gated on `employees:self`. A member with no linked employee (or a
 * terminated one) gets `{ employee: null }` from GET /me and a 404 elsewhere.
 * Clock-in and leave requests honour the same switches as the portal
 * (`hr_portal_settings.employee_self_clock_in` / `employee_leave_requests`).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  hrPortalAcknowledgeSchema,
  hrPortalClockSchema,
  hrPortalLeaveRequestSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { employeeForUser } from '../../services/weldhr/employees';
import { acknowledgeCoachingLog, acknowledgeEvaluation } from '../../services/weldhr/performance';
import { loadPortalSettings } from '../../services/weldhr/portal';
import {
  completeEmployeeTask,
  employeeAttendance,
  employeeCoaching,
  employeeEvaluations,
  employeeLeave,
  employeeOverview,
  employeePerformance,
  employeeProfile,
  employeeTasks,
} from '../../services/weldhr/portal-self-service';
import { HrNotFoundError, addDays, todayIso } from '../../services/weldhr/shared';
import { cancelLeaveRequest, clock, createLeaveRequest } from '../../services/weldhr/time';
import { actor, db, emit, param, type HrContext } from './helpers';

export const meRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

meRoutes.use('*', requirePermission('employees:self'));

/** The caller's employee id; 404 when they have no (active) employee record. */
async function selfEmployeeId(c: HrContext): Promise<string> {
  const employee = await employeeForUser(db(c), actor(c));
  if (!employee) throw new HrNotFoundError('Employee', 'me');
  return employee.id;
}

async function features(c: HrContext) {
  const settings = await loadPortalSettings(db(c));
  return { selfClockIn: settings.employeeSelfClockIn, leaveRequests: settings.employeeLeaveRequests };
}

meRoutes.get('/', async (c) => {
  const database = db(c);
  const [employee, flags] = await Promise.all([employeeForUser(database, actor(c)), features(c)]);
  return success(c, {
    employee: employee ? await employeeProfile(database, employee.id) : null,
    features: flags,
  });
});

meRoutes.get('/overview', async (c) => success(c, await employeeOverview(db(c), await selfEmployeeId(c))));

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

meRoutes.get('/attendance', async (c) => {
  const employeeId = await selfEmployeeId(c);
  const q = c.req.query();
  const to = q.to && isoDate.test(q.to) ? q.to : addDays(todayIso(), 14);
  const from = q.from && isoDate.test(q.from) ? q.from : addDays(todayIso(), -30);
  if (to < from || addDays(from, 92) < to) return error.badRequest(c, 'Pick a range of at most 92 days');
  return success(c, await employeeAttendance(db(c), employeeId, from, to));
});

meRoutes.post('/clock', zValidator('json', hrPortalClockSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  if (!(await features(c)).selfClockIn) return error.forbidden(c, 'Clocking in yourself is turned off');
  const { action } = c.req.valid('json');
  const record = await clock(db(c), employeeId, action, new Date(), actor(c));
  emit(c, 'hr_attendance', action === 'in' ? 'created' : 'updated', record.id, { employeeId, status: record.status });
  return success(c, {
    id: record.id,
    date: record.date,
    clockIn: record.clockIn,
    clockOut: record.clockOut,
    status: record.status,
    workedMinutes: record.workedMinutes,
    lateMinutes: record.lateMinutes,
  });
});

meRoutes.get('/leave', async (c) => success(c, await employeeLeave(db(c), await selfEmployeeId(c))));

meRoutes.post('/leave', zValidator('json', hrPortalLeaveRequestSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  if (!(await features(c)).leaveRequests) return error.forbidden(c, 'Leave requests are turned off');
  const row = await createLeaveRequest(db(c), { ...c.req.valid('json'), employeeId }, actor(c));
  emit(c, 'hr_leave_request', row.status === 'approved' ? 'approved' : 'created', row.id, { employeeId, status: row.status });
  return success(c, row, 201);
});

meRoutes.post('/leave/:leaveRequestId/cancel', async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await cancelLeaveRequest(db(c), param(c, 'leaveRequestId'), employeeId);
  emit(c, 'hr_leave_request', 'updated', row.id, { employeeId, status: row.status });
  return success(c, row);
});

meRoutes.get('/tasks', async (c) => success(c, await employeeTasks(db(c), await selfEmployeeId(c))));

meRoutes.post('/tasks/:taskId/complete', async (c) => {
  const employeeId = await selfEmployeeId(c);
  const done = c.req.query('undo') !== 'true';
  const { checklistId, outcome } = await completeEmployeeTask(db(c), employeeId, param(c, 'taskId'), done, actor(c));
  emit(c, 'hr_checklist', outcome.checklistCompleted ? 'completed' : 'updated', checklistId, { employeeId });
  if (outcome.employeeStatus === 'active') emit(c, 'hr_employee', 'onboarded', employeeId, { status: 'active' });
  return success(c, { ok: true, checklistCompleted: outcome.checklistCompleted });
});

meRoutes.get('/coaching', async (c) => success(c, await employeeCoaching(db(c), await selfEmployeeId(c))));

meRoutes.post('/coaching/:coachingId/acknowledge', zValidator('json', hrPortalAcknowledgeSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await acknowledgeCoachingLog(db(c), param(c, 'coachingId'), employeeId, c.req.valid('json').comment);
  emit(c, 'hr_coaching_log', 'acknowledged', row.id, { employeeId, status: row.status });
  return success(c, { id: row.id, acknowledgedAt: row.acknowledgedAt, status: row.status });
});

meRoutes.get('/evaluations', async (c) => success(c, await employeeEvaluations(db(c), await selfEmployeeId(c))));

meRoutes.post('/evaluations/:evaluationId/acknowledge', zValidator('json', hrPortalAcknowledgeSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await acknowledgeEvaluation(db(c), param(c, 'evaluationId'), employeeId, c.req.valid('json').comment);
  emit(c, 'hr_evaluation', 'acknowledged', row.id, { employeeId, status: row.status });
  return success(c, { id: row.id, acknowledgedAt: row.acknowledgedAt, status: row.status });
});

meRoutes.get('/performance', async (c) => success(c, await employeePerformance(db(c), await selfEmployeeId(c))));
