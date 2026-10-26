/**
 * /api/weldhr/shifts, /api/weldhr/shift-requests, /api/weldhr/open-shifts,
 * /api/weldhr/attendance, /api/weldhr/leave-types, /api/weldhr/leave-allowances,
 * /api/weldhr/leave-requests
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrAttendanceSchema,
  createHrLeaveRequestSchema,
  createHrLeaveTypeSchema,
  createHrOpenShiftSchema,
  createHrShiftSchema,
  importHrAttendanceSchema,
  reviewHrLeaveRequestSchema,
  reviewHrShiftRequestSchema,
  setHrLeaveAllowanceSchema,
  updateHrAttendanceSchema,
  updateHrLeaveTypeSchema,
  updateHrOpenShiftSchema,
  updateHrShiftSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  approveAttendance,
  attendanceSummary,
  cancelLeaveRequest,
  createAttendance,
  createLeaveRequest,
  createLeaveType,
  createShift,
  deleteAttendance,
  deleteLeaveRequest,
  deleteLeaveType,
  deleteShift,
  importAttendance,
  leaveBalances,
  listAttendance,
  listLeaveRequests,
  listLeaveTypes,
  listShifts,
  requireAttendance,
  requireLeaveRequest,
  reviewLeaveRequest,
  setAllowance,
  updateAttendance,
  updateLeaveType,
  updateShift,
} from '../../services/weldhr/time';
import { addDays, todayIso } from '../../services/weldhr/shared';
import { listShiftRequests, reviewShiftRequest, shiftRequestWithNames } from '../../services/weldhr/shift-requests';
import {
  cancelOpenShift,
  createOpenShift,
  listOpenShifts,
  openShiftWithDetails,
  settleOpenShift,
  updateOpenShift,
} from '../../services/weldhr/open-shifts';
import { actor, hrJson, db, emit, emitPortalConfig, param } from './helpers';

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export const shiftsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

shiftsRoutes.get('/', requirePermission('attendance:read'), async (c) => {
  const q = c.req.query();
  const from = q.from && isoDate.test(q.from) ? q.from : todayIso();
  const to = q.to && isoDate.test(q.to) ? q.to : addDays(from, 6);
  if (to < from || addDays(from, 62) < to) return error.badRequest(c, 'Pick a range of at most 62 days');
  return success(c, await listShifts(db(c), { from, to, employeeId: q.employeeId || undefined, companyId: q.companyId || undefined }));
});

shiftsRoutes.post('/', requirePermission('attendance:create'), hrJson(createHrShiftSchema), async (c) => {
  return success(c, await createShift(db(c), c.req.valid('json'), actor(c)), 201);
});

shiftsRoutes.patch('/:shiftId', requirePermission('attendance:update'), hrJson(updateHrShiftSchema), async (c) => {
  return success(c, await updateShift(db(c), param(c, 'shiftId'), c.req.valid('json')));
});

shiftsRoutes.delete('/:shiftId', requirePermission('attendance:delete'), async (c) => {
  await deleteShift(db(c), param(c, 'shiftId'));
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Shift requests (employees asking to work a shift, from the WeldHR app)
// ---------------------------------------------------------------------------

export const shiftRequestsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

shiftRequestsRoutes.get('/', requirePermission('attendance:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listShiftRequests(db(c), {
      employeeId: q.employeeId || undefined,
      status: q.status || undefined,
      from: q.from && isoDate.test(q.from) ? q.from : undefined,
      to: q.to && isoDate.test(q.to) ? q.to : undefined,
    }),
  );
});

// Approving puts a shift on the rooster, so it takes the right to create one.
shiftRequestsRoutes.post(
  '/:shiftRequestId/review',
  requirePermission('attendance:create'),
  hrJson(reviewHrShiftRequestSchema),
  async (c) => {
    const row = await reviewShiftRequest(db(c), param(c, 'shiftRequestId'), c.req.valid('json'), actor(c));
    emit(c, 'hr_shift_request', row.status === 'approved' ? 'approved' : 'rejected', row.id, {
      employeeId: row.employeeId,
      status: row.status,
    });
    if (row.openShiftId && row.status === 'approved') {
      // The last spot taken turns down whoever is still waiting for it.
      for (const closed of await settleOpenShift(db(c), row.openShiftId, actor(c))) {
        emit(c, 'hr_shift_request', 'rejected', closed.id, { employeeId: closed.employeeId, status: closed.status });
      }
      emit(c, 'hr_open_shift', 'updated', row.openShiftId);
    }
    return success(c, await shiftRequestWithNames(db(c), row.id));
  },
);

// ---------------------------------------------------------------------------
// Open shifts (posted for employees to sign up; sign-ups are shift requests)
// ---------------------------------------------------------------------------

export const openShiftsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

openShiftsRoutes.get('/', requirePermission('attendance:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listOpenShifts(db(c), {
      from: q.from && isoDate.test(q.from) ? q.from : undefined,
      to: q.to && isoDate.test(q.to) ? q.to : undefined,
      status: q.status || undefined,
    }),
  );
});

openShiftsRoutes.post('/', requirePermission('attendance:create'), hrJson(createHrOpenShiftSchema), async (c) => {
  const row = await createOpenShift(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_open_shift', 'created', row.id, { status: row.status });
  return success(c, await openShiftWithDetails(db(c), row.id), 201);
});

openShiftsRoutes.patch('/:openShiftId', requirePermission('attendance:update'), hrJson(updateHrOpenShiftSchema), async (c) => {
  const row = await updateOpenShift(db(c), param(c, 'openShiftId'), c.req.valid('json'));
  emit(c, 'hr_open_shift', 'updated', row.id, { status: row.status });
  return success(c, await openShiftWithDetails(db(c), row.id));
});

// Withdrawing keeps the row (sign-ups point at it); waiting sign-ups are cancelled.
openShiftsRoutes.post('/:openShiftId/cancel', requirePermission('attendance:delete'), async (c) => {
  const { row, closed } = await cancelOpenShift(db(c), param(c, 'openShiftId'), actor(c));
  emit(c, 'hr_open_shift', 'cancelled', row.id, { status: row.status });
  for (const request of closed) {
    emit(c, 'hr_shift_request', 'updated', request.id, { employeeId: request.employeeId, status: request.status });
  }
  return success(c, await openShiftWithDetails(db(c), row.id));
});

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export const attendanceRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

attendanceRoutes.get('/', requirePermission('attendance:read'), async (c) => {
  const q = c.req.query();
  const result = await listAttendance(db(c), {
    employeeId: q.employeeId || undefined,
    companyId: q.companyId || undefined,
    from: q.from && isoDate.test(q.from) ? q.from : undefined,
    to: q.to && isoDate.test(q.to) ? q.to : undefined,
    status: q.status || undefined,
    unapproved: q.unapproved === 'true',
    limit: q.limit ? Number(q.limit) : undefined,
    cursor: q.cursor || undefined,
  });
  return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

attendanceRoutes.get('/summary', requirePermission('attendance:read'), async (c) => {
  const q = c.req.query();
  const to = q.to && isoDate.test(q.to) ? q.to : todayIso();
  const from = q.from && isoDate.test(q.from) ? q.from : addDays(to, -29);
  return success(
    c,
    await attendanceSummary(db(c), {
      from,
      to,
      employeeIds: q.employeeId ? [q.employeeId] : undefined,
      companyId: q.companyId || undefined,
    }),
  );
});

attendanceRoutes.post('/', requirePermission('attendance:create'), hrJson(createHrAttendanceSchema), async (c) => {
  const row = await createAttendance(db(c), c.req.valid('json'), { createdBy: actor(c) });
  emit(c, 'hr_attendance', 'created', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, row, 201);
});

attendanceRoutes.post('/import', requirePermission('attendance:create'), hrJson(importHrAttendanceSchema), async (c) => {
  const { rows, dryRun } = c.req.valid('json');
  const result = await importAttendance(db(c), rows, actor(c), { dryRun });
  return success(c, result);
});

attendanceRoutes.post(
  '/approve',
  requirePermission('attendance:approve'),
  hrJson(z.object({ ids: z.array(z.string().min(1).max(30)).min(1).max(1000) })),
  async (c) => {
    const approved = await approveAttendance(db(c), c.req.valid('json').ids, actor(c));
    for (const row of approved) emit(c, 'hr_attendance', 'approved', row.id, { employeeId: row.employeeId });
    return success(c, { approved: approved.length });
  },
);

attendanceRoutes.patch('/:attendanceId', requirePermission('attendance:update'), hrJson(updateHrAttendanceSchema), async (c) => {
  const row = await updateAttendance(db(c), param(c, 'attendanceId'), c.req.valid('json'));
  emit(c, 'hr_attendance', 'updated', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, row);
});

attendanceRoutes.delete('/:attendanceId', requirePermission('attendance:delete'), async (c) => {
  const row = await requireAttendance(db(c), param(c, 'attendanceId'));
  await deleteAttendance(db(c), row.id);
  emit(c, 'hr_attendance', 'deleted', row.id, { employeeId: row.employeeId });
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export const leaveTypesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

leaveTypesRoutes.get('/', requirePermission('leave:read', 'employees:read'), async (c) => {
  return success(c, await listLeaveTypes(db(c), c.req.query('includeInactive') === 'true'));
});

leaveTypesRoutes.post('/', requirePermission('employees:manage'), hrJson(createHrLeaveTypeSchema), async (c) => {
  const row = await createLeaveType(db(c), c.req.valid('json'));
  emitPortalConfig(c, 'hr_leave_type', row.id);
  return success(c, row, 201);
});

leaveTypesRoutes.patch('/:leaveTypeId', requirePermission('employees:manage'), hrJson(updateHrLeaveTypeSchema), async (c) => {
  const row = await updateLeaveType(db(c), param(c, 'leaveTypeId'), c.req.valid('json'));
  emitPortalConfig(c, 'hr_leave_type', row.id);
  return success(c, row);
});

leaveTypesRoutes.delete('/:leaveTypeId', requirePermission('employees:manage'), async (c) => {
  const id = param(c, 'leaveTypeId');
  const result = await deleteLeaveType(db(c), id);
  emitPortalConfig(c, 'hr_leave_type', id);
  return success(c, result);
});

export const leaveAllowancesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

leaveAllowancesRoutes.get('/balances/:employeeId', requirePermission('leave:read'), async (c) => {
  const year = Number(c.req.query('year')) || new Date().getUTCFullYear();
  return success(c, await leaveBalances(db(c), param(c, 'employeeId'), year));
});

leaveAllowancesRoutes.put('/', requirePermission('leave:update'), hrJson(setHrLeaveAllowanceSchema), async (c) => {
  return success(c, await setAllowance(db(c), c.req.valid('json')));
});

export const leaveRequestsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

leaveRequestsRoutes.get('/', requirePermission('leave:read'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listLeaveRequests(db(c), {
      employeeId: q.employeeId || undefined,
      status: q.status || undefined,
      from: q.from && isoDate.test(q.from) ? q.from : undefined,
      to: q.to && isoDate.test(q.to) ? q.to : undefined,
    }),
  );
});

leaveRequestsRoutes.post('/', requirePermission('leave:create'), hrJson(createHrLeaveRequestSchema), async (c) => {
  const row = await createLeaveRequest(db(c), c.req.valid('json'), actor(c));
  emit(c, 'hr_leave_request', row.status === 'approved' ? 'approved' : 'created', row.id, {
    employeeId: row.employeeId,
    status: row.status,
  });
  return success(c, row, 201);
});

leaveRequestsRoutes.post(
  '/:leaveRequestId/review',
  requirePermission('leave:approve'),
  hrJson(reviewHrLeaveRequestSchema),
  async (c) => {
    const row = await reviewLeaveRequest(db(c), param(c, 'leaveRequestId'), c.req.valid('json'), actor(c));
    emit(c, 'hr_leave_request', row.status === 'approved' ? 'approved' : 'rejected', row.id, {
      employeeId: row.employeeId,
      status: row.status,
    });
    return success(c, row);
  },
);

leaveRequestsRoutes.post('/:leaveRequestId/cancel', requirePermission('leave:update'), async (c) => {
  const row = await cancelLeaveRequest(db(c), param(c, 'leaveRequestId'));
  emit(c, 'hr_leave_request', 'updated', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, row);
});

leaveRequestsRoutes.delete('/:leaveRequestId', requirePermission('leave:delete'), async (c) => {
  const row = await requireLeaveRequest(db(c), param(c, 'leaveRequestId'));
  await deleteLeaveRequest(db(c), row.id);
  emit(c, 'hr_leave_request', 'deleted', row.id, { employeeId: row.employeeId });
  return noContent(c);
});
