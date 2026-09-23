/**
 * /api/weldhr/shifts, /api/weldhr/attendance, /api/weldhr/leave-types,
 * /api/weldhr/leave-allowances, /api/weldhr/leave-requests
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createHrAttendanceSchema,
  createHrLeaveRequestSchema,
  createHrLeaveTypeSchema,
  createHrShiftSchema,
  importHrAttendanceSchema,
  reviewHrLeaveRequestSchema,
  setHrLeaveAllowanceSchema,
  updateHrAttendanceSchema,
  updateHrLeaveTypeSchema,
  updateHrShiftSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
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
import { actor, db, emit, param } from './helpers';

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

shiftsRoutes.post('/', requirePermission('attendance:create'), zValidator('json', createHrShiftSchema), async (c) => {
  return success(c, await createShift(db(c), c.req.valid('json'), actor(c)), 201);
});

shiftsRoutes.patch('/:shiftId', requirePermission('attendance:update'), zValidator('json', updateHrShiftSchema), async (c) => {
  return success(c, await updateShift(db(c), param(c, 'shiftId'), c.req.valid('json')));
});

shiftsRoutes.delete('/:shiftId', requirePermission('attendance:delete'), async (c) => {
  await deleteShift(db(c), param(c, 'shiftId'));
  return noContent(c);
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

attendanceRoutes.post('/', requirePermission('attendance:create'), zValidator('json', createHrAttendanceSchema), async (c) => {
  const row = await createAttendance(db(c), c.req.valid('json'), { createdBy: actor(c) });
  emit(c, 'hr_attendance', 'created', row.id, { employeeId: row.employeeId, status: row.status });
  return success(c, row, 201);
});

attendanceRoutes.post('/import', requirePermission('attendance:create'), zValidator('json', importHrAttendanceSchema), async (c) => {
  const result = await importAttendance(db(c), c.req.valid('json').rows, actor(c));
  return success(c, result);
});

attendanceRoutes.post(
  '/approve',
  requirePermission('attendance:approve'),
  zValidator('json', z.object({ ids: z.array(z.string().min(1).max(30)).min(1).max(1000) })),
  async (c) => {
    const approved = await approveAttendance(db(c), c.req.valid('json').ids, actor(c));
    for (const row of approved) emit(c, 'hr_attendance', 'approved', row.id, { employeeId: row.employeeId });
    return success(c, { approved: approved.length });
  },
);

attendanceRoutes.patch('/:attendanceId', requirePermission('attendance:update'), zValidator('json', updateHrAttendanceSchema), async (c) => {
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

leaveTypesRoutes.post('/', requirePermission('employees:manage'), zValidator('json', createHrLeaveTypeSchema), async (c) => {
  return success(c, await createLeaveType(db(c), c.req.valid('json')), 201);
});

leaveTypesRoutes.patch('/:leaveTypeId', requirePermission('employees:manage'), zValidator('json', updateHrLeaveTypeSchema), async (c) => {
  return success(c, await updateLeaveType(db(c), param(c, 'leaveTypeId'), c.req.valid('json')));
});

leaveTypesRoutes.delete('/:leaveTypeId', requirePermission('employees:manage'), async (c) => {
  return success(c, await deleteLeaveType(db(c), param(c, 'leaveTypeId')));
});

export const leaveAllowancesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

leaveAllowancesRoutes.get('/balances/:employeeId', requirePermission('leave:read'), async (c) => {
  const year = Number(c.req.query('year')) || new Date().getUTCFullYear();
  return success(c, await leaveBalances(db(c), param(c, 'employeeId'), year));
});

leaveAllowancesRoutes.put('/', requirePermission('leave:update'), zValidator('json', setHrLeaveAllowanceSchema), async (c) => {
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

leaveRequestsRoutes.post('/', requirePermission('leave:create'), zValidator('json', createHrLeaveRequestSchema), async (c) => {
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
  zValidator('json', reviewHrLeaveRequestSchema),
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
