/**
 * /api/weldhr/me/* — My HR: the signed-in member's own employee record.
 *
 * For every workspace member with an employee record (EMPLOYEE members above
 * all, whose whole platform is My HR plus WeldChat). The principal is the
 * Clerk user, and the employee is the `hr_employees` row whose `user_id` is
 * that user — never an id from the request — so a member can only ever reach
 * their own rows. A member HR added while their invite was pending is linked
 * here on first use (see `linkInvitedEmployees`).
 *
 * Gated on `employees:self`. A member with no linked employee (or a
 * terminated one) gets `{ employee: null }` from GET /me and a 404 elsewhere.
 * Clock-in, leave requests and expense declarations honour the switches in
 * `hr_settings` (`employee_self_clock_in` / `employee_leave_requests` /
 * `employee_declarations`), and clocking needs the device at a work location
 * while `clock_in_requires_location` is on; reporting sick and recovered,
 * asking for a shift, signing up for an open shift and reading announcements
 * are always available.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  hrSelfAbsenceSchema,
  hrSelfAcknowledgeSchema,
  hrSelfClockSchema,
  hrSelfDeclarationSchema,
  hrSelfLeaveRequestSchema,
  hrSelfShiftRequestSchema,
  hrSelfOpenShiftRequestSchema,
  recoverHrAbsenceSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { employeeAbsences, recoverAbsence, reportSick } from '../../services/weldhr/absences';
import {
  attachDeclarationReceipt,
  cancelDeclaration,
  createDeclaration,
  employeeDeclarations,
  loadDeclarationReceipt,
  receiptFileFrom,
  receiptResponse,
  toPublicDeclaration,
} from '../../services/weldhr/declarations';
import { employeeForUser } from '../../services/weldhr/employees';
import { acknowledgeCoachingLog, acknowledgeEvaluation } from '../../services/weldhr/performance';
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
} from '../../services/weldhr/self-service';
import { loadHrSettings } from '../../services/weldhr/settings';
import { HrNotFoundError, addDays, todayIso } from '../../services/weldhr/shared';
import { announcementsForEmployee, markAnnouncementRead } from '../../services/weldhr/announcements';
import { openShiftsForEmployee } from '../../services/weldhr/open-shifts';
import {
  cancelShiftRequest,
  requestShift,
  signUpForOpenShift,
  toSelfShiftRequest,
} from '../../services/weldhr/shift-requests';
import { cancelLeaveRequest, clock, createLeaveRequest, switchShift } from '../../services/weldhr/time';
import { clockPlaceFor } from '../../services/weldhr/work-locations';
import {
  actor,
  hrJson,
  db,
  emit,
  linkInvitedEmployees,
  param,
  receiptBucket,
  workspaceIdOf,
  type HrContext,
} from './helpers';
import { requirePayrollFlag } from './payroll/flag';
import { registerPayrollSelfService } from './payroll/self-service';

export const meRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

meRoutes.use('*', requirePermission('employees:self'));

/**
 * The caller's employee record. Not linked yet but HR added them by email
 * before they accepted their invite? Then this is where the link is made.
 */
async function selfEmployee(c: HrContext) {
  const employee = await employeeForUser(db(c), actor(c));
  if (employee) return employee;
  const linked = await linkInvitedEmployees(c, { userId: actor(c) });
  return linked.length ? employeeForUser(db(c), actor(c)) : null;
}

/** The caller's employee id; 404 when they have no (active) employee record. */
async function selfEmployeeId(c: HrContext): Promise<string> {
  const employee = await selfEmployee(c);
  if (!employee) throw new HrNotFoundError('Employee', 'me');
  return employee.id;
}

async function features(c: HrContext) {
  const settings = await loadHrSettings(db(c));
  return {
    selfClockIn: settings.employeeSelfClockIn,
    clockInRequiresLocation: settings.clockInRequiresLocation,
    leaveRequests: settings.employeeLeaveRequests,
    declarations: settings.employeeDeclarations,
  };
}

meRoutes.get('/', async (c) => {
  const database = db(c);
  const [employee, flags] = await Promise.all([selfEmployee(c), features(c)]);
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
  return success(c, await employeeAttendance(db(c), employeeId, from, to, { withPay: true, withRequests: true }));
});

// Asking to work a shift; a manager answers it in WeldHR → Attendance. Like
// reporting sick it has no switch: asking commits the company to nothing.
meRoutes.post('/shift-requests', hrJson(hrSelfShiftRequestSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await requestShift(db(c), employeeId, c.req.valid('json'), actor(c));
  emit(c, 'hr_shift_request', 'created', row.id, { employeeId, status: row.status });
  return success(c, toSelfShiftRequest(row), 201);
});

meRoutes.post('/shift-requests/:shiftRequestId/cancel', async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await cancelShiftRequest(db(c), param(c, 'shiftRequestId'), employeeId);
  emit(c, 'hr_shift_request', 'updated', row.id, { employeeId, status: row.status });
  return success(c, toSelfShiftRequest(row));
});

// Open shifts: what the employee may sign up for. A sign-up is a shift request
// a manager answers, so like asking for a shift it has no switch.
meRoutes.get('/open-shifts', async (c) => success(c, await openShiftsForEmployee(db(c), await selfEmployeeId(c))));

meRoutes.post('/open-shifts/:openShiftId/sign-up', hrJson(hrSelfOpenShiftRequestSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await signUpForOpenShift(db(c), employeeId, param(c, 'openShiftId'), c.req.valid('json'), actor(c));
  emit(c, 'hr_shift_request', 'created', row.id, { employeeId, status: row.status });
  return success(c, toSelfShiftRequest(row), 201);
});

meRoutes.get('/announcements', async (c) => success(c, await announcementsForEmployee(db(c), await selfEmployeeId(c))));

meRoutes.post('/announcements/:announcementId/read', async (c) => {
  const employeeId = await selfEmployeeId(c);
  return success(c, await markAnnouncementRead(db(c), param(c, 'announcementId'), employeeId));
});

meRoutes.post('/clock', hrJson(hrSelfClockSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const flags = await features(c);
  if (!flags.selfClockIn) return error.forbidden(c, 'Clocking in yourself is turned off');
  const { action, shiftId, location } = c.req.valid('json');
  const place = await clockPlaceFor(db(c), employeeId, flags.clockInRequiresLocation, location);
  let record;
  if (action === 'switch') {
    const { closed, opened } = await switchShift(db(c), employeeId, shiftId, new Date(), actor(c), place);
    emit(c, 'hr_attendance', 'updated', closed.id, { employeeId, status: closed.status });
    emit(c, 'hr_attendance', 'created', opened.id, { employeeId, status: opened.status });
    record = opened;
  } else {
    record = await clock(db(c), employeeId, action, new Date(), actor(c), shiftId, place);
    emit(c, 'hr_attendance', action === 'in' ? 'created' : 'updated', record.id, { employeeId, status: record.status });
  }
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

meRoutes.post('/leave', hrJson(hrSelfLeaveRequestSchema), async (c) => {
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

meRoutes.get('/declarations', async (c) => success(c, await employeeDeclarations(db(c), await selfEmployeeId(c))));

meRoutes.post('/declarations', hrJson(hrSelfDeclarationSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  if (!(await features(c)).declarations) return error.forbidden(c, 'Expense declarations are turned off');
  const row = await createDeclaration(db(c), { ...c.req.valid('json'), employeeId }, actor(c));
  emit(c, 'hr_declaration', 'created', row.id, { employeeId, status: row.status });
  return success(c, toPublicDeclaration(row), 201);
});

meRoutes.post('/declarations/:declarationId/cancel', async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await cancelDeclaration(db(c), param(c, 'declarationId'), employeeId);
  emit(c, 'hr_declaration', 'updated', row.id, { employeeId, status: row.status });
  return success(c, toPublicDeclaration(row));
});

meRoutes.post('/declarations/:declarationId/receipt', async (c) => {
  const employeeId = await selfEmployeeId(c);
  const file = receiptFileFrom(await c.req.parseBody());
  const row = await attachDeclarationReceipt(db(c), receiptBucket(c), workspaceIdOf(c), param(c, 'declarationId'), file, employeeId);
  emit(c, 'hr_declaration', 'updated', row.id, { employeeId, status: row.status });
  return success(c, toPublicDeclaration(row));
});

meRoutes.get('/declarations/:declarationId/receipt', async (c) => {
  const employeeId = await selfEmployeeId(c);
  return receiptResponse(
    await loadDeclarationReceipt(db(c), receiptBucket(c), workspaceIdOf(c), param(c, 'declarationId'), employeeId),
  );
});

// Reporting sick is not a switch like leave requests: an employee who is ill
// has to be able to say so. The events carry the report id only (see routes/weldhr/absences.ts).
meRoutes.get('/absences', async (c) => success(c, await employeeAbsences(db(c), await selfEmployeeId(c))));

meRoutes.post('/absences', hrJson(hrSelfAbsenceSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await reportSick(db(c), employeeId, c.req.valid('json'), actor(c));
  emit(c, 'hr_absence', 'created', row.id);
  return success(c, row, 201);
});

meRoutes.post('/absences/:absenceId/recover', hrJson(recoverHrAbsenceSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await recoverAbsence(db(c), param(c, 'absenceId'), c.req.valid('json').endDate, actor(c), employeeId);
  emit(c, 'hr_absence', 'recovered', row.id);
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

meRoutes.post('/coaching/:coachingId/acknowledge', hrJson(hrSelfAcknowledgeSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await acknowledgeCoachingLog(db(c), param(c, 'coachingId'), employeeId, c.req.valid('json').comment);
  emit(c, 'hr_coaching_log', 'acknowledged', row.id, { employeeId, status: row.status });
  return success(c, { id: row.id, acknowledgedAt: row.acknowledgedAt, status: row.status });
});

meRoutes.get('/evaluations', async (c) => success(c, await employeeEvaluations(db(c), await selfEmployeeId(c))));

meRoutes.post('/evaluations/:evaluationId/acknowledge', hrJson(hrSelfAcknowledgeSchema), async (c) => {
  const employeeId = await selfEmployeeId(c);
  const row = await acknowledgeEvaluation(db(c), param(c, 'evaluationId'), employeeId, c.req.valid('json').comment);
  emit(c, 'hr_evaluation', 'acknowledged', row.id, { employeeId, status: row.status });
  return success(c, { id: row.id, acknowledgedAt: row.acknowledgedAt, status: row.status });
});

meRoutes.get('/performance', async (c) => success(c, await employeePerformance(db(c), await selfEmployeeId(c))));

// Payslips, annual statements, payroll details and tax forms (flag `weldhr-payroll`; employees:self applies above).
registerPayrollSelfService(
  meRoutes,
  async (c) => ({ employeeId: await selfEmployeeId(c), actor: actor(c) }),
  requirePayrollFlag,
);
