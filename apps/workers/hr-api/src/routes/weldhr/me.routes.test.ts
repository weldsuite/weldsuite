/**
 * Route tests for My HR (/api/weldhr/me), the signed-in member's own employee
 * record, through the whole /api/weldhr router against a real pglite tenant
 * database. Payroll's /me routes (payslips, annual statements, payroll
 * details, tax elections) are tested with payroll.
 *
 * The employee is always the one linked to the caller's Clerk user, never an
 * id from the request: someone else's rows are a 404, and a member without an
 * (active) employee record gets `{ employee: null }` from GET /me and a 404
 * elsewhere.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  HR_ADMIN,
  daysFromToday,
  data,
  errorOf,
  hrCaller,
  hrDb,
  minutesFromNow,
  resetHr,
  seedCompany,
  seedDepartment,
  seedEmployee,
  seedMember,
  today,
} from '../../test/hr-fixtures';

const EMMA = 'user_emma';
const OTTO = 'user_otto';
const MAX = 'user_max';

let db: Database;
let bucket: R2Bucket;

beforeAll(async () => {
  db = await hrDb();
  // The first request seeds the starter leave types, templates, scorecard and KPIs.
  await hrCaller(db).get('/leave-types');
}, 60_000);

beforeEach(async () => {
  await resetHr(db);
  bucket = createMemoryR2();
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, EMMA, { name: 'Emma Employee', email: 'emma@example.com', memberType: 'EMPLOYEE' });
  await seedMember(db, OTTO, { name: 'Otto Other', email: 'otto@example.com' });
  await seedMember(db, MAX, { name: 'Max Manager', email: 'max@example.com' });
  await seedDepartment(db, 'hrdep_co', 'Company');
  await seedDepartment(db, 'hrdep_ops', 'Operations', 'hrdep_co');
  await seedDepartment(db, 'hrdep_fin', 'Finance', 'hrdep_co');
  await seedCompany(db, 'co_acme', 'Acme');
  await seedEmployee(db, { id: 'hremp_max', userId: MAX, email: 'max@example.com', firstName: 'Max', lastName: 'Mann', departmentId: 'hrdep_co' });
  await seedEmployee(db, {
    id: 'hremp_emma',
    userId: EMMA,
    email: 'emma@example.com',
    firstName: 'Emma',
    lastName: 'Evers',
    employeeNumber: 'E-1',
    jobTitle: 'Agent',
    departmentId: 'hrdep_ops',
    managerId: 'hremp_max',
    location: 'Amsterdam',
  });
  await seedEmployee(db, { id: 'hremp_otto', userId: OTTO, email: 'otto@example.com', firstName: 'Otto', lastName: 'Olsen', departmentId: 'hrdep_fin' });
  await db.insert(schema.hrClientAssignments).values({
    id: 'hrasg_me1',
    employeeId: 'hremp_emma',
    companyId: 'co_acme',
    startDate: daysFromToday(-30),
    isPrimary: true,
  });
});

/** My HR as `userId`, holding only employees:self. */
const me = (userId = EMMA, grants = ['employees:self']) => hrCaller(db, { userId, grants, env: { STORAGE: bucket } });

/** The self-service switches, replacing the row a request may already have created. */
async function settings(fields: Partial<typeof schema.hrSettings.$inferInsert>) {
  await db.delete(schema.hrSettings);
  await db.insert(schema.hrSettings).values({ id: 'hrset_t1', ...fields });
}

const at = (date: string, time: string) => `${date}T${time}:00.000Z`;

// ---------------------------------------------------------------------------
// Profile, gate and linking
// ---------------------------------------------------------------------------

describe('GET /me', () => {
  it('answers my profile and what I may do myself', async () => {
    const res = await me().get('/me');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      employee: {
        id: 'hremp_emma',
        displayName: 'Emma Evers',
        firstName: 'Emma',
        lastName: 'Evers',
        email: 'emma@example.com',
        phone: null,
        avatarUrl: null,
        jobTitle: 'Agent',
        employeeNumber: 'E-1',
        status: 'active',
        employmentType: 'full_time',
        startDate: '2025-01-06',
        location: 'Amsterdam',
        departmentName: 'Operations',
        manager: { displayName: 'Max Mann', email: 'max@example.com' },
        clients: [{ companyId: 'co_acme', companyName: 'Acme', isPrimary: true }],
      },
      features: { selfClockIn: true, clockInRequiresLocation: false, leaveRequests: true, declarations: true },
    });
  });

  it('follows the self-service switches', async () => {
    await settings({ employeeSelfClockIn: false, clockInRequiresLocation: true, employeeLeaveRequests: false, employeeDeclarations: false });
    expect((await data<{ features: unknown }>(await me().get('/me'))).features).toEqual({
      selfClockIn: false,
      clockInRequiresLocation: true,
      leaveRequests: false,
      declarations: false,
    });
  });

  it('answers no employee for a member without one, or with a terminated one', async () => {
    await seedMember(db, 'user_nina', { name: 'Nina None', email: 'nina@example.com' });
    expect((await data<{ employee: unknown }>(await me('user_nina').get('/me'))).employee).toBeNull();

    await db.update(schema.hrEmployees).set({ status: 'terminated' }).where(eq(schema.hrEmployees.id, 'hremp_emma'));
    expect((await data<{ employee: unknown }>(await me().get('/me'))).employee).toBeNull();
  });

  it('links the employee HR added while my invite was pending', async () => {
    await seedMember(db, 'user_liam', { name: 'Liam Late', email: 'liam@example.com' });
    await seedEmployee(db, { id: 'hremp_liam', userId: null, email: 'LIAM@example.com', firstName: 'Liam' });
    const res = await me('user_liam').get('/me', { write: true });
    expect(res.status).toBe(200);
    expect((await data<{ employee: { id: string } }>(res)).employee.id).toBe('hremp_liam');
    const [row] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, 'hremp_liam'));
    expect(row!.userId).toBe('user_liam');
    const audits = await db.select().from(schema.hrAuditEvents).where(eq(schema.hrAuditEvents.employeeId, 'hremp_liam'));
    expect(audits.map((a) => a.action)).toEqual(['employee.linked']);
  });

  it('is refused without employees:self', async () => {
    const res = await me(EMMA, ['employees:read']).get('/me');
    expect(res.status).toBe(403);
    expect((await me(EMMA, ['employees:read']).get('/me/overview')).status).toBe(403);
    expect((await me(EMMA, ['employees:read']).send('POST', '/me/clock', { action: 'in' })).status).toBe(403);
  });

  it('is a 404 everywhere else for a member without an employee', async () => {
    await seedMember(db, 'user_nina', { name: 'Nina None', email: 'nina@example.com' });
    const res = await me('user_nina').get('/me/overview');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: "Employee with ID 'me' not found" });
    expect((await me('user_nina').get('/me/leave')).status).toBe(404);
    expect((await me('user_nina').send('POST', '/me/clock', { action: 'in' })).status).toBe(404);
  });
});

describe('GET /me/overview', () => {
  it('rolls up my clock, shifts, leave, tasks, reviews, milestones, announcements and open shifts', async () => {
    await db.insert(schema.hrShifts).values([
      { id: 'hrshf_o1', employeeId: 'hremp_emma', companyId: 'co_acme', startsAt: new Date(at(daysFromToday(1), '09:00')), endsAt: new Date(at(daysFromToday(1), '17:00')) },
      { id: 'hrshf_o2', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(20), '09:00')), endsAt: new Date(at(daysFromToday(20), '17:00')) },
    ]);
    await db.insert(schema.hrAttendanceRecords).values({
      id: 'hratt_o1',
      employeeId: 'hremp_emma',
      date: today(),
      clockIn: new Date('2026-01-01T08:00:00.000Z'),
      source: 'portal',
    });
    await db.insert(schema.hrLeaveRequests).values({
      id: 'hrlvr_o1',
      employeeId: 'hremp_emma',
      leaveTypeId: 'hrlvt_default_annual',
      startDate: `${today().slice(0, 4)}-12-21`,
      endDate: `${today().slice(0, 4)}-12-22`,
      days: 2,
      status: 'pending',
    });
    await db.insert(schema.hrChecklists).values({ id: 'hrchk_o1', employeeId: 'hremp_emma', kind: 'onboarding', name: 'Welcome' });
    await db.insert(schema.hrChecklistTasks).values([
      { id: 'hrtsk_o1', checklistId: 'hrchk_o1', employeeId: 'hremp_emma', title: 'Profile', assigneeRole: 'employee', visibleToEmployee: true },
      { id: 'hrtsk_o2', checklistId: 'hrchk_o1', employeeId: 'hremp_emma', title: 'Laptop', assigneeRole: 'it', visibleToEmployee: true, completedAt: new Date('2026-01-02T00:00:00Z') },
      { id: 'hrtsk_o3', checklistId: 'hrchk_o1', employeeId: 'hremp_emma', title: 'Hidden', assigneeRole: 'hr', visibleToEmployee: false },
    ]);
    await db.insert(schema.hrCoachingLogs).values([
      { id: 'hrcch_o1', employeeId: 'hremp_emma', sessionDate: daysFromToday(-3), topic: 'Calls', visibility: 'employee' },
      { id: 'hrcch_o2', employeeId: 'hremp_emma', sessionDate: daysFromToday(-4), topic: 'Internal', visibility: 'internal' },
    ]);
    await db.insert(schema.hrEvaluations).values({
      id: 'hrevl_o1',
      employeeId: 'hremp_emma',
      formId: 'hrevf_default_scorecard',
      status: 'submitted',
      overallScore: 76,
      submittedAt: new Date('2026-02-01T10:00:00.000Z'),
    });
    await db.insert(schema.hrMilestones).values([
      { id: 'hrmil_o1', employeeId: 'hremp_emma', title: 'Certified', status: 'achieved', achievedAt: '2026-01-15' },
      { id: 'hrmil_o2', employeeId: 'hremp_emma', title: 'Mentor', status: 'in_progress' },
    ]);
    await db.insert(schema.hrAnnouncements).values([
      { id: 'hrann_o1', title: 'Hello', body: 'All hands', publishedAt: new Date('2026-02-01T09:00:00.000Z') },
      { id: 'hrann_o2', title: 'Finance only', body: 'Numbers', departmentIds: ['hrdep_fin'], publishedAt: new Date('2026-02-02T09:00:00.000Z') },
    ]);
    await db.insert(schema.hrOpenShifts).values({
      id: 'hrosh_o1',
      startsAt: new Date(at(daysFromToday(3), '09:00')),
      endsAt: new Date(at(daysFromToday(3), '17:00')),
    });

    const res = await me().get('/me/overview');
    expect(res.status).toBe(200);
    const body = await data<Record<string, unknown> & { leaveBalances: Array<{ leaveTypeId: string; pending: number }> }>(res);
    expect(body).toMatchObject({
      profile: { id: 'hremp_emma', departmentName: 'Operations' },
      clock: { clockedIn: true, since: '2026-01-01T08:00:00.000Z', shiftId: null },
      upcomingShifts: [{ id: 'hrshf_o1', companyName: 'Acme' }],
      openTasks: 1,
      toAcknowledge: { coaching: 1, evaluations: 1 },
      latestEvaluation: { id: 'hrevl_o1', overallScore: 76, formName: 'Quality scorecard', submittedAt: '2026-02-01T10:00:00.000Z' },
      milestones: { achieved: 1, open: 1 },
      unreadAnnouncements: 1,
      openShifts: 1,
    });
    expect(body.leaveBalances.find((b) => b.leaveTypeId === 'hrlvt_default_annual')?.pending).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Attendance, shift requests, open shifts
// ---------------------------------------------------------------------------

describe('GET /me/attendance', () => {
  beforeEach(async () => {
    await db.insert(schema.hrCompensations).values([
      { id: 'hrcmp_a1', employeeId: 'hremp_emma', effectiveFrom: '2025-01-01', effectiveTo: daysFromToday(-11), payType: 'hourly', amount: '18.5000', period: 'hour', currency: 'EUR' },
      { id: 'hrcmp_a2', employeeId: 'hremp_emma', effectiveFrom: daysFromToday(-10), payType: 'salary', amount: '4160.0000', period: 'month', currency: 'EUR', hoursPerWeek: 40 },
    ]);
    await db.insert(schema.hrAttendanceRecords).values([
      { id: 'hratt_a1', employeeId: 'hremp_emma', companyId: 'co_acme', date: daysFromToday(-15), clockIn: new Date(at(daysFromToday(-15), '08:00')), clockOut: new Date(at(daysFromToday(-15), '16:30')), breakMinutes: 30, workedMinutes: 480, approvedAt: new Date('2026-02-01T00:00:00Z'), approvedBy: HR_ADMIN },
      { id: 'hratt_a2', employeeId: 'hremp_emma', date: daysFromToday(-2), clockIn: new Date(at(daysFromToday(-2), '09:10')), clockOut: new Date(at(daysFromToday(-2), '17:00')), workedMinutes: 470, lateMinutes: 10, status: 'late', source: 'portal', notes: 'Train delay' },
      { id: 'hratt_a3', employeeId: 'hremp_emma', date: daysFromToday(-60), clockIn: new Date(at(daysFromToday(-60), '09:00')) },
      { id: 'hratt_a4', employeeId: 'hremp_otto', date: daysFromToday(-2), clockIn: new Date(at(daysFromToday(-2), '09:00')) },
    ]);
    await db.insert(schema.hrShifts).values({
      id: 'hrshf_a1',
      employeeId: 'hremp_emma',
      companyId: 'co_acme',
      startsAt: new Date(at(daysFromToday(3), '09:00')),
      endsAt: new Date(at(daysFromToday(3), '17:00')),
      workType: 'Cashier',
      breakStartsAt: new Date(at(daysFromToday(3), '12:00')),
      breakEndsAt: new Date(at(daysFromToday(3), '12:30')),
    });
    await db.insert(schema.hrShiftRequests).values([
      { id: 'hrsrq_a1', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(5), '09:00')), endsAt: new Date(at(daysFromToday(5), '13:00')), status: 'pending', note: 'Mornings' },
      { id: 'hrsrq_a2', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(6), '09:00')), endsAt: new Date(at(daysFromToday(6), '13:00')), status: 'rejected', reviewedBy: HR_ADMIN, reviewedAt: new Date('2026-02-03T00:00:00Z'), reviewNote: 'Full' },
      { id: 'hrsrq_a3', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(7), '09:00')), endsAt: new Date(at(daysFromToday(7), '13:00')), status: 'cancelled' },
    ]);
  });

  it('answers my records and shifts with the hourly rate of their day, and my open requests', async () => {
    const res = await me().get('/me/attendance');
    expect(res.status).toBe(200);
    const body = await data<{
      records: Array<{ id: string; hourlyRate: number | null; currency: string | null; approved: boolean; companyName: string | null }>;
      shifts: Array<{ id: string; hourlyRate: number | null; workType: string | null; breakStartsAt: string | null }>;
      requests: Array<{ id: string; status: string; reviewedByName: string | null }>;
    }>(res);
    expect(body.records.map((r) => [r.id, r.hourlyRate, r.currency, r.approved])).toEqual([
      ['hratt_a2', 24, 'EUR', false],
      ['hratt_a1', 18.5, 'EUR', true],
    ]);
    expect(body.records[1]!.companyName).toBe('Acme');
    expect(body.shifts).toEqual([
      {
        hourlyRate: 24,
        currency: 'EUR',
        id: 'hrshf_a1',
        startsAt: at(daysFromToday(3), '09:00'),
        endsAt: at(daysFromToday(3), '17:00'),
        workType: 'Cashier',
        breakStartsAt: at(daysFromToday(3), '12:00'),
        breakEndsAt: at(daysFromToday(3), '12:30'),
        companyName: 'Acme',
        notes: null,
      },
    ]);
    expect(body.requests.map((r) => [r.id, r.status, r.reviewedByName])).toEqual([
      ['hrsrq_a2', 'rejected', 'Hanna Admin'],
      ['hrsrq_a1', 'pending', null],
    ]);
  });

  it('takes a range of at most 92 days', async () => {
    const custom = await me().get(`/me/attendance?from=${daysFromToday(-61)}&to=${daysFromToday(-59)}`);
    expect((await data<{ records: Array<{ id: string }> }>(custom)).records.map((r) => r.id)).toEqual(['hratt_a3']);

    const tooLong = await me().get(`/me/attendance?from=${daysFromToday(-100)}&to=${today()}`);
    expect(tooLong.status).toBe(400);
    expect((await errorOf(tooLong)).message).toBe('Pick a range of at most 92 days');
    expect((await me().get(`/me/attendance?from=${today()}&to=${daysFromToday(-1)}`)).status).toBe(400);
  });
});

describe('/me/shift-requests', () => {
  const ahead = (day: number, from: string, to: string) => ({ startsAt: at(daysFromToday(day), from), endsAt: at(daysFromToday(day), to) });

  it('asks for a shift and withdraws it', async () => {
    const res = await me().send('POST', '/me/shift-requests', { ...ahead(5, '08:00', '12:00'), workType: ' Cashier ', note: ' Can do ' });
    expect(res.status).toBe(201);
    const request = await data<{ id: string }>(res);
    expect(request).toMatchObject({
      openShiftId: null,
      startsAt: at(daysFromToday(5), '08:00'),
      workType: 'Cashier',
      note: 'Can do',
      status: 'pending',
      reviewedAt: null,
      reviewedByName: null,
      reviewNote: null,
    });

    const cancelled = await me().send('POST', `/me/shift-requests/${request.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((await data<{ status: string }>(cancelled)).status).toBe('cancelled');
    const again = await me().send('POST', `/me/shift-requests/${request.id}/cancel`);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This request is already cancelled');
  });

  it('refuses the past, a clash with my shifts or my waiting requests, and bad input', async () => {
    const past = await me().send('POST', '/me/shift-requests', { startsAt: at(daysFromToday(-1), '08:00'), endsAt: at(daysFromToday(-1), '12:00') });
    expect(past.status).toBe(400);
    expect((await errorOf(past)).message).toBe('Ask for a shift that has not started yet');

    await db.insert(schema.hrShifts).values({ id: 'hrshf_r1', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(5), '10:00')), endsAt: new Date(at(daysFromToday(5), '14:00')) });
    const shift = await me().send('POST', '/me/shift-requests', ahead(5, '08:00', '12:00'));
    expect(shift.status).toBe(409);
    expect((await errorOf(shift)).message).toBe('You already have a shift at this time');

    await db.insert(schema.hrShiftRequests).values({ id: 'hrsrq_r1', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(6), '10:00')), endsAt: new Date(at(daysFromToday(6), '14:00')) });
    const waiting = await me().send('POST', '/me/shift-requests', ahead(6, '12:00', '16:00'));
    expect(waiting.status).toBe(409);
    expect((await errorOf(waiting)).message).toBe('You already asked for a shift at this time');

    const long = await me().send('POST', '/me/shift-requests', { startsAt: at(daysFromToday(8), '08:00'), endsAt: at(daysFromToday(9), '09:00') });
    expect(long.status).toBe(400);
    expect((await errorOf(long)).message).toBe('A shift cannot be longer than 24 hours');

    const invalid = await me().send('POST', '/me/shift-requests', { startsAt: 'soon' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Starts at must be a date and time. Ends at is required');
  });

  it("is a 404 for someone else's request", async () => {
    await db.insert(schema.hrShiftRequests).values({ id: 'hrsrq_r2', employeeId: 'hremp_otto', startsAt: new Date(at(daysFromToday(6), '10:00')), endsAt: new Date(at(daysFromToday(6), '14:00')) });
    expect((await me().send('POST', '/me/shift-requests/hrsrq_r2/cancel')).status).toBe(404);
    expect((await me().send('POST', '/me/shift-requests/hrsrq_nope/cancel')).status).toBe(404);
  });
});

describe('/me/open-shifts', () => {
  beforeEach(async () => {
    const shift = (id: string, day: number, fields: Partial<typeof schema.hrOpenShifts.$inferInsert> = {}) => ({
      id,
      startsAt: new Date(at(daysFromToday(day), '09:00')),
      endsAt: new Date(at(daysFromToday(day), '17:00')),
      ...fields,
    });
    await db.insert(schema.hrOpenShifts).values([
      shift('hrosh_co', 3, { departmentId: 'hrdep_co', companyId: 'co_acme', workType: 'Cashier', notes: 'Bring a badge' }),
      shift('hrosh_fin', 4, { departmentId: 'hrdep_fin' }),
      shift('hrosh_two', 5, { spots: 2 }),
      shift('hrosh_full', 6),
      shift('hrosh_gone', 7, { status: 'cancelled' }),
      shift('hrosh_past', -1),
    ]);
    // Otto holds the only spot of `full` and one of `two`.
    await db.insert(schema.hrShifts).values([
      { id: 'hrshf_ot1', employeeId: 'hremp_otto', startsAt: new Date(at(daysFromToday(5), '09:00')), endsAt: new Date(at(daysFromToday(5), '17:00')) },
      { id: 'hrshf_ot2', employeeId: 'hremp_otto', startsAt: new Date(at(daysFromToday(6), '09:00')), endsAt: new Date(at(daysFromToday(6), '17:00')) },
    ]);
    await db.insert(schema.hrShiftRequests).values([
      { id: 'hrsrq_ot1', employeeId: 'hremp_otto', openShiftId: 'hrosh_two', shiftId: 'hrshf_ot1', status: 'approved', startsAt: new Date(at(daysFromToday(5), '09:00')), endsAt: new Date(at(daysFromToday(5), '17:00')) },
      { id: 'hrsrq_ot2', employeeId: 'hremp_otto', openShiftId: 'hrosh_full', shiftId: 'hrshf_ot2', status: 'approved', startsAt: new Date(at(daysFromToday(6), '09:00')), endsAt: new Date(at(daysFromToday(6), '17:00')) },
    ]);
  });

  it('lists the open shifts meant for me that still have a spot', async () => {
    const res = await me().get('/me/open-shifts');
    expect(res.status).toBe(200);
    const shifts = await data<Array<{ id: string; spotsLeft: number; myRequest: unknown }>>(res);
    expect(shifts.map((s) => [s.id, s.spotsLeft])).toEqual([
      ['hrosh_co', 1],
      ['hrosh_two', 1],
    ]);
    expect(shifts[0]).toEqual({
      id: 'hrosh_co',
      startsAt: at(daysFromToday(3), '09:00'),
      endsAt: at(daysFromToday(3), '17:00'),
      workType: 'Cashier',
      breakStartsAt: null,
      breakEndsAt: null,
      notes: 'Bring a badge',
      companyName: 'Acme',
      departmentName: 'Company',
      spots: 1,
      spotsLeft: 1,
      myRequest: null,
    });
  });

  it('signs me up with the open shift times, and shows my sign-up', async () => {
    const res = await me().send('POST', '/me/open-shifts/hrosh_co/sign-up', { note: 'Happy to' });
    expect(res.status).toBe(201);
    const request = await data<{ id: string }>(res);
    expect(request).toMatchObject({
      openShiftId: 'hrosh_co',
      startsAt: at(daysFromToday(3), '09:00'),
      endsAt: at(daysFromToday(3), '17:00'),
      workType: 'Cashier',
      note: 'Happy to',
      status: 'pending',
    });
    const listed = await data<Array<{ id: string; myRequest: unknown }>>(await me().get('/me/open-shifts'));
    expect(listed.find((s) => s.id === 'hrosh_co')?.myRequest).toEqual({ id: request.id, status: 'pending', reviewNote: null });

    const again = await me().send('POST', '/me/open-shifts/hrosh_co/sign-up', {});
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('You already signed up for this shift');
  });

  it('refuses another department, a withdrawn, a full and a started shift', async () => {
    expect((await me().send('POST', '/me/open-shifts/hrosh_fin/sign-up', {})).status).toBe(404);
    expect((await me().send('POST', '/me/open-shifts/hrosh_nope/sign-up', {})).status).toBe(404);
    const gone = await me().send('POST', '/me/open-shifts/hrosh_gone/sign-up', {});
    expect(gone.status).toBe(409);
    expect((await errorOf(gone)).message).toBe('This open shift was withdrawn');
    const full = await me().send('POST', '/me/open-shifts/hrosh_full/sign-up', {});
    expect(full.status).toBe(409);
    expect((await errorOf(full)).message).toBe('All spots on this shift are filled');
    const started = await me().send('POST', '/me/open-shifts/hrosh_past/sign-up', {});
    expect(started.status).toBe(400);
    expect((await errorOf(started)).message).toBe('This shift has already started');
    const invalid = await me().send('POST', '/me/open-shifts/hrosh_co/sign-up', { note: 5 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Note has the wrong type');
  });
});

// ---------------------------------------------------------------------------
// Clocking
// ---------------------------------------------------------------------------

describe('POST /me/clock', () => {
  it('clocks in and out', async () => {
    const clockIn = await me().send('POST', '/me/clock', { action: 'in' });
    expect(clockIn.status).toBe(200);
    const opened = await data<{ id: string; clockIn: string; clockOut: string | null }>(clockIn);
    expect(opened).toMatchObject({ date: today(), clockOut: null, status: 'present', workedMinutes: null, lateMinutes: 0 });

    const twice = await me().send('POST', '/me/clock', { action: 'in' });
    expect(twice.status).toBe(409);
    expect((await errorOf(twice)).message).toBe('You are already clocked in');

    const clockOut = await me().send('POST', '/me/clock', { action: 'out' });
    expect(clockOut.status).toBe(200);
    const closed = await data<{ id: string; clockOut: string | null; workedMinutes: number }>(clockOut);
    expect(closed.id).toBe(opened.id);
    expect(closed.clockOut).not.toBeNull();
    expect(closed.workedMinutes).toBe(0);

    const out = await me().send('POST', '/me/clock', { action: 'out' });
    expect(out.status).toBe(409);
    expect((await errorOf(out)).message).toBe('You are not clocked in');

    const [row] = await db.select().from(schema.hrAttendanceRecords).where(eq(schema.hrAttendanceRecords.id, opened.id));
    expect(row).toMatchObject({ source: 'portal', createdBy: EMMA, employeeId: 'hremp_emma' });
  });

  it("clocks in on today's next shift and switches to another", async () => {
    await db.insert(schema.hrShifts).values([
      { id: 'hrshf_c1', employeeId: 'hremp_emma', companyId: 'co_acme', startsAt: new Date(minutesFromNow(5)), endsAt: new Date(minutesFromNow(25)) },
      { id: 'hrshf_c2', employeeId: 'hremp_emma', startsAt: new Date(minutesFromNow(30)), endsAt: new Date(minutesFromNow(50)) },
    ]);
    const clockIn = await me().send('POST', '/me/clock', { action: 'in' });
    expect(clockIn.status).toBe(200);
    const opened = await data<{ id: string }>(clockIn);
    const [row] = await db.select().from(schema.hrAttendanceRecords).where(eq(schema.hrAttendanceRecords.id, opened.id));
    expect(row).toMatchObject({ shiftId: 'hrshf_c1', companyId: 'co_acme', lateMinutes: 0, status: 'present' });

    const same = await me().send('POST', '/me/clock', { action: 'switch', shiftId: 'hrshf_c1' });
    expect(same.status).toBe(409);
    expect((await errorOf(same)).message).toBe('You are already on this shift');
    const none = await me().send('POST', '/me/clock', { action: 'switch' });
    expect(none.status).toBe(400);
    expect((await errorOf(none)).message).toBe('Pick the shift to switch to');

    const switched = await me().send('POST', '/me/clock', { action: 'switch', shiftId: 'hrshf_c2' });
    expect(switched.status).toBe(200);
    const next = await data<{ id: string; clockOut: string | null }>(switched);
    expect(next.id).not.toBe(opened.id);
    expect(next.clockOut).toBeNull();
    const records = await db.select().from(schema.hrAttendanceRecords).where(eq(schema.hrAttendanceRecords.employeeId, 'hremp_emma'));
    expect(records.map((r) => [r.shiftId, r.clockOut === null]).sort()).toEqual([
      ['hrshf_c1', false],
      ['hrshf_c2', true],
    ]);
  });

  it('refuses a shift that ended, one that is not today, and an unknown one', async () => {
    await db.insert(schema.hrShifts).values([
      { id: 'hrshf_c3', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(-1), '08:00')), endsAt: new Date(at(daysFromToday(-1), '12:00')) },
      { id: 'hrshf_c4', employeeId: 'hremp_emma', startsAt: new Date(at(daysFromToday(2), '08:00')), endsAt: new Date(at(daysFromToday(2), '12:00')) },
      { id: 'hrshf_c5', employeeId: 'hremp_otto', startsAt: new Date(at(daysFromToday(2), '08:00')), endsAt: new Date(at(daysFromToday(2), '12:00')) },
    ]);
    const ended = await me().send('POST', '/me/clock', { action: 'in', shiftId: 'hrshf_c3' });
    expect(ended.status).toBe(400);
    expect((await errorOf(ended)).message).toBe('That shift has already ended');
    const later = await me().send('POST', '/me/clock', { action: 'in', shiftId: 'hrshf_c4' });
    expect(later.status).toBe(400);
    expect((await errorOf(later)).message).toBe('That shift is not today');
    expect((await me().send('POST', '/me/clock', { action: 'in', shiftId: 'hrshf_c5' })).status).toBe(404);
    const invalid = await me().send('POST', '/me/clock', { action: 'pause' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Action must be one of in, out, switch');
  });

  it('is refused while clocking in yourself is turned off', async () => {
    await settings({ employeeSelfClockIn: false });
    const res = await me().send('POST', '/me/clock', { action: 'in' });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe('Clocking in yourself is turned off');
  });

  it('needs the device at one of my work locations while a location is required', async () => {
    await settings({ clockInRequiresLocation: true });
    const missing = await me().send('POST', '/me/clock', { action: 'in' });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Share your location to clock in or out here',
      details: { code: 'LOCATION_REQUIRED' },
    });

    const noLocations = await me().send('POST', '/me/clock', { action: 'in', location: { latitude: 52.3676, longitude: 4.9041 } });
    expect(noLocations.status).toBe(400);
    expect((await errorOf(noLocations)).details).toEqual({ code: 'NO_WORK_LOCATION' });

    await db.insert(schema.hrWorkLocations).values([
      { id: 'hrloc_ams', name: 'Amsterdam office', latitude: 52.3676, longitude: 4.9041, radiusMeters: 150 },
      { id: 'hrloc_rtm', name: 'Rotterdam office', latitude: 51.9244, longitude: 4.4777, radiusMeters: 150 },
    ]);
    const far = await me().send('POST', '/me/clock', { action: 'in', location: { latitude: 52.38, longitude: 4.9041, accuracy: 20 } });
    expect(far.status).toBe(400);
    const farError = await errorOf(far);
    expect(farError.message).toMatch(/^You are not at a work location\. The nearest, Amsterdam office, is 1\.4 km away\.$/);
    expect(farError.details).toMatchObject({ code: 'NOT_AT_WORK_LOCATION', nearest: 'Amsterdam office', distanceMeters: 1379 });

    // Emma may only clock in at Rotterdam.
    await db.update(schema.hrEmployees).set({ workLocationIds: ['hrloc_rtm'] }).where(eq(schema.hrEmployees.id, 'hremp_emma'));
    const notHers = await me().send('POST', '/me/clock', { action: 'in', location: { latitude: 52.3676, longitude: 4.9041 } });
    expect(notHers.status).toBe(400);
    expect((await errorOf(notHers)).message).toMatch(/The nearest, Rotterdam office, is [\d.]+ km away\.$/);

    const there = await me().send('POST', '/me/clock', { action: 'in', location: { latitude: 51.9245, longitude: 4.4778, accuracy: 5 } });
    expect(there.status).toBe(200);
    const record = await data<{ id: string }>(there);
    const [row] = await db.select().from(schema.hrAttendanceRecords).where(eq(schema.hrAttendanceRecords.id, record.id));
    expect(row).toMatchObject({ clockInLocationId: 'hrloc_rtm', clockInLatitude: 51.9245, clockInLongitude: 4.4778 });

    const out = await me().send('POST', '/me/clock', { action: 'out', location: { latitude: 51.9244, longitude: 4.4777 } });
    expect(out.status).toBe(200);
    const [closed] = await db.select().from(schema.hrAttendanceRecords).where(eq(schema.hrAttendanceRecords.id, record.id));
    expect(closed).toMatchObject({ clockOutLocationId: 'hrloc_rtm', clockOutLatitude: 51.9244 });
  });
});

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

describe('/me/leave', () => {
  const year = () => Number(today().slice(0, 4));

  it('answers the leave types, my balances and my requests', async () => {
    await db.insert(schema.hrLeaveRequests).values([
      { id: 'hrlvr_l1', employeeId: 'hremp_emma', leaveTypeId: 'hrlvt_default_annual', startDate: `${year()}-03-02`, endDate: `${year()}-03-03`, days: 2, status: 'approved', reviewedBy: HR_ADMIN, reviewedAt: new Date('2026-02-01T00:00:00Z'), reviewNote: 'Enjoy' },
      { id: 'hrlvr_l2', employeeId: 'hremp_otto', leaveTypeId: 'hrlvt_default_annual', startDate: `${year()}-03-02`, endDate: `${year()}-03-03`, days: 2, status: 'approved' },
    ]);
    const res = await me().get('/me/leave');
    expect(res.status).toBe(200);
    const body = await data<{
      types: Array<{ id: string }>;
      balances: Array<{ leaveTypeId: string; allowance: number | null; used: number; remaining: number | null }>;
      requests: Array<Record<string, unknown>>;
    }>(res);
    expect(body.types.map((t) => t.id)).toEqual(['hrlvt_default_annual', 'hrlvt_default_sick', 'hrlvt_default_unpaid']);
    expect(body.balances.find((b) => b.leaveTypeId === 'hrlvt_default_annual')).toMatchObject({ allowance: 20, used: 2, remaining: 18 });
    expect(body.requests).toEqual([
      expect.objectContaining({
        id: 'hrlvr_l1',
        leaveTypeName: 'Annual leave',
        leaveTypeColor: '#3b82f6',
        days: 2,
        status: 'approved',
        reviewNote: 'Enjoy',
        reviewedByName: 'Hanna Admin',
      }),
    ]);
  });

  it('requests leave, and an auto-approved type is approved straight away', async () => {
    const res = await me().send('POST', '/me/leave', {
      leaveTypeId: 'hrlvt_default_annual',
      startDate: daysFromToday(30),
      endDate: daysFromToday(30),
      reason: 'Wedding',
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ employeeId: 'hremp_emma', status: 'pending', requestedBy: EMMA, reason: 'Wedding' });

    const sick = await me().send('POST', '/me/leave', { leaveTypeId: 'hrlvt_default_sick', startDate: daysFromToday(60), endDate: daysFromToday(62) });
    expect(sick.status).toBe(201);
    expect((await data<{ status: string }>(sick)).status).toBe('approved');
  });

  it('is refused while leave requests are turned off, and validates', async () => {
    const invalid = await me().send('POST', '/me/leave', { leaveTypeId: 'hrlvt_default_annual', startDate: 'monday' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Start date: Expected YYYY-MM-DD. End date is required');

    await settings({ employeeLeaveRequests: false });
    const off = await me().send('POST', '/me/leave', { leaveTypeId: 'hrlvt_default_annual', startDate: daysFromToday(30), endDate: daysFromToday(30) });
    expect(off.status).toBe(403);
    expect((await errorOf(off)).message).toBe('Leave requests are turned off');
  });

  it('withdraws my own request, but not leave that has started', async () => {
    await db.insert(schema.hrLeaveRequests).values([
      { id: 'hrlvr_l3', employeeId: 'hremp_emma', leaveTypeId: 'hrlvt_default_annual', startDate: daysFromToday(10), endDate: daysFromToday(10), days: 1, status: 'pending' },
      { id: 'hrlvr_l4', employeeId: 'hremp_emma', leaveTypeId: 'hrlvt_default_annual', startDate: daysFromToday(-1), endDate: daysFromToday(1), days: 2, status: 'approved' },
      { id: 'hrlvr_l5', employeeId: 'hremp_otto', leaveTypeId: 'hrlvt_default_annual', startDate: daysFromToday(10), endDate: daysFromToday(10), days: 1, status: 'pending' },
    ]);
    const res = await me().send('POST', '/me/leave/hrlvr_l3/cancel');
    expect(res.status).toBe(200);
    expect((await data<{ status: string }>(res)).status).toBe('cancelled');
    const again = await me().send('POST', '/me/leave/hrlvr_l3/cancel');
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This request is already cancelled');

    const started = await me().send('POST', '/me/leave/hrlvr_l4/cancel');
    expect(started.status).toBe(409);
    expect((await errorOf(started)).message).toBe('Leave that has started can only be cancelled by HR');

    expect((await me().send('POST', '/me/leave/hrlvr_l5/cancel')).status).toBe(404);
    expect((await me().send('POST', '/me/leave/hrlvr_nope/cancel')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

describe('/me/declarations', () => {
  const receipt = (name = 'taxi.pdf', type = 'application/pdf') => new File([new Uint8Array([37, 80, 68, 70, 45])], name, { type });

  it('lists my declarations with what is still open per currency', async () => {
    await db.insert(schema.hrDeclarations).values([
      { id: 'hrdcl_m1', employeeId: 'hremp_emma', expenseDate: daysFromToday(-3), category: 'travel', description: 'Taxi', amount: '23.40', status: 'pending', createdAt: new Date('2026-02-01T10:00:00Z') },
      { id: 'hrdcl_m2', employeeId: 'hremp_emma', expenseDate: daysFromToday(-3), category: 'meals', description: 'Lunch', amount: '10.10', status: 'pending', createdAt: new Date('2026-02-01T11:00:00Z') },
      { id: 'hrdcl_m3', employeeId: 'hremp_emma', expenseDate: daysFromToday(-5), category: 'equipment', description: 'Mouse', amount: '40.00', currency: 'USD', status: 'approved', reviewedAt: new Date('2026-02-02T00:00:00Z'), reviewNote: 'OK' },
      { id: 'hrdcl_m4', employeeId: 'hremp_emma', expenseDate: daysFromToday(-9), category: 'other', description: 'Paid', amount: '5.00', status: 'paid', paidAt: new Date('2026-02-03T00:00:00Z') },
      { id: 'hrdcl_m5', employeeId: 'hremp_otto', expenseDate: daysFromToday(-3), category: 'travel', description: 'Not mine', amount: '99.00' },
    ]);
    const res = await me().get('/me/declarations');
    expect(res.status).toBe(200);
    const body = await data<{ declarations: Array<{ id: string; amount: number }>; open: unknown }>(res);
    expect(body.declarations.map((d) => [d.id, d.amount])).toEqual([
      ['hrdcl_m2', 10.1],
      ['hrdcl_m1', 23.4],
      ['hrdcl_m3', 40],
      ['hrdcl_m4', 5],
    ]);
    expect(body.open).toEqual([
      { currency: 'EUR', pending: 33.5, approved: 0 },
      { currency: 'USD', pending: 0, approved: 40 },
    ]);
  });

  it('files a declaration, attaches its receipt, reads it back and withdraws it', async () => {
    const res = await me().send('POST', '/me/declarations', { expenseDate: daysFromToday(-1), category: 'travel', description: 'Train', amount: 12.5 });
    expect(res.status).toBe(201);
    const declaration = await data<{ id: string }>(res);
    expect(declaration).toMatchObject({ employeeId: 'hremp_emma', amount: 12.5, currency: 'EUR', status: 'pending', hasReceipt: false, submittedBy: EMMA });

    const uploaded = await me().upload(`/me/declarations/${declaration.id}/receipt`, receipt('train ticket.pdf'));
    expect(uploaded.status).toBe(200);
    expect(await data(uploaded)).toMatchObject({ hasReceipt: true, receiptFileName: 'train_ticket.pdf', receiptContentType: 'application/pdf', receiptSize: 5 });

    const file = await me().get(`/me/declarations/${declaration.id}/receipt`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toBe('inline; filename="train_ticket.pdf"');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70, 45]));

    const cancelled = await me().send('POST', `/me/declarations/${declaration.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((await data<{ status: string }>(cancelled)).status).toBe('cancelled');
    const again = await me().send('POST', `/me/declarations/${declaration.id}/cancel`);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This declaration is already cancelled');
  });

  it("keeps me out of someone else's declaration and an approved one", async () => {
    await db.insert(schema.hrDeclarations).values([
      { id: 'hrdcl_m6', employeeId: 'hremp_otto', expenseDate: daysFromToday(-3), category: 'travel', description: 'Not mine', amount: '9.00' },
      { id: 'hrdcl_m7', employeeId: 'hremp_emma', expenseDate: daysFromToday(-3), category: 'travel', description: 'Approved', amount: '9.00', status: 'approved' },
    ]);
    expect((await me().send('POST', '/me/declarations/hrdcl_m6/cancel')).status).toBe(404);
    expect((await me().upload('/me/declarations/hrdcl_m6/receipt', receipt())).status).toBe(404);
    expect((await me().get('/me/declarations/hrdcl_m6/receipt')).status).toBe(404);
    const approved = await me().send('POST', '/me/declarations/hrdcl_m7/cancel');
    expect(approved.status).toBe(409);
    expect((await errorOf(approved)).message).toBe('This declaration is already approved');
    const noReceipt = await me().get('/me/declarations/hrdcl_m7/receipt');
    expect(noReceipt.status).toBe(404);
    expect((await errorOf(noReceipt)).message).toBe("Receipt with ID 'hrdcl_m7' not found");
    const late = await me().upload('/me/declarations/hrdcl_m7/receipt', receipt());
    expect(late.status).toBe(409);
  });

  it('refuses a future expense, bad input, and filing while declarations are turned off', async () => {
    const future = await me().send('POST', '/me/declarations', { expenseDate: daysFromToday(5), category: 'travel', description: 'Later', amount: 1 });
    expect(future.status).toBe(400);
    expect((await errorOf(future)).message).toBe('The expense date cannot be in the future');
    const invalid = await me().send('POST', '/me/declarations', { expenseDate: today(), category: 'fun', description: '', amount: 0 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe(
      'Category must be one of travel, meals, accommodation, equipment, training, other. Description is required. Amount must be more than 0',
    );

    await settings({ employeeDeclarations: false });
    const off = await me().send('POST', '/me/declarations', { expenseDate: today(), category: 'travel', description: 'Taxi', amount: 1 });
    expect(off.status).toBe(403);
    expect((await errorOf(off)).message).toBe('Expense declarations are turned off');
  });
});

// ---------------------------------------------------------------------------
// Sick reports
// ---------------------------------------------------------------------------

describe('/me/absences', () => {
  it('reports me sick, shows it as current, and closes it when I recover', async () => {
    const res = await me().send('POST', '/me/absences', { startDate: daysFromToday(-2), firstDay: 'half', note: ' Call my partner ' });
    expect(res.status).toBe(201);
    const report = await data<{ id: string }>(res);
    expect(report).toMatchObject({ employeeId: 'hremp_emma', endDate: null, firstDay: 'half', note: 'Call my partner', reportedBy: EMMA });

    const twice = await me().send('POST', '/me/absences', { startDate: today() });
    expect(twice.status).toBe(409);
    expect((await errorOf(twice)).message).toBe('There is already an open sick report');

    const current = await data<{ current: { id: string; status: string } | null; history: unknown[] }>(await me().get('/me/absences'));
    expect(current.current).toMatchObject({ id: report.id, status: 'ongoing' });
    expect(current.history).toEqual([]);

    const future = await me().send('POST', `/me/absences/${report.id}/recover`, { endDate: daysFromToday(2) });
    expect(future.status).toBe(400);
    expect((await errorOf(future)).message).toBe('The last sick day cannot be in the future');

    const recovered = await me().send('POST', `/me/absences/${report.id}/recover`, { endDate: daysFromToday(-1) });
    expect(recovered.status).toBe(200);
    expect(await data(recovered)).toMatchObject({ endDate: daysFromToday(-1), recoveredReportedBy: EMMA });
    const again = await me().send('POST', `/me/absences/${report.id}/recover`, { endDate: daysFromToday(-1) });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This sick report is already closed');

    const after = await data<{ current: unknown; history: Array<{ id: string; status: string }> }>(await me().get('/me/absences'));
    expect(after.current).toBeNull();
    expect(after.history.map((h) => [h.id, h.status])).toEqual([[report.id, 'completed']]);
  });

  it('refuses a start in the future or more than four weeks ago, and bad input', async () => {
    const future = await me().send('POST', '/me/absences', { startDate: daysFromToday(1) });
    expect(future.status).toBe(400);
    expect((await errorOf(future)).message).toBe('The first sick day cannot be in the future');
    const old = await me().send('POST', '/me/absences', { startDate: daysFromToday(-40) });
    expect(old.status).toBe(400);
    expect((await errorOf(old)).message).toBe('Ask HR to add a sick report that started more than four weeks ago');
    const invalid = await me().send('POST', '/me/absences', { startDate: today(), firstDay: 'morning' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('First day must be one of full, half');
  });

  it("is a 404 for someone else's report", async () => {
    await db.insert(schema.hrAbsences).values({ id: 'hrabs_m1', employeeId: 'hremp_otto', startDate: daysFromToday(-3) });
    expect((await me().send('POST', '/me/absences/hrabs_m1/recover', { endDate: today() })).status).toBe(404);
    expect((await me().send('POST', '/me/absences/hrabs_nope/recover', { endDate: today() })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tasks, coaching, evaluations, performance
// ---------------------------------------------------------------------------

describe('/me/tasks', () => {
  beforeEach(async () => {
    await db.update(schema.hrEmployees).set({ status: 'onboarding' }).where(eq(schema.hrEmployees.id, 'hremp_emma'));
    await db.insert(schema.hrChecklists).values([
      { id: 'hrchk_t1', employeeId: 'hremp_emma', kind: 'onboarding', name: 'Welcome' },
      { id: 'hrchk_t2', employeeId: 'hremp_emma', kind: 'offboarding', name: 'Old', status: 'cancelled' },
    ]);
    await db.insert(schema.hrChecklistTasks).values([
      { id: 'hrtsk_t1', checklistId: 'hrchk_t1', employeeId: 'hremp_emma', title: 'Fill in your profile', assigneeRole: 'employee', visibleToEmployee: true, dueDate: daysFromToday(1), sortOrder: 0 },
      { id: 'hrtsk_t2', checklistId: 'hrchk_t1', employeeId: 'hremp_emma', title: 'Meet the team', assigneeRole: 'manager', visibleToEmployee: true, dueDate: daysFromToday(2), sortOrder: 1, completedAt: new Date('2026-02-01T00:00:00Z'), completedBy: MAX },
      { id: 'hrtsk_t3', checklistId: 'hrchk_t1', employeeId: 'hremp_emma', title: 'Payroll set-up', assigneeRole: 'hr', visibleToEmployee: false, dueDate: daysFromToday(3), sortOrder: 2, completedAt: new Date('2026-02-01T00:00:00Z') },
      { id: 'hrtsk_t4', checklistId: 'hrchk_t2', employeeId: 'hremp_emma', title: 'Return laptop', assigneeRole: 'employee', visibleToEmployee: true },
      { id: 'hrtsk_t5', checklistId: 'hrchk_ot', employeeId: 'hremp_otto', title: 'Not mine', assigneeRole: 'employee', visibleToEmployee: true },
    ]);
  });

  it('lists the tasks I can see on running checklists', async () => {
    const res = await me().get('/me/tasks');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual([
      {
        id: 'hrtsk_t1',
        title: 'Fill in your profile',
        description: null,
        dueDate: daysFromToday(1),
        assigneeRole: 'employee',
        completedAt: null,
        canComplete: true,
        checklistName: 'Welcome',
        checklistKind: 'onboarding',
      },
      {
        id: 'hrtsk_t2',
        title: 'Meet the team',
        description: null,
        dueDate: daysFromToday(2),
        assigneeRole: 'manager',
        completedAt: '2026-02-01T00:00:00.000Z',
        canComplete: false,
        checklistName: 'Welcome',
        checklistKind: 'onboarding',
      },
    ]);
  });

  it('completing my last task completes the checklist and onboards me; undo reopens it', async () => {
    const done = await me().send('POST', '/me/tasks/hrtsk_t1/complete');
    expect(done.status).toBe(200);
    expect(await data(done)).toEqual({ ok: true, checklistCompleted: true });
    const [emma] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, 'hremp_emma'));
    expect(emma!.status).toBe('active');
    const [task] = await db.select().from(schema.hrChecklistTasks).where(eq(schema.hrChecklistTasks.id, 'hrtsk_t1'));
    expect(task!.completedBy).toBe(EMMA);

    const undone = await me().send('POST', '/me/tasks/hrtsk_t1/complete?undo=true');
    expect(undone.status).toBe(200);
    expect(await data(undone)).toEqual({ ok: true, checklistCompleted: false });
    const [checklist] = await db.select().from(schema.hrChecklists).where(eq(schema.hrChecklists.id, 'hrchk_t1'));
    expect(checklist!.status).toBe('in_progress');
  });

  it("refuses a task that is my team's, hidden from me, or someone else's", async () => {
    const team = await me().send('POST', '/me/tasks/hrtsk_t2/complete');
    expect(team.status).toBe(400);
    expect((await errorOf(team)).message).toBe('This task is completed by your team, not by you');
    expect((await me().send('POST', '/me/tasks/hrtsk_t3/complete')).status).toBe(404);
    expect((await me().send('POST', '/me/tasks/hrtsk_t5/complete')).status).toBe(404);
    const unknown = await me().send('POST', '/me/tasks/hrtsk_nope/complete');
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toBe("Task with ID 'hrtsk_nope' not found");
  });
});

describe('/me/coaching', () => {
  beforeEach(async () => {
    await db.insert(schema.hrCoachingLogs).values([
      { id: 'hrcch_m1', employeeId: 'hremp_emma', coachUserId: MAX, sessionDate: daysFromToday(-2), topic: 'Calls', category: 'quality', visibility: 'employee', actionItems: [{ id: 'a1', text: 'Shadow a senior', done: false }], followUpDate: daysFromToday(12) },
      { id: 'hrcch_m2', employeeId: 'hremp_emma', coachName: 'External coach', sessionDate: daysFromToday(-9), topic: 'Shared', visibility: 'client', status: 'closed' },
      { id: 'hrcch_m3', employeeId: 'hremp_emma', sessionDate: daysFromToday(-1), topic: 'Internal note', visibility: 'internal' },
      { id: 'hrcch_m4', employeeId: 'hremp_otto', sessionDate: daysFromToday(-1), topic: 'Not mine', visibility: 'employee' },
    ]);
  });

  it('lists the sessions shared with me', async () => {
    const res = await me().get('/me/coaching');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual([
      {
        id: 'hrcch_m1',
        sessionDate: daysFromToday(-2),
        category: 'quality',
        topic: 'Calls',
        notes: null,
        actionItems: [{ id: 'a1', text: 'Shadow a senior', done: false }],
        followUpDate: daysFromToday(12),
        status: 'open',
        coachName: 'Max Manager',
        acknowledgedAt: null,
        employeeComment: null,
      },
      expect.objectContaining({ id: 'hrcch_m2', coachName: 'External coach', status: 'closed' }),
    ]);
  });

  it('acknowledges a session once', async () => {
    const res = await me().send('POST', '/me/coaching/hrcch_m1/acknowledge', { comment: 'Thanks' });
    expect(res.status).toBe(200);
    const body = await data<{ id: string; acknowledgedAt: string; status: string }>(res);
    expect(body).toMatchObject({ id: 'hrcch_m1', status: 'acknowledged' });
    expect(body.acknowledgedAt).toEqual(expect.any(String));
    const [row] = await db.select().from(schema.hrCoachingLogs).where(eq(schema.hrCoachingLogs.id, 'hrcch_m1'));
    expect(row!.employeeComment).toBe('Thanks');

    const closed = await me().send('POST', '/me/coaching/hrcch_m2/acknowledge', {});
    expect((await data<{ status: string }>(closed)).status).toBe('closed');

    const again = await me().send('POST', '/me/coaching/hrcch_m1/acknowledge', {});
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('Already acknowledged');
    expect((await me().send('POST', '/me/coaching/hrcch_m3/acknowledge', {})).status).toBe(404);
    expect((await me().send('POST', '/me/coaching/hrcch_m4/acknowledge', {})).status).toBe(404);
    const invalid = await me().send('POST', '/me/coaching/hrcch_m1/acknowledge', { comment: 7 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Comment has the wrong type');
  });
});

describe('/me/evaluations', () => {
  const criteria = [
    { id: 'quality', label: 'Quality', weight: 60, maxScore: 5 },
    { id: 'speed', label: 'Speed', weight: 40, maxScore: 5 },
  ];
  const scores = [
    { criterionId: 'quality', score: 4, comment: 'Good' },
    { criterionId: 'speed', score: 3 },
  ];

  beforeEach(async () => {
    await db.insert(schema.hrEvaluations).values([
      { id: 'hrevl_m1', employeeId: 'hremp_emma', formId: 'hrevf_default_scorecard', evaluatorName: 'Max Mann', criteria, scores, overallScore: 72, status: 'submitted', periodStart: '2026-01-01', periodEnd: '2026-01-31', submittedAt: new Date('2026-02-05T00:00:00Z'), summary: 'Solid', createdAt: new Date('2026-02-05T00:00:00Z') },
      { id: 'hrevl_m2', employeeId: 'hremp_emma', formId: 'hrevf_default_scorecard', criteria, scores: [], status: 'draft', createdAt: new Date('2026-02-06T00:00:00Z') },
      { id: 'hrevl_m3', employeeId: 'hremp_emma', formId: 'hrevf_default_scorecard', evaluatorUserId: MAX, criteria, scores, overallScore: 72, status: 'acknowledged', acknowledgedAt: new Date('2026-01-10T00:00:00Z'), employeeComment: 'Noted', createdAt: new Date('2026-01-05T00:00:00Z') },
      { id: 'hrevl_m4', employeeId: 'hremp_otto', formId: 'hrevf_default_scorecard', criteria, scores, status: 'submitted' },
    ]);
  });

  it('lists my submitted and acknowledged evaluations', async () => {
    const res = await me().get('/me/evaluations');
    expect(res.status).toBe(200);
    const rows = await data<Array<Record<string, unknown>>>(res);
    expect(rows.map((r) => r.id)).toEqual(['hrevl_m1', 'hrevl_m3']);
    expect(rows[0]).toEqual({
      id: 'hrevl_m1',
      formName: 'Quality scorecard',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      criteria,
      scores,
      overallScore: 72,
      summary: 'Solid',
      status: 'submitted',
      evaluatorName: 'Max Mann',
      submittedAt: '2026-02-05T00:00:00.000Z',
      acknowledgedAt: null,
      employeeComment: null,
    });
    expect(rows[1]!.evaluatorName).toBe('Max Manager');
  });

  it('acknowledges a submitted evaluation once, and never a draft', async () => {
    const res = await me().send('POST', '/me/evaluations/hrevl_m1/acknowledge', { comment: 'Agreed' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrevl_m1', status: 'acknowledged' });
    const again = await me().send('POST', '/me/evaluations/hrevl_m3/acknowledge', {});
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('Already acknowledged');
    expect((await me().send('POST', '/me/evaluations/hrevl_m2/acknowledge', {})).status).toBe(404);
    expect((await me().send('POST', '/me/evaluations/hrevl_m4/acknowledge', {})).status).toBe(404);
  });
});

describe('GET /me/performance', () => {
  it('answers my KPI values of the last year and my milestones', async () => {
    await db.insert(schema.hrKpiValues).values([
      { id: 'hrkpv_p1', kpiId: 'hrkpi_default_csat', employeeId: 'hremp_emma', periodStart: daysFromToday(-30), periodEnd: daysFromToday(-1), value: 93 },
      { id: 'hrkpv_p2', kpiId: 'hrkpi_default_aht', employeeId: 'hremp_emma', periodStart: daysFromToday(-30), periodEnd: daysFromToday(-1), value: 400 },
      { id: 'hrkpv_p3', kpiId: 'hrkpi_default_csat', employeeId: 'hremp_emma', periodStart: daysFromToday(-500), periodEnd: daysFromToday(-470), value: 50 },
      { id: 'hrkpv_p4', kpiId: 'hrkpi_default_csat', employeeId: 'hremp_otto', periodStart: daysFromToday(-30), periodEnd: daysFromToday(-1), value: 10 },
    ]);
    await db.insert(schema.hrMilestones).values([
      { id: 'hrmil_p1', employeeId: 'hremp_emma', companyId: 'co_acme', title: 'Certification', type: 'certification', status: 'planned', dueDate: daysFromToday(20) },
      { id: 'hrmil_p2', employeeId: 'hremp_emma', title: 'First month', status: 'achieved', achievedAt: daysFromToday(-5), dueDate: daysFromToday(-5) },
      { id: 'hrmil_p3', employeeId: 'hremp_emma', title: 'Deleted', deletedAt: new Date('2026-02-01T00:00:00Z') },
    ]);
    const res = await me().get('/me/performance');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      kpis: [
        { id: 'hrkpv_p2', kpiId: 'hrkpi_default_aht', kpiName: 'Average handle time', unit: 'seconds', direction: 'lower_better', target: 360, value: 400, onTarget: false, periodStart: daysFromToday(-30), periodEnd: daysFromToday(-1) },
        { id: 'hrkpv_p1', kpiId: 'hrkpi_default_csat', kpiName: 'CSAT', unit: 'percent', direction: 'higher_better', target: 90, value: 93, onTarget: true, periodStart: daysFromToday(-30), periodEnd: daysFromToday(-1) },
      ],
      milestones: [
        { id: 'hrmil_p2', title: 'First month', description: null, type: 'milestone', status: 'achieved', dueDate: daysFromToday(-5), achievedAt: daysFromToday(-5), companyName: null },
        { id: 'hrmil_p1', title: 'Certification', description: null, type: 'certification', status: 'planned', dueDate: daysFromToday(20), achievedAt: null, companyName: 'Acme' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

describe('/me/announcements', () => {
  beforeEach(async () => {
    await db.insert(schema.hrAnnouncements).values([
      { id: 'hrann_m1', title: 'Welcome', body: 'Hello all', createdBy: HR_ADMIN, publishedAt: new Date('2026-02-01T09:00:00.000Z') },
      { id: 'hrann_m2', title: 'Pinned', body: 'Read me', pinned: true, publishedAt: new Date('2026-01-01T09:00:00.000Z') },
      { id: 'hrann_m3', title: 'Company', body: 'Parent department', departmentIds: ['hrdep_co'], publishedAt: new Date('2026-02-02T09:00:00.000Z') },
      { id: 'hrann_m4', title: 'Finance', body: 'Not for me', departmentIds: ['hrdep_fin'], publishedAt: new Date('2026-02-03T09:00:00.000Z') },
      { id: 'hrann_m5', title: 'Deleted', body: 'Gone', deletedAt: new Date('2026-02-04T00:00:00.000Z') },
    ]);
    await db.insert(schema.hrAnnouncementReads).values({ id: 'hranr_m1', announcementId: 'hrann_m1', employeeId: 'hremp_emma', readAt: new Date('2026-02-01T10:00:00.000Z') });
  });

  it('lists what is meant for me, pinned first, with what I read', async () => {
    const res = await me().get('/me/announcements');
    expect(res.status).toBe(200);
    const body = await data<{ announcements: Array<{ id: string; readAt: string | null; createdByName: string | null }>; unread: number }>(res);
    expect(body.announcements.map((a) => [a.id, a.readAt])).toEqual([
      ['hrann_m2', null],
      ['hrann_m3', null],
      ['hrann_m1', '2026-02-01T10:00:00.000Z'],
    ]);
    expect(body.announcements[2]!.createdByName).toBe('Hanna Admin');
    expect(body.unread).toBe(2);
  });

  it('marks one read once, and keeps others out of reach', async () => {
    const res = await me().send('POST', '/me/announcements/hrann_m3/read');
    expect(res.status).toBe(200);
    const read = await data<{ id: string; readAt: string }>(res);
    expect(read.id).toBe('hrann_m3');

    const first = await me().send('POST', '/me/announcements/hrann_m1/read');
    expect(await data(first)).toEqual({ id: 'hrann_m1', readAt: '2026-02-01T10:00:00.000Z' });

    expect((await me().send('POST', '/me/announcements/hrann_m4/read')).status).toBe(404);
    expect((await me().send('POST', '/me/announcements/hrann_m5/read')).status).toBe(404);
    expect((await me().send('POST', '/me/announcements/hrann_nope/read')).status).toBe(404);
    expect((await data<{ unread: number }>(await me().get('/me/announcements'))).unread).toBe(1);
  });
});
