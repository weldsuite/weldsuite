/**
 * Route tests for WeldHR time: /shifts, /shift-requests, /open-shifts,
 * /work-locations, /attendance, /leave-types, /leave-allowances and
 * /leave-requests, against a real pglite tenant database through the whole
 * /api/weldhr router.
 *
 * These are the requests the Rust port (rust/modules/hr) is compared on in
 * conformance mode, refusals included. Shifts and attendance use fixed past
 * dates (Monday 2 March 2026), so worked and late minutes never depend on the
 * clock; open shifts are posted ahead of now, as the route requires.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  HR_ADMIN,
  daysFromToday,
  data,
  errorOf,
  hrCaller,
  hrDb,
  resetHr,
  seedCompany,
  seedDepartment,
  seedEmployee,
  seedMember,
} from '../../test/hr-fixtures';

let db: Database;

beforeAll(async () => {
  db = await hrDb();
  // The first request seeds the starter leave types (and templates, scorecard,
  // KPIs); the tests below file leave against `hrlvt_default_*`.
  await hrCaller(db).get('/leave-types');
}, 60_000);

beforeEach(async () => {
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedCompany(db, 'co_acme', 'Acme');
  await seedEmployee(db, { id: 'hremp_ann', firstName: 'Ann', lastName: 'Anders', email: 'ann@example.com', employeeNumber: 'E-001' });
  await seedEmployee(db, { id: 'hremp_ben', firstName: 'Ben', lastName: 'Berg', email: 'ben@example.com', employeeNumber: 'E-002' });
});

const admin = () => hrCaller(db);
const as = (...grants: string[]) => hrCaller(db, { grants });

const SEEDED_AT = new Date('2026-01-05T09:00:00.000Z');

async function seedShift(
  id: string,
  employeeId: string,
  startsAt: string,
  endsAt: string,
  fields: Partial<typeof schema.hrShifts.$inferInsert> = {},
) {
  await db.insert(schema.hrShifts).values({
    id,
    employeeId,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    ...fields,
  });
}

async function seedShiftRequest(
  id: string,
  employeeId: string,
  startsAt: string,
  endsAt: string,
  fields: Partial<typeof schema.hrShiftRequests.$inferInsert> = {},
) {
  await db.insert(schema.hrShiftRequests).values({
    id,
    employeeId,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    requestedBy: 'user_someone',
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    ...fields,
  });
}

async function seedOpenShift(
  id: string,
  startsAt: string,
  endsAt: string,
  fields: Partial<typeof schema.hrOpenShifts.$inferInsert> = {},
) {
  await db.insert(schema.hrOpenShifts).values({
    id,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    createdBy: HR_ADMIN,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    ...fields,
  });
}

/** An approved sign-up whose shift is on the rooster: one spot taken. */
async function seedTakenSpot(openShiftId: string, requestId: string, shiftId: string, employeeId: string, startsAt: string, endsAt: string) {
  await seedShift(shiftId, employeeId, startsAt, endsAt);
  await seedShiftRequest(requestId, employeeId, startsAt, endsAt, { openShiftId, status: 'approved', shiftId, reviewedBy: HR_ADMIN });
}

async function shiftRequestRow(id: string) {
  const [row] = await db.select().from(schema.hrShiftRequests).where(eq(schema.hrShiftRequests.id, id));
  return row!;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

describe('GET /shifts', () => {
  it('lists the shifts that start in the range, with employee and client names', async () => {
    await seedShift('hrshf_s1', 'hremp_ann', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z', { companyId: 'co_acme', workType: 'Cashier' });
    await seedShift('hrshf_s2', 'hremp_ben', '2026-03-03T09:00:00Z', '2026-03-03T17:00:00Z');
    await seedShift('hrshf_s3', 'hremp_ann', '2026-03-20T08:00:00Z', '2026-03-20T16:00:00Z');

    const res = await admin().get('/shifts?from=2026-03-02&to=2026-03-08');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; employeeName: string; companyName: string | null }>>(res);
    expect(ids(rows)).toEqual(['hrshf_s1', 'hrshf_s2']);
    expect(rows[0]).toMatchObject({ employeeName: 'Ann Anders', companyName: 'Acme', workType: 'Cashier', startsAt: '2026-03-02T08:00:00.000Z' });
    expect(rows[1]).toMatchObject({ employeeName: 'Ben Berg', companyName: null });

    expect(ids(await data(await admin().get('/shifts?from=2026-03-02&to=2026-03-31&employeeId=hremp_ann')))).toEqual(['hrshf_s1', 'hrshf_s3']);
    expect(ids(await data(await admin().get('/shifts?from=2026-03-02&to=2026-03-31&companyId=co_acme')))).toEqual(['hrshf_s1']);
  });

  it('defaults to the coming week and refuses a range longer than 62 days', async () => {
    await seedShift('hrshf_s4', 'hremp_ann', `${daysFromToday(1)}T10:00:00Z`, `${daysFromToday(1)}T14:00:00Z`);
    await seedShift('hrshf_s5', 'hremp_ann', `${daysFromToday(10)}T10:00:00Z`, `${daysFromToday(10)}T14:00:00Z`);
    expect(ids(await data(await admin().get('/shifts')))).toEqual(['hrshf_s4']);

    const long = await admin().get('/shifts?from=2026-03-01&to=2026-05-15');
    expect(long.status).toBe(400);
    expect(await errorOf(long)).toMatchObject({ code: 'BAD_REQUEST', message: 'Pick a range of at most 62 days' });
    expect((await admin().get('/shifts?from=2026-03-10&to=2026-03-01')).status).toBe(400);
    expect((await as('leave:read').get('/shifts')).status).toBe(403);
  });
});

describe('POST /shifts', () => {
  it('creates a shift with a break, storing instants in UTC', async () => {
    const res = await admin().send('POST', '/shifts', {
      employeeId: 'hremp_ann',
      companyId: 'co_acme',
      startsAt: '2026-03-02T09:00:00+01:00',
      endsAt: '2026-03-02T16:00:00.000Z',
      workType: '  Cashier ',
      breakStartsAt: '2026-03-02T12:00:00.000Z',
      breakEndsAt: '2026-03-02T12:30:00.000Z',
      notes: 'Front desk',
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      employeeId: 'hremp_ann',
      companyId: 'co_acme',
      startsAt: '2026-03-02T08:00:00.000Z',
      endsAt: '2026-03-02T16:00:00.000Z',
      workType: 'Cashier',
      breakStartsAt: '2026-03-02T12:00:00.000Z',
      breakEndsAt: '2026-03-02T12:30:00.000Z',
      notes: 'Front desk',
      createdBy: HR_ADMIN,
    });

    // A shift may start the moment another ends.
    const after = await admin().send('POST', '/shifts', {
      employeeId: 'hremp_ann',
      startsAt: '2026-03-02T16:00:00.000Z',
      endsAt: '2026-03-02T20:00:00.000Z',
      workType: '   ',
    });
    expect(after.status).toBe(201);
    expect(await data(after)).toMatchObject({ workType: null, companyId: null, breakStartsAt: null, notes: null });
  });

  it('refuses a shift that ends first, runs over a day, or has a bad break', async () => {
    const post = (body: Record<string, unknown>) =>
      admin().send('POST', '/shifts', { employeeId: 'hremp_ann', startsAt: '2026-03-02T08:00:00Z', endsAt: '2026-03-02T16:00:00Z', ...body });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ endsAt: '2026-03-02T08:00:00Z' }, 'A shift must end after it starts'],
      [{ endsAt: '2026-03-03T08:01:00Z' }, 'A shift cannot be longer than 24 hours'],
      [{ breakStartsAt: '2026-03-02T12:00:00Z' }, 'A break needs both a start and an end time'],
      [{ breakStartsAt: '2026-03-02T12:30:00Z', breakEndsAt: '2026-03-02T12:00:00Z' }, 'A break must end after it starts'],
      [{ breakStartsAt: '2026-03-02T15:30:00Z', breakEndsAt: '2026-03-02T16:30:00Z' }, 'A break must fall inside the shift'],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: 'BAD_REQUEST', message });
    }
  });

  it('refuses an overlap, an unknown employee, a bad body and a caller without attendance:create', async () => {
    await seedShift('hrshf_s1', 'hremp_ann', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z');
    const overlap = await admin().send('POST', '/shifts', { employeeId: 'hremp_ann', startsAt: '2026-03-02T15:00:00Z', endsAt: '2026-03-02T18:00:00Z' });
    expect(overlap.status).toBe(409);
    expect(await errorOf(overlap)).toMatchObject({ code: 'CONFLICT', message: 'This shift overlaps another shift of this employee' });

    expect((await admin().send('POST', '/shifts', { employeeId: 'hremp_nope', startsAt: '2026-03-02T08:00:00Z', endsAt: '2026-03-02T16:00:00Z' })).status).toBe(404);

    const invalid = await admin().send('POST', '/shifts', { employeeId: 'hremp_ann', startsAt: 'soon' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Starts at must be a date and time. Ends at is required');

    expect((await as('attendance:update').send('POST', '/shifts', { employeeId: 'hremp_ann', startsAt: '2026-03-02T08:00:00Z', endsAt: '2026-03-02T16:00:00Z' })).status).toBe(403);
  });
});

describe('PATCH /shifts/:shiftId', () => {
  beforeEach(async () => {
    await seedShift('hrshf_s1', 'hremp_ann', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z', {
      workType: 'Cashier',
      breakStartsAt: new Date('2026-03-02T12:00:00Z'),
      breakEndsAt: new Date('2026-03-02T12:30:00Z'),
    });
    await seedShift('hrshf_s2', 'hremp_ann', '2026-03-03T08:00:00Z', '2026-03-03T16:00:00Z');
  });

  it('moves the shift, clears the break and the work type', async () => {
    const res = await admin().send('PATCH', '/shifts/hrshf_s1', {
      startsAt: '2026-03-02T09:00:00Z',
      endsAt: '2026-03-02T17:00:00Z',
      workType: '',
      breakStartsAt: null,
      breakEndsAt: null,
      companyId: 'co_acme',
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      id: 'hrshf_s1',
      startsAt: '2026-03-02T09:00:00.000Z',
      endsAt: '2026-03-02T17:00:00.000Z',
      workType: null,
      breakStartsAt: null,
      breakEndsAt: null,
      companyId: 'co_acme',
    });

    // Leaving a field out keeps it.
    const notes = await admin().send('PATCH', '/shifts/hrshf_s2', { notes: 'Bring keys' });
    expect(await data(notes)).toMatchObject({ notes: 'Bring keys', startsAt: '2026-03-03T08:00:00.000Z' });
  });

  it('refuses an overlap with the employee’s other shift and a half break', async () => {
    const overlap = await admin().send('PATCH', '/shifts/hrshf_s2', { startsAt: '2026-03-02T15:00:00Z' });
    expect(overlap.status).toBe(400);
    expect((await errorOf(overlap)).message).toBe('A shift cannot be longer than 24 hours');

    const clash = await admin().send('PATCH', '/shifts/hrshf_s2', { startsAt: '2026-03-02T15:00:00Z', endsAt: '2026-03-02T20:00:00Z' });
    expect(clash.status).toBe(409);
    expect((await errorOf(clash)).message).toBe('This shift overlaps another shift of this employee');

    const half = await admin().send('PATCH', '/shifts/hrshf_s1', { breakEndsAt: null });
    expect(half.status).toBe(400);
    expect((await errorOf(half)).message).toBe('A break needs both a start and an end time');
  });

  it('is a 404 for an unknown shift and needs attendance:update', async () => {
    expect((await admin().send('PATCH', '/shifts/hrshf_nope', { notes: 'x' })).status).toBe(404);
    expect((await as('attendance:create').send('PATCH', '/shifts/hrshf_s1', { notes: 'x' })).status).toBe(403);
    const invalid = await admin().send('PATCH', '/shifts/hrshf_s1', { notes: 5 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Notes has the wrong type');
  });
});

describe('DELETE /shifts/:shiftId', () => {
  it('removes the shift', async () => {
    await seedShift('hrshf_s1', 'hremp_ann', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z');
    expect((await as('attendance:update').send('DELETE', '/shifts/hrshf_s1')).status).toBe(403);
    expect((await admin().send('DELETE', '/shifts/hrshf_s1')).status).toBe(204);
    expect(await db.select().from(schema.hrShifts).where(eq(schema.hrShifts.id, 'hrshf_s1'))).toHaveLength(0);
    expect((await admin().send('DELETE', '/shifts/hrshf_s1')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Shift requests
// ---------------------------------------------------------------------------

describe('GET /shift-requests', () => {
  it('lists requests latest shift first, with who asked and who answered', async () => {
    await seedShiftRequest('hrsrq_r1', 'hremp_ann', '2026-03-05T08:00:00Z', '2026-03-05T12:00:00Z', { workType: 'Cashier', note: 'Can do' });
    await seedShiftRequest('hrsrq_r2', 'hremp_ben', '2026-03-06T08:00:00Z', '2026-03-06T12:00:00Z', {
      status: 'rejected',
      reviewedBy: HR_ADMIN,
      reviewedAt: new Date('2026-03-01T10:00:00Z'),
      reviewNote: 'Full',
    });
    await seedShiftRequest('hrsrq_r3', 'hremp_ann', '2026-04-01T08:00:00Z', '2026-04-01T12:00:00Z');

    const res = await admin().get('/shift-requests');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string; employeeName: string; reviewedByName: string | null }>>(res);
    expect(ids(rows)).toEqual(['hrsrq_r3', 'hrsrq_r2', 'hrsrq_r1']);
    expect(rows[1]).toMatchObject({ employeeName: 'Ben Berg', reviewedByName: 'Hanna Admin', status: 'rejected' });
    expect(rows[2]).toMatchObject({ employeeName: 'Ann Anders', reviewedByName: null, workType: 'Cashier', note: 'Can do' });

    expect(ids(await data(await admin().get('/shift-requests?status=pending&employeeId=hremp_ann')))).toEqual(['hrsrq_r3', 'hrsrq_r1']);
    expect(ids(await data(await admin().get('/shift-requests?from=2026-03-06&to=2026-03-31')))).toEqual(['hrsrq_r2']);
    expect((await as('leave:read').get('/shift-requests')).status).toBe(403);
  });
});

describe('POST /shift-requests/:shiftRequestId/review', () => {
  beforeEach(async () => {
    await seedShiftRequest('hrsrq_r1', 'hremp_ann', '2026-03-05T08:00:00Z', '2026-03-05T12:00:00Z', { workType: 'Cashier' });
    await seedShiftRequest('hrsrq_r2', 'hremp_ben', '2026-03-06T08:00:00Z', '2026-03-06T12:00:00Z');
  });

  it('approving puts the shift on the rooster', async () => {
    const res = await admin().send('POST', '/shift-requests/hrsrq_r1/review', { decision: 'approved', note: '  See you ' });
    expect(res.status).toBe(200);
    const row = await data<{ shiftId: string }>(res);
    expect(row).toMatchObject({
      id: 'hrsrq_r1',
      status: 'approved',
      reviewNote: 'See you',
      reviewedBy: HR_ADMIN,
      reviewedByName: 'Hanna Admin',
      employeeName: 'Ann Anders',
    });
    const [shift] = await db.select().from(schema.hrShifts).where(eq(schema.hrShifts.id, row.shiftId));
    expect(shift).toMatchObject({ employeeId: 'hremp_ann', workType: 'Cashier', createdBy: HR_ADMIN });
    expect(shift!.startsAt.toISOString()).toBe('2026-03-05T08:00:00.000Z');

    const again = await admin().send('POST', '/shift-requests/hrsrq_r1/review', { decision: 'rejected' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This request is already approved');
  });

  it('rejecting keeps the rooster as it is', async () => {
    const res = await admin().send('POST', '/shift-requests/hrsrq_r2/review', { decision: 'rejected', note: '' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ status: 'rejected', shiftId: null, reviewNote: null, reviewedByName: 'Hanna Admin' });
    expect(await db.select().from(schema.hrShifts)).toHaveLength(0);
  });

  it('refuses a request that clashes with a shift, an unknown one, a bad decision and a caller who cannot add shifts', async () => {
    await seedShift('hrshf_x1', 'hremp_ann', '2026-03-05T10:00:00Z', '2026-03-05T14:00:00Z');
    const clash = await admin().send('POST', '/shift-requests/hrsrq_r1/review', { decision: 'approved' });
    expect(clash.status).toBe(409);
    expect((await errorOf(clash)).message).toBe('This shift overlaps another shift of this employee');
    expect((await shiftRequestRow('hrsrq_r1')).status).toBe('pending');

    expect((await admin().send('POST', '/shift-requests/hrsrq_nope/review', { decision: 'approved' })).status).toBe(404);
    const invalid = await admin().send('POST', '/shift-requests/hrsrq_r2/review', { decision: 'maybe' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Decision must be one of approved, rejected');
    expect((await as('attendance:update').send('POST', '/shift-requests/hrsrq_r2/review', { decision: 'approved' })).status).toBe(403);
  });

  it('approving a sign-up takes a spot on the open shift, and the last spot turns the rest down', async () => {
    await seedOpenShift('hrosh_o1', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', {
      companyId: 'co_acme',
      notes: 'Bring ID',
      workType: 'Picker',
      breakStartsAt: new Date('2026-03-10T12:00:00Z'),
      breakEndsAt: new Date('2026-03-10T12:30:00Z'),
    });
    await seedShiftRequest('hrsrq_o1', 'hremp_ann', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { openShiftId: 'hrosh_o1', workType: 'Picker' });
    await seedShiftRequest('hrsrq_o2', 'hremp_ben', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { openShiftId: 'hrosh_o1', workType: 'Picker' });

    const res = await admin().send('POST', '/shift-requests/hrsrq_o1/review', { decision: 'approved', note: 'Yours' });
    expect(res.status).toBe(200);
    const approved = await data<{ shiftId: string }>(res);
    expect(approved).toMatchObject({ status: 'approved', openShiftId: 'hrosh_o1', reviewNote: 'Yours' });
    const [shift] = await db.select().from(schema.hrShifts).where(eq(schema.hrShifts.id, approved.shiftId));
    expect(shift).toMatchObject({ employeeId: 'hremp_ann', companyId: 'co_acme', notes: 'Bring ID', workType: 'Picker' });
    expect(shift!.breakStartsAt?.toISOString()).toBe('2026-03-10T12:00:00.000Z');

    expect(await shiftRequestRow('hrsrq_o2')).toMatchObject({
      status: 'rejected',
      reviewNote: 'All spots on this shift were filled',
      reviewedBy: HR_ADMIN,
    });

    // Someone signing up after it filled is refused on approval.
    await seedShiftRequest('hrsrq_o3', 'hremp_ben', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { openShiftId: 'hrosh_o1' });
    const full = await admin().send('POST', '/shift-requests/hrsrq_o3/review', { decision: 'approved' });
    expect(full.status).toBe(409);
    expect((await errorOf(full)).message).toBe('All spots on this shift are filled');
  });

  it('refuses a sign-up for an open shift that was withdrawn', async () => {
    await seedOpenShift('hrosh_o2', '2026-03-11T08:00:00Z', '2026-03-11T16:00:00Z', { status: 'cancelled' });
    await seedShiftRequest('hrsrq_o4', 'hremp_ann', '2026-03-11T08:00:00Z', '2026-03-11T16:00:00Z', { openShiftId: 'hrosh_o2' });
    const res = await admin().send('POST', '/shift-requests/hrsrq_o4/review', { decision: 'approved' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe('This open shift was withdrawn');
  });
});

// ---------------------------------------------------------------------------
// Open shifts
// ---------------------------------------------------------------------------

describe('GET /open-shifts', () => {
  it('lists open shifts by start with names, spots filled and sign-ups waiting', async () => {
    await seedDepartment(db, 'hrdep_ops', 'Operations');
    await seedOpenShift('hrosh_o1', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { companyId: 'co_acme', departmentId: 'hrdep_ops', spots: 2 });
    await seedOpenShift('hrosh_o2', '2026-03-12T08:00:00Z', '2026-03-12T16:00:00Z', { status: 'cancelled' });
    await seedTakenSpot('hrosh_o1', 'hrsrq_t1', 'hrshf_t1', 'hremp_ann', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z');
    await seedShiftRequest('hrsrq_p1', 'hremp_ben', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { openShiftId: 'hrosh_o1' });
    // Approved, but its shift was taken off the rooster: the spot is free again.
    await seedShiftRequest('hrsrq_g1', 'hremp_ben', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', {
      openShiftId: 'hrosh_o1',
      status: 'approved',
      shiftId: 'hrshf_gone',
    });

    const res = await admin().get('/open-shifts');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string }>>(res);
    expect(ids(rows)).toEqual(['hrosh_o1', 'hrosh_o2']);
    expect(rows[0]).toMatchObject({
      companyName: 'Acme',
      departmentName: 'Operations',
      spots: 2,
      filled: 1,
      pending: 1,
      spotsLeft: 1,
      status: 'open',
    });
    expect(rows[1]).toMatchObject({ companyName: null, departmentName: null, filled: 0, pending: 0, spotsLeft: 1, status: 'cancelled' });

    expect(ids(await data(await admin().get('/open-shifts?status=open')))).toEqual(['hrosh_o1']);
    expect(ids(await data(await admin().get('/open-shifts?from=2026-03-11')))).toEqual(['hrosh_o2']);
    expect(ids(await data(await admin().get('/open-shifts?to=2026-03-10')))).toEqual(['hrosh_o1']);
    expect((await as('leave:read').get('/open-shifts')).status).toBe(403);
  });
});

describe('POST /open-shifts', () => {
  it('posts a shift ahead of now for a department', async () => {
    await seedDepartment(db, 'hrdep_ops', 'Operations');
    const day = daysFromToday(2);
    const res = await admin().send('POST', '/open-shifts', {
      departmentId: 'hrdep_ops',
      companyId: 'co_acme',
      startsAt: `${day}T08:00:00.000Z`,
      endsAt: `${day}T16:00:00.000Z`,
      workType: ' Picker ',
      notes: '   ',
      spots: 2,
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      departmentId: 'hrdep_ops',
      departmentName: 'Operations',
      companyName: 'Acme',
      startsAt: `${day}T08:00:00.000Z`,
      workType: 'Picker',
      notes: null,
      spots: 2,
      status: 'open',
      filled: 0,
      pending: 0,
      spotsLeft: 2,
      createdBy: HR_ADMIN,
    });

    const single = await admin().send('POST', '/open-shifts', { startsAt: `${day}T18:00:00.000Z`, endsAt: `${day}T22:00:00.000Z` });
    expect(single.status).toBe(201);
    expect(await data(single)).toMatchObject({ spots: 1, departmentId: null, companyId: null, spotsLeft: 1 });
  });

  it('refuses a shift in the past, an unknown department, a bad body and a caller without attendance:create', async () => {
    const past = await admin().send('POST', '/open-shifts', { startsAt: '2026-03-02T08:00:00Z', endsAt: '2026-03-02T16:00:00Z' });
    expect(past.status).toBe(400);
    expect((await errorOf(past)).message).toBe('An open shift has to end in the future');

    const day = daysFromToday(3);
    const window = await admin().send('POST', '/open-shifts', { startsAt: `${day}T16:00:00Z`, endsAt: `${day}T08:00:00Z` });
    expect(window.status).toBe(400);
    expect((await errorOf(window)).message).toBe('A shift must end after it starts');

    expect((await admin().send('POST', '/open-shifts', { startsAt: `${day}T08:00:00Z`, endsAt: `${day}T16:00:00Z`, departmentId: 'hrdep_nope' })).status).toBe(404);

    const invalid = await admin().send('POST', '/open-shifts', { startsAt: `${day}T08:00:00Z`, endsAt: `${day}T16:00:00Z`, spots: 0 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Spots must be at least 1');

    expect((await as('attendance:read').send('POST', '/open-shifts', { startsAt: `${day}T08:00:00Z`, endsAt: `${day}T16:00:00Z` })).status).toBe(403);
  });
});

describe('PATCH /open-shifts/:openShiftId', () => {
  beforeEach(async () => {
    await seedOpenShift('hrosh_o1', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { spots: 3 });
    await seedTakenSpot('hrosh_o1', 'hrsrq_t1', 'hrshf_t1', 'hremp_ann', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z');
    await seedTakenSpot('hrosh_o1', 'hrsrq_t2', 'hrshf_t2', 'hremp_ben', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z');
    await seedOpenShift('hrosh_o3', '2026-03-12T08:00:00Z', '2026-03-12T16:00:00Z', { workType: 'Picker' });
    await seedShiftRequest('hrsrq_p3', 'hremp_ann', '2026-03-12T08:00:00Z', '2026-03-12T16:00:00Z', { openShiftId: 'hrosh_o3' });
  });

  it('moves a shift nobody is on yet, and its waiting sign-ups with it', async () => {
    const res = await admin().send('PATCH', '/open-shifts/hrosh_o3', {
      startsAt: '2026-03-12T09:00:00Z',
      endsAt: '2026-03-12T17:00:00Z',
      workType: '',
      notes: ' Dock 4 ',
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      id: 'hrosh_o3',
      startsAt: '2026-03-12T09:00:00.000Z',
      endsAt: '2026-03-12T17:00:00.000Z',
      workType: null,
      notes: 'Dock 4',
      pending: 1,
    });
    const moved = await shiftRequestRow('hrsrq_p3');
    expect(moved.startsAt.toISOString()).toBe('2026-03-12T09:00:00.000Z');
    expect(moved.endsAt.toISOString()).toBe('2026-03-12T17:00:00.000Z');
  });

  it('keeps the times and enough spots once people are on it', async () => {
    const moved = await admin().send('PATCH', '/open-shifts/hrosh_o1', { startsAt: '2026-03-10T09:00:00Z' });
    expect(moved.status).toBe(409);
    expect((await errorOf(moved)).message).toBe('Someone is already on this shift. Change their shift on the rooster instead.');

    const spots = await admin().send('PATCH', '/open-shifts/hrosh_o1', { spots: 1 });
    expect(spots.status).toBe(400);
    expect((await errorOf(spots)).message).toBe('2 people are already on this shift, so it needs at least 2 spots');

    const ok = await admin().send('PATCH', '/open-shifts/hrosh_o1', { spots: 2 });
    expect(ok.status).toBe(200);
    expect(await data(ok)).toMatchObject({ spots: 2, filled: 2, spotsLeft: 0 });
  });

  it('refuses a withdrawn or unknown shift, a bad body and a caller without attendance:update', async () => {
    await seedOpenShift('hrosh_o2', '2026-03-11T08:00:00Z', '2026-03-11T16:00:00Z', { status: 'cancelled' });
    const withdrawn = await admin().send('PATCH', '/open-shifts/hrosh_o2', { notes: 'x' });
    expect(withdrawn.status).toBe(409);
    expect((await errorOf(withdrawn)).message).toBe('This open shift was withdrawn');
    expect((await admin().send('PATCH', '/open-shifts/hrosh_nope', { notes: 'x' })).status).toBe(404);
    expect((await admin().send('PATCH', '/open-shifts/hrosh_o3', { departmentId: 'hrdep_nope' })).status).toBe(404);
    const invalid = await admin().send('PATCH', '/open-shifts/hrosh_o3', { spots: 101 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Spots must be at most 100');
    expect((await as('attendance:create').send('PATCH', '/open-shifts/hrosh_o3', { notes: 'x' })).status).toBe(403);
  });
});

describe('POST /open-shifts/:openShiftId/cancel', () => {
  it('withdraws the shift and cancels the sign-ups still waiting', async () => {
    await seedOpenShift('hrosh_o1', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { spots: 2 });
    await seedTakenSpot('hrosh_o1', 'hrsrq_t1', 'hrshf_t1', 'hremp_ann', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z');
    await seedShiftRequest('hrsrq_p1', 'hremp_ben', '2026-03-10T08:00:00Z', '2026-03-10T16:00:00Z', { openShiftId: 'hrosh_o1' });

    expect((await as('attendance:update').send('POST', '/open-shifts/hrosh_o1/cancel')).status).toBe(403);
    const res = await admin().send('POST', '/open-shifts/hrosh_o1/cancel');
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrosh_o1', status: 'cancelled', filled: 1, pending: 0, spotsLeft: 1 });
    expect(await shiftRequestRow('hrsrq_p1')).toMatchObject({
      status: 'cancelled',
      reviewNote: 'This open shift was withdrawn',
      reviewedBy: HR_ADMIN,
    });
    // Whoever was approved keeps their shift.
    expect((await shiftRequestRow('hrsrq_t1')).status).toBe('approved');

    const again = await admin().send('POST', '/open-shifts/hrosh_o1/cancel');
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This open shift was already withdrawn');
    expect((await admin().send('POST', '/open-shifts/hrosh_nope/cancel')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Work locations
// ---------------------------------------------------------------------------

describe('/work-locations', () => {
  async function seedLocation(id: string, name: string, fields: Partial<typeof schema.hrWorkLocations.$inferInsert> = {}) {
    await db.insert(schema.hrWorkLocations).values({ id, name, latitude: 52.37, longitude: 4.89, createdAt: SEEDED_AT, updatedAt: SEEDED_AT, ...fields });
  }

  it('lists live locations by name, the inactive ones on request', async () => {
    await seedLocation('hrloc_wh', 'Warehouse');
    await seedLocation('hrloc_hq', 'HQ', { address: 'Main street 1', radiusMeters: 300 });
    await seedLocation('hrloc_old', 'Annex', { isActive: false });
    await seedLocation('hrloc_gone', 'Barn', { deletedAt: new Date('2026-02-01T00:00:00Z'), isActive: false });

    const res = await admin().get('/work-locations');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string }>>(res);
    expect(ids(rows)).toEqual(['hrloc_hq', 'hrloc_wh']);
    expect(rows[0]).toMatchObject({ name: 'HQ', address: 'Main street 1', latitude: 52.37, longitude: 4.89, radiusMeters: 300, isActive: true });
    expect(ids(await data(await admin().get('/work-locations?includeInactive=true')))).toEqual(['hrloc_old', 'hrloc_hq', 'hrloc_wh']);

    // Any of employees:read, attendance:read or employees:manage opens it.
    expect((await as('attendance:read').get('/work-locations')).status).toBe(200);
    expect((await as('leave:read').get('/work-locations')).status).toBe(403);
  });

  it('creates, updates and removes a location', async () => {
    const created = await admin().send('POST', '/work-locations', { name: '  Depot ', address: '  ', latitude: 51.5, longitude: -0.12 });
    expect(created.status).toBe(201);
    const depot = await data<{ id: string }>(created);
    expect(depot).toMatchObject({ name: 'Depot', address: null, latitude: 51.5, longitude: -0.12, radiusMeters: 150, isActive: true, deletedAt: null });

    const updated = await admin().send('PATCH', `/work-locations/${depot.id}`, { radiusMeters: 500, address: ' Dock road 2 ', isActive: false });
    expect(updated.status).toBe(200);
    expect(await data(updated)).toMatchObject({ name: 'Depot', radiusMeters: 500, address: 'Dock road 2', isActive: false });

    const removed = await admin().send('DELETE', `/work-locations/${depot.id}`);
    expect(removed.status).toBe(204);
    const [row] = await db.select().from(schema.hrWorkLocations).where(eq(schema.hrWorkLocations.id, depot.id));
    expect(row!.deletedAt).not.toBeNull();
    expect((await admin().send('DELETE', `/work-locations/${depot.id}`)).status).toBe(404);
    expect((await admin().send('PATCH', `/work-locations/${depot.id}`, { name: 'Back' })).status).toBe(404);
  });

  it('validates the body and needs employees:manage to change anything', async () => {
    await seedLocation('hrloc_hq', 'HQ');
    const invalid = await admin().send('POST', '/work-locations', { name: 'Far', latitude: 91, longitude: 4, radiusMeters: 10 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Latitude must be at most 90. Radius meters must be at least 25');
    expect((await as('employees:read').send('POST', '/work-locations', { name: 'X', latitude: 1, longitude: 1 })).status).toBe(403);
    expect((await as('employees:read').send('PATCH', '/work-locations/hrloc_hq', { name: 'X' })).status).toBe(403);
    expect((await as('employees:read').send('DELETE', '/work-locations/hrloc_hq')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

describe('POST /attendance', () => {
  beforeEach(async () => {
    await seedShift('hrshf_a1', 'hremp_ann', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z', { companyId: 'co_acme' });
  });

  it('derives worked and late minutes, the client and the status from the day’s shift', async () => {
    const res = await admin().send('POST', '/attendance', {
      employeeId: 'hremp_ann',
      date: '2026-03-02',
      clockIn: '2026-03-02T08:12:00.000Z',
      clockOut: '2026-03-02T16:30:00.000Z',
      breakMinutes: 30,
      notes: 'Traffic',
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      employeeId: 'hremp_ann',
      shiftId: 'hrshf_a1',
      companyId: 'co_acme',
      date: '2026-03-02',
      breakMinutes: 30,
      workedMinutes: 468,
      lateMinutes: 12,
      status: 'late',
      source: 'manual',
      notes: 'Traffic',
      approvedAt: null,
      clockInLocationId: null,
      createdBy: HR_ADMIN,
    });
  });

  it('allows five minutes of grace, keeps a chosen status, and handles a day without a shift', async () => {
    const grace = await admin().send('POST', '/attendance', { employeeId: 'hremp_ann', date: '2026-03-02', clockIn: '2026-03-02T08:05:00Z' });
    expect(await data(grace)).toMatchObject({ lateMinutes: 0, status: 'present', workedMinutes: null, clockOut: null });

    const chosen = await admin().send('POST', '/attendance', {
      employeeId: 'hremp_ann',
      date: '2026-03-02',
      clockIn: '2026-03-02T09:00:00Z',
      clockOut: '2026-03-02T10:00:00Z',
      status: 'remote',
      companyId: 'co_other',
    });
    expect(await data(chosen)).toMatchObject({ lateMinutes: 60, status: 'remote', workedMinutes: 60, companyId: 'co_other' });

    const absent = await admin().send('POST', '/attendance', { employeeId: 'hremp_ben', date: '2026-03-02', status: 'absent' });
    expect(absent.status).toBe(201);
    expect(await data(absent)).toMatchObject({ shiftId: null, companyId: null, lateMinutes: 0, workedMinutes: null, status: 'absent' });
  });

  it('refuses impossible times, an unknown employee, a bad body and a caller without attendance:create', async () => {
    const post = (body: Record<string, unknown>) => admin().send('POST', '/attendance', { employeeId: 'hremp_ann', date: '2026-03-02', ...body });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ clockIn: '2026-03-02T16:00:00Z', clockOut: '2026-03-02T08:00:00Z' }, 'Clock-out must be after clock-in'],
      [{ clockIn: '2026-03-02T08:00:00Z', clockOut: '2026-03-03T08:01:00Z' }, 'A record cannot span more than 24 hours'],
      [{ clockIn: '2026-03-02T08:00:00Z', clockOut: '2026-03-02T09:00:00Z', breakMinutes: 60 }, 'The break must be shorter than the time between clock-in and clock-out'],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).message).toBe(message);
    }
    expect((await admin().send('POST', '/attendance', { employeeId: 'hremp_nope', date: '2026-03-02' })).status).toBe(404);

    const invalid = await post({ date: 'today', breakMinutes: -5, status: 'gone' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe(
      'Date: Expected YYYY-MM-DD. Break minutes must be at least 0. Status must be one of present, late, absent, excused, remote, half_day',
    );
    expect((await as('attendance:read').send('POST', '/attendance', { employeeId: 'hremp_ann', date: '2026-03-02' })).status).toBe(403);
  });
});

describe('GET /attendance and /attendance/summary', () => {
  beforeEach(async () => {
    await db.insert(schema.hrWorkLocations).values({ id: 'hrloc_hq', name: 'HQ', latitude: 52.37, longitude: 4.89 });
    await db.insert(schema.hrAttendanceRecords).values([
      {
        id: 'hratt_l1',
        employeeId: 'hremp_ann',
        companyId: 'co_acme',
        date: '2026-03-02',
        clockIn: new Date('2026-03-02T08:00:00Z'),
        clockOut: new Date('2026-03-02T16:00:00Z'),
        workedMinutes: 480,
        status: 'present',
        approvedBy: HR_ADMIN,
        approvedAt: new Date('2026-03-03T09:00:00Z'),
        clockInLocationId: 'hrloc_hq',
        clockInLatitude: 52.3701,
        clockInLongitude: 4.8902,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      },
      { id: 'hratt_l2', employeeId: 'hremp_ann', date: '2026-03-03', workedMinutes: 450, lateMinutes: 15, status: 'late', createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
      { id: 'hratt_l3', employeeId: 'hremp_ben', date: '2026-03-04', status: 'absent', createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
      { id: 'hratt_l4', employeeId: 'hremp_ben', date: '2026-03-05', workedMinutes: 420, status: 'present', createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
    ]);
  });

  it('lists records newest first with names, and pages with a cursor', async () => {
    const res = await admin().get('/attendance');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(body.data)).toEqual(['hratt_l4', 'hratt_l3', 'hratt_l2', 'hratt_l1']);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
    expect(body.data[3]).toMatchObject({
      employeeName: 'Ann Anders',
      companyName: 'Acme',
      approvedByName: 'Hanna Admin',
      clockInLocationName: 'HQ',
      clockOutLocationName: null,
      clockInLatitude: 52.3701,
    });

    const first = (await (await admin().get('/attendance?limit=2')).json()) as { data: Array<{ id: string }>; pagination: { cursor: string } };
    expect(ids(first.data)).toEqual(['hratt_l4', 'hratt_l3']);
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'hratt_l3' });
    const second = (await (await admin().get('/attendance?limit=2&cursor=hratt_l3')).json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(second.data)).toEqual(['hratt_l2', 'hratt_l1']);
    expect(second.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
  });

  it('filters by employee, client, dates, status and approval', async () => {
    const list = async (query: string) => ids(await data(await admin().get(`/attendance${query}`)));
    expect(await list('?employeeId=hremp_ann')).toEqual(['hratt_l2', 'hratt_l1']);
    expect(await list('?companyId=co_acme')).toEqual(['hratt_l1']);
    expect(await list('?from=2026-03-03&to=2026-03-04')).toEqual(['hratt_l3', 'hratt_l2']);
    expect(await list('?status=late,absent')).toEqual(['hratt_l3', 'hratt_l2']);
    expect(await list('?unapproved=true')).toEqual(['hratt_l4', 'hratt_l3', 'hratt_l2']);
    expect((await as('leave:read').get('/attendance')).status).toBe(403);
  });

  it('sums the range by status, with the attendance rate', async () => {
    const res = await admin().get('/attendance/summary?from=2026-03-01&to=2026-03-31');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      records: 4,
      workedMinutes: 1350,
      lateMinutes: 15,
      byStatus: { present: 2, late: 1, absent: 1 },
      attendanceRate: 75,
    });
    expect(await data(await admin().get('/attendance/summary?from=2026-03-01&to=2026-03-31&employeeId=hremp_ben'))).toEqual({
      records: 2,
      workedMinutes: 420,
      lateMinutes: 0,
      byStatus: { absent: 1, present: 1 },
      attendanceRate: 50,
    });
    expect((await data<{ records: number }>(await admin().get('/attendance/summary?from=2026-03-01&to=2026-03-31&companyId=co_acme'))).records).toBe(1);
    expect(await data(await admin().get('/attendance/summary?from=2025-01-01&to=2025-01-31'))).toEqual({
      records: 0,
      workedMinutes: 0,
      lateMinutes: 0,
      byStatus: {},
      attendanceRate: null,
    });
    expect((await admin().get('/attendance/summary')).status).toBe(200);
    expect((await as('leave:read').get('/attendance/summary')).status).toBe(403);
  });
});

describe('POST /attendance/import', () => {
  const rows = [
    { employee: 'ANN@example.com', date: '2026-03-09', clockIn: '2026-03-09T08:00:00Z', clockOut: '2026-03-09T16:00:00Z', breakMinutes: 30 },
    { employee: 'E-002', date: '2026-03-09', status: 'absent', notes: 'Ill' },
    { employee: 'nobody@example.com', date: '2026-03-09' },
    { employee: 'ann@example.com', date: '2026-03-10', clockIn: '2026-03-10T17:00:00Z', clockOut: '2026-03-10T09:00:00Z' },
  ];

  it('checks every row without writing on a dry run', async () => {
    const res = await admin().send('POST', '/attendance/import', { rows, dryRun: true });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({
      created: 2,
      updated: 0,
      errors: [
        { row: 3, reason: 'No employee matches "nobody@example.com"' },
        { row: 4, reason: 'Clock-out must be after clock-in' },
      ],
    });
    expect(await db.select().from(schema.hrAttendanceRecords)).toHaveLength(0);
  });

  it('imports by email or employee number, and a second import updates the day', async () => {
    const res = await admin().send('POST', '/attendance/import', { rows });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ created: 2, updated: 0 });
    const imported = await db.select().from(schema.hrAttendanceRecords).where(eq(schema.hrAttendanceRecords.employeeId, 'hremp_ann'));
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ source: 'import', workedMinutes: 450, status: 'present', createdBy: HR_ADMIN });

    const again = await admin().send('POST', '/attendance/import', {
      rows: [{ employee: 'ann@example.com', date: '2026-03-09', clockIn: '2026-03-09T08:00:00Z', clockOut: '2026-03-09T12:00:00Z' }],
    });
    expect(await data(again)).toEqual({ created: 0, updated: 1, errors: [] });
    const [updated] = await db.select().from(schema.hrAttendanceRecords).where(eq(schema.hrAttendanceRecords.id, imported[0]!.id));
    // A row without breakMinutes keeps the break the day already had.
    expect(updated).toMatchObject({ workedMinutes: 210, breakMinutes: 30 });
  });

  it('validates the rows and needs attendance:create', async () => {
    const empty = await admin().send('POST', '/attendance/import', { rows: [] });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe('Rows needs at least 1 item(s)');
    const bad = await admin().send('POST', '/attendance/import', { rows: [{ employee: 'ann@example.com', date: '9 March' }] });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).message).toBe('Rows #1 date: Expected YYYY-MM-DD');
    expect((await as('attendance:approve').send('POST', '/attendance/import', { rows })).status).toBe(403);
  });
});

describe('POST /attendance/approve', () => {
  it('approves what is not approved yet and counts it', async () => {
    await db.insert(schema.hrAttendanceRecords).values([
      { id: 'hratt_p1', employeeId: 'hremp_ann', date: '2026-03-02', approvedBy: 'user_other', approvedAt: new Date('2026-03-03T09:00:00Z') },
      { id: 'hratt_p2', employeeId: 'hremp_ann', date: '2026-03-03' },
      { id: 'hratt_p3', employeeId: 'hremp_ben', date: '2026-03-03' },
    ]);
    const res = await admin().send('POST', '/attendance/approve', { ids: ['hratt_p1', 'hratt_p2', 'hratt_p3', 'hratt_nope'] });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ approved: 2 });
    const rows = await db.select().from(schema.hrAttendanceRecords);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.approvedBy]))).toEqual({ hratt_p1: 'user_other', hratt_p2: HR_ADMIN, hratt_p3: HR_ADMIN });

    const empty = await admin().send('POST', '/attendance/approve', { ids: [] });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe('Ids needs at least 1 item(s)');
    expect((await as('attendance:update').send('POST', '/attendance/approve', { ids: ['hratt_p2'] })).status).toBe(403);
  });
});

describe('PATCH and DELETE /attendance/:attendanceId', () => {
  beforeEach(async () => {
    await seedShift('hrshf_a1', 'hremp_ann', '2026-03-02T08:00:00Z', '2026-03-02T16:00:00Z', { companyId: 'co_acme' });
    await db.insert(schema.hrAttendanceRecords).values({
      id: 'hratt_e1',
      employeeId: 'hremp_ann',
      companyId: 'co_acme',
      shiftId: 'hrshf_a1',
      date: '2026-03-02',
      clockIn: new Date('2026-03-02T08:00:00Z'),
      clockOut: new Date('2026-03-02T16:00:00Z'),
      workedMinutes: 480,
      status: 'present',
      approvedBy: HR_ADMIN,
      approvedAt: new Date('2026-03-03T09:00:00Z'),
    });
  });

  it('re-derives moved times and clears the approval', async () => {
    const res = await admin().send('PATCH', '/attendance/hratt_e1', { clockIn: '2026-03-02T08:20:00Z', breakMinutes: 20 });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      id: 'hratt_e1',
      clockIn: '2026-03-02T08:20:00.000Z',
      lateMinutes: 20,
      workedMinutes: 440,
      status: 'late',
      shiftId: 'hrshf_a1',
      approvedAt: null,
      approvedBy: null,
    });
  });

  it('keeps a status nobody changed when only the notes move, and takes one that is chosen', async () => {
    const notes = await admin().send('PATCH', '/attendance/hratt_e1', { notes: 'Checked' });
    expect(await data(notes)).toMatchObject({ notes: 'Checked', status: 'present', approvedAt: null });
    const chosen = await admin().send('PATCH', '/attendance/hratt_e1', { status: 'excused', clockOut: null });
    expect(await data(chosen)).toMatchObject({ status: 'excused', clockOut: null, workedMinutes: null });
  });

  it('refuses impossible times, an unknown record and a caller without the grant', async () => {
    const times = await admin().send('PATCH', '/attendance/hratt_e1', { clockOut: '2026-03-02T07:00:00Z' });
    expect(times.status).toBe(400);
    expect((await errorOf(times)).message).toBe('Clock-out must be after clock-in');
    expect((await admin().send('PATCH', '/attendance/hratt_nope', { notes: 'x' })).status).toBe(404);
    expect((await as('attendance:create').send('PATCH', '/attendance/hratt_e1', { notes: 'x' })).status).toBe(403);
  });

  it('deletes a record', async () => {
    expect((await as('attendance:update').send('DELETE', '/attendance/hratt_e1')).status).toBe(403);
    expect((await admin().send('DELETE', '/attendance/hratt_e1')).status).toBe(204);
    expect(await db.select().from(schema.hrAttendanceRecords)).toHaveLength(0);
    expect((await admin().send('DELETE', '/attendance/hratt_e1')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Leave types and allowances
// ---------------------------------------------------------------------------

async function seedLeaveType(id: string, name: string, fields: Partial<typeof schema.hrLeaveTypes.$inferInsert> = {}) {
  await db.insert(schema.hrLeaveTypes).values({ id, name, createdAt: SEEDED_AT, updatedAt: SEEDED_AT, ...fields });
}

async function seedLeaveRequest(id: string, employeeId: string, leaveTypeId: string, startDate: string, endDate: string, days: number, fields: Partial<typeof schema.hrLeaveRequests.$inferInsert> = {}) {
  await db.insert(schema.hrLeaveRequests).values({ id, employeeId, leaveTypeId, startDate, endDate, days, createdAt: SEEDED_AT, updatedAt: SEEDED_AT, ...fields });
}

describe('/leave-types', () => {
  it('lists the active types by name, the archived ones on request', async () => {
    await seedLeaveType('hrlvt_train', 'Training', { defaultAllowanceDays: 3, overAllowance: 'block' });
    await seedLeaveType('hrlvt_old', 'Old leave', { isActive: false });
    const res = await admin().get('/leave-types');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string }>>(res);
    expect(ids(rows)).toEqual(['hrlvt_default_annual', 'hrlvt_default_sick', 'hrlvt_train', 'hrlvt_default_unpaid']);
    expect(rows[0]).toMatchObject({ name: 'Annual leave', color: '#3b82f6', isPaid: true, requiresApproval: true, defaultAllowanceDays: 20, overAllowance: 'allow' });
    expect(ids(await data(await admin().get('/leave-types?includeInactive=true')))).toContain('hrlvt_old');
    expect((await as('employees:read').get('/leave-types')).status).toBe(200);
    expect((await as('attendance:read').get('/leave-types')).status).toBe(403);
  });

  it('creates and updates a type', async () => {
    const res = await admin().send('POST', '/leave-types', { name: 'Training', color: '#00ff00', defaultAllowanceDays: 3, overAllowance: 'block' });
    expect(res.status).toBe(201);
    const type = await data<{ id: string }>(res);
    expect(type).toMatchObject({ name: 'Training', color: '#00ff00', isPaid: true, requiresApproval: true, defaultAllowanceDays: 3, overAllowance: 'block', isActive: true });

    const updated = await admin().send('PATCH', `/leave-types/${type.id}`, { requiresApproval: false, defaultAllowanceDays: null });
    expect(updated.status).toBe(200);
    expect(await data(updated)).toMatchObject({ requiresApproval: false, defaultAllowanceDays: null, name: 'Training' });
  });

  it('validates, is a 404 for an unknown type and needs employees:manage', async () => {
    const invalid = await admin().send('POST', '/leave-types', { overAllowance: 'maybe', defaultAllowanceDays: 400 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Name is required. Default allowance days must be at most 366. Over allowance must be one of allow, block');
    expect((await admin().send('PATCH', '/leave-types/hrlvt_nope', { name: 'X' })).status).toBe(404);
    expect((await admin().send('DELETE', '/leave-types/hrlvt_nope')).status).toBe(404);
    await seedLeaveType('hrlvt_train', 'Training');
    expect((await as('leave:create').send('POST', '/leave-types', { name: 'X' })).status).toBe(403);
    expect((await as('leave:update').send('PATCH', '/leave-types/hrlvt_train', { name: 'X' })).status).toBe(403);
    expect((await as('leave:delete').send('DELETE', '/leave-types/hrlvt_train')).status).toBe(403);
  });

  it('deletes an unused type with its allowances, and archives one with history', async () => {
    await seedLeaveType('hrlvt_unused', 'Unused');
    await db.insert(schema.hrLeaveAllowances).values({ id: 'hrlva_u1', employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_unused', year: 2026, days: 2 });
    const deleted = await admin().send('DELETE', '/leave-types/hrlvt_unused');
    expect(deleted.status).toBe(200);
    expect(await data(deleted)).toEqual({ archived: false });
    expect(await db.select().from(schema.hrLeaveTypes).where(eq(schema.hrLeaveTypes.id, 'hrlvt_unused'))).toHaveLength(0);
    expect(await db.select().from(schema.hrLeaveAllowances)).toHaveLength(0);

    await seedLeaveType('hrlvt_used', 'Used');
    await seedLeaveRequest('hrlvr_u1', 'hremp_ann', 'hrlvt_used', '2026-03-02', '2026-03-02', 1);
    const archived = await admin().send('DELETE', '/leave-types/hrlvt_used');
    expect(await data(archived)).toEqual({ archived: true });
    const [row] = await db.select().from(schema.hrLeaveTypes).where(eq(schema.hrLeaveTypes.id, 'hrlvt_used'));
    expect(row!.isActive).toBe(false);
  });
});

describe('/leave-allowances', () => {
  it('pro-rates the yearly allowance for someone who starts mid-year', async () => {
    await seedEmployee(db, { id: 'hremp_cleo', firstName: 'Cleo', email: 'cleo@example.com', startDate: '2026-07-01' });
    const res = await admin().get('/leave-allowances/balances/hremp_cleo?year=2026');
    expect(res.status).toBe(200);
    const balances = await data<Array<{ leaveTypeId: string }>>(res);
    expect(balances.map((b) => b.leaveTypeId)).toEqual(['hrlvt_default_annual', 'hrlvt_default_sick', 'hrlvt_default_unpaid']);
    expect(balances[0]).toEqual({
      leaveTypeId: 'hrlvt_default_annual',
      name: 'Annual leave',
      color: '#3b82f6',
      isPaid: true,
      overAllowance: 'allow',
      allowance: 10,
      fullAllowance: 20,
      prorated: true,
      used: 0,
      pending: 0,
      remaining: 10,
    });
    expect(balances[1]).toMatchObject({ allowance: null, fullAllowance: null, prorated: false, remaining: null });
  });

  it('counts approved and pending days of the year, and an override replaces the default', async () => {
    await seedLeaveRequest('hrlvr_b1', 'hremp_ann', 'hrlvt_default_annual', '2026-03-02', '2026-03-04', 3, { status: 'approved' });
    await seedLeaveRequest('hrlvr_b2', 'hremp_ann', 'hrlvt_default_annual', '2026-03-09', '2026-03-10', 2);
    await seedLeaveRequest('hrlvr_b3', 'hremp_ann', 'hrlvt_default_annual', '2026-03-16', '2026-03-16', 1, { status: 'rejected' });
    await seedLeaveRequest('hrlvr_b4', 'hremp_ann', 'hrlvt_default_annual', '2025-03-16', '2025-03-16', 1, { status: 'approved' });

    const before = await data<Array<Record<string, unknown>>>(await admin().get('/leave-allowances/balances/hremp_ann?year=2026'));
    expect(before[0]).toMatchObject({ allowance: 20, prorated: false, used: 3, pending: 2, remaining: 17 });

    const set = await admin().send('PUT', '/leave-allowances', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', year: 2026, days: 25.5 });
    expect(set.status).toBe(200);
    const allowance = await data<{ id: string }>(set);
    expect(allowance).toMatchObject({ employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', year: 2026, days: 25.5 });

    const after = await data<Array<Record<string, unknown>>>(await admin().get('/leave-allowances/balances/hremp_ann?year=2026'));
    expect(after[0]).toMatchObject({ allowance: 25.5, fullAllowance: 25.5, prorated: false, remaining: 22.5 });

    const again = await admin().send('PUT', '/leave-allowances', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', year: 2026, days: 26 });
    expect(await data(again)).toMatchObject({ id: allowance.id, days: 26 });
    expect((await admin().get('/leave-allowances/balances/hremp_ann')).status).toBe(200);
  });

  it('refuses unknown employees and types, a bad body and callers without the grants', async () => {
    expect((await admin().get('/leave-allowances/balances/hremp_nope?year=2026')).status).toBe(404);
    expect((await as('attendance:read').get('/leave-allowances/balances/hremp_ann')).status).toBe(403);
    expect((await admin().send('PUT', '/leave-allowances', { employeeId: 'hremp_nope', leaveTypeId: 'hrlvt_default_annual', year: 2026, days: 1 })).status).toBe(404);
    expect((await admin().send('PUT', '/leave-allowances', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_nope', year: 2026, days: 1 })).status).toBe(404);
    const invalid = await admin().send('PUT', '/leave-allowances', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', year: 1999, days: -1 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Year must be at least 2000. Days must be at least 0');
    expect((await as('leave:read').send('PUT', '/leave-allowances', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', year: 2026, days: 1 })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

describe('GET /leave-requests', () => {
  it('lists requests latest first with employee, type and reviewer, and filters them', async () => {
    await seedLeaveRequest('hrlvr_l1', 'hremp_ann', 'hrlvt_default_annual', '2026-03-02', '2026-03-03', 2, {
      status: 'approved',
      reviewedBy: HR_ADMIN,
      reviewedAt: new Date('2026-02-20T10:00:00Z'),
    });
    await seedLeaveRequest('hrlvr_l2', 'hremp_ben', 'hrlvt_default_sick', '2026-04-06', '2026-04-07', 2);
    await seedLeaveRequest('hrlvr_l3', 'hremp_ann', 'hrlvt_gone', '2026-05-04', '2026-05-04', 1, { status: 'rejected' });

    const res = await admin().get('/leave-requests');
    expect(res.status).toBe(200);
    const rows = await data<Array<{ id: string }>>(res);
    expect(ids(rows)).toEqual(['hrlvr_l3', 'hrlvr_l2', 'hrlvr_l1']);
    expect(rows[0]).toMatchObject({ leaveTypeName: null, leaveTypeColor: null, employeeName: 'Ann Anders' });
    expect(rows[2]).toMatchObject({ leaveTypeName: 'Annual leave', leaveTypeColor: '#3b82f6', reviewedByName: 'Hanna Admin', days: 2 });

    const list = async (query: string) => ids(await data(await admin().get(`/leave-requests${query}`)));
    expect(await list('?employeeId=hremp_ben')).toEqual(['hrlvr_l2']);
    expect(await list('?status=approved,rejected')).toEqual(['hrlvr_l3', 'hrlvr_l1']);
    expect(await list('?from=2026-04-01')).toEqual(['hrlvr_l3', 'hrlvr_l2']);
    expect(await list('?to=2026-04-30')).toEqual(['hrlvr_l2', 'hrlvr_l1']);
    expect((await as('attendance:read').get('/leave-requests')).status).toBe(403);
  });
});

describe('POST /leave-requests', () => {
  it('counts working days, and approves a type that needs no approval straight away', async () => {
    const res = await admin().send('POST', '/leave-requests', {
      employeeId: 'hremp_ann',
      leaveTypeId: 'hrlvt_default_annual',
      startDate: '2026-03-02',
      endDate: '2026-03-08',
      reason: 'Holiday',
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ days: 5, status: 'pending', requestedBy: HR_ADMIN, reviewedAt: null, reviewedBy: null, reason: 'Holiday' });

    const sick = await admin().send('POST', '/leave-requests', {
      employeeId: 'hremp_ben',
      leaveTypeId: 'hrlvt_default_sick',
      startDate: '2026-03-09',
      endDate: '2026-03-10',
    });
    expect(sick.status).toBe(201);
    const auto = await data<{ reviewedAt: string | null }>(sick);
    expect(auto).toMatchObject({ days: 2, status: 'approved', reviewedBy: null, reason: null });
    expect(auto.reviewedAt).not.toBeNull();

    const half = await admin().send('POST', '/leave-requests', {
      employeeId: 'hremp_ben',
      leaveTypeId: 'hrlvt_default_annual',
      startDate: '2026-03-11',
      endDate: '2026-03-11',
      days: 0.5,
    });
    expect(await data(half)).toMatchObject({ days: 0.5 });
  });

  it('refuses overlaps, weekends, reversed dates, multi-year spans and archived types', async () => {
    await seedLeaveRequest('hrlvr_x1', 'hremp_ann', 'hrlvt_default_annual', '2026-03-02', '2026-03-06', 5);
    await seedLeaveType('hrlvt_old', 'Old leave', { isActive: false });
    const post = (body: Record<string, unknown>) =>
      admin().send('POST', '/leave-requests', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', ...body });
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ startDate: '2026-03-06', endDate: '2026-03-09' }, 409, 'This overlaps another leave request'],
      [{ startDate: '2026-03-14', endDate: '2026-03-15' }, 400, 'The selected dates contain no working days'],
      [{ startDate: '2026-03-20', endDate: '2026-03-19' }, 400, 'Leave: end date is before start date'],
      [{ startDate: '2026-12-30', endDate: '2028-01-03' }, 400, 'Split leave that spans more than one year into separate requests'],
      [{ leaveTypeId: 'hrlvt_old', startDate: '2026-03-16', endDate: '2026-03-16' }, 400, 'This leave type is no longer available'],
    ];
    for (const [body, status, message] of cases) {
      const res = await post(body);
      expect(res.status).toBe(status);
      expect((await errorOf(res)).message).toBe(message);
    }
    expect((await post({ employeeId: 'hremp_nope', startDate: '2026-03-16', endDate: '2026-03-16' })).status).toBe(404);
    expect((await post({ leaveTypeId: 'hrlvt_nope', startDate: '2026-03-16', endDate: '2026-03-16' })).status).toBe(404);
  });

  it('refuses going over a blocking allowance, counting other pending requests', async () => {
    await seedLeaveType('hrlvt_train', 'Training', { defaultAllowanceDays: 3, overAllowance: 'block' });
    const post = (startDate: string, endDate: string) =>
      admin().send('POST', '/leave-requests', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_train', startDate, endDate });

    const tooLong = await post('2026-03-02', '2026-03-06');
    expect(tooLong.status).toBe(409);
    expect((await errorOf(tooLong)).message).toBe('This request is 5 days, but only 3 days of Training are left, and Training cannot go over the allowance');

    expect((await post('2026-03-09', '2026-03-10')).status).toBe(201);
    const pending = await post('2026-03-16', '2026-03-17');
    expect(pending.status).toBe(409);
    expect((await errorOf(pending)).message).toBe('This request is 2 days, but only 1 days of Training are left, and Training cannot go over the allowance');
  });

  it('validates the body and needs leave:create', async () => {
    const invalid = await admin().send('POST', '/leave-requests', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', startDate: '2026-03-02', days: 0.25 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('End date is required. Days must be at least 0.5');
    expect((await as('leave:read').send('POST', '/leave-requests', { employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_default_annual', startDate: '2026-03-02', endDate: '2026-03-02' })).status).toBe(403);
  });
});

describe('POST /leave-requests/:leaveRequestId/review', () => {
  beforeEach(async () => {
    await seedLeaveRequest('hrlvr_r1', 'hremp_ann', 'hrlvt_default_annual', '2026-03-02', '2026-03-03', 2);
    await seedLeaveRequest('hrlvr_r2', 'hremp_ben', 'hrlvt_default_annual', '2026-03-02', '2026-03-03', 2);
  });

  it('approves and rejects a pending request once', async () => {
    const approved = await admin().send('POST', '/leave-requests/hrlvr_r1/review', { decision: 'approved', note: 'Enjoy' });
    expect(approved.status).toBe(200);
    expect(await data(approved)).toMatchObject({ id: 'hrlvr_r1', status: 'approved', reviewNote: 'Enjoy', reviewedBy: HR_ADMIN });

    const rejected = await admin().send('POST', '/leave-requests/hrlvr_r2/review', { decision: 'rejected' });
    expect(await data(rejected)).toMatchObject({ status: 'rejected', reviewNote: null });

    const again = await admin().send('POST', '/leave-requests/hrlvr_r1/review', { decision: 'rejected' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This request is already approved');
  });

  it('refuses approving past a blocking allowance, an unknown request, a bad body and a caller without leave:approve', async () => {
    await seedLeaveType('hrlvt_train', 'Training', { defaultAllowanceDays: 3, overAllowance: 'block' });
    await seedLeaveRequest('hrlvr_t1', 'hremp_ann', 'hrlvt_train', '2026-03-09', '2026-03-10', 2);
    await db.insert(schema.hrLeaveAllowances).values({ id: 'hrlva_t1', employeeId: 'hremp_ann', leaveTypeId: 'hrlvt_train', year: 2026, days: 1.5 });
    const over = await admin().send('POST', '/leave-requests/hrlvr_t1/review', { decision: 'approved' });
    expect(over.status).toBe(409);
    expect((await errorOf(over)).message).toBe('This request is 2 days, but only 1.5 days of Training are left, and Training cannot go over the allowance');

    expect((await admin().send('POST', '/leave-requests/hrlvr_nope/review', { decision: 'approved' })).status).toBe(404);
    const invalid = await admin().send('POST', '/leave-requests/hrlvr_r1/review', { decision: 'yes' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Decision must be one of approved, rejected');
    expect((await as('leave:update').send('POST', '/leave-requests/hrlvr_r1/review', { decision: 'approved' })).status).toBe(403);
  });
});

describe('POST /leave-requests/:leaveRequestId/cancel and DELETE', () => {
  beforeEach(async () => {
    await seedLeaveRequest('hrlvr_c1', 'hremp_ann', 'hrlvt_default_annual', '2026-03-02', '2026-03-03', 2, { status: 'approved' });
    await seedLeaveRequest('hrlvr_c2', 'hremp_ben', 'hrlvt_default_annual', '2026-03-02', '2026-03-03', 2, { status: 'rejected' });
  });

  it('lets HR cancel approved leave, once', async () => {
    const res = await admin().send('POST', '/leave-requests/hrlvr_c1/cancel');
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrlvr_c1', status: 'cancelled' });
    const again = await admin().send('POST', '/leave-requests/hrlvr_c1/cancel');
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This request is already cancelled');
    const rejected = await admin().send('POST', '/leave-requests/hrlvr_c2/cancel');
    expect(rejected.status).toBe(409);
    expect((await errorOf(rejected)).message).toBe('This request is already rejected');
    expect((await admin().send('POST', '/leave-requests/hrlvr_nope/cancel')).status).toBe(404);
    expect((await as('leave:read').send('POST', '/leave-requests/hrlvr_c1/cancel')).status).toBe(403);
  });

  it('deletes a request', async () => {
    expect((await as('leave:update').send('DELETE', '/leave-requests/hrlvr_c1')).status).toBe(403);
    expect((await admin().send('DELETE', '/leave-requests/hrlvr_c1')).status).toBe(204);
    expect(await db.select().from(schema.hrLeaveRequests).where(eq(schema.hrLeaveRequests.id, 'hrlvr_c1'))).toHaveLength(0);
    expect((await admin().send('DELETE', '/leave-requests/hrlvr_c1')).status).toBe(404);
  });
});
