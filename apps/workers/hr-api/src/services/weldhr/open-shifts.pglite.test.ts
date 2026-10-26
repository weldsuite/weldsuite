/**
 * Open shifts: HR posts a shift with a number of spots, employees sign up, a
 * manager approves who gets it. The last spot taken turns down whoever is
 * still waiting, a shift meant for a department stays out of everyone else's
 * sight, and withdrawing it cancels the sign-ups still waiting.
 *
 * "Now" is Monday 16 March 2026, 08:00 UTC. The open shift is Saturday.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  OPEN_SHIFT_FULL_NOTE,
  cancelOpenShift,
  createOpenShift,
  listOpenShifts,
  openShiftsForEmployee,
  settleOpenShift,
  updateOpenShift,
} from './open-shifts';
import {
  cancelShiftRequest,
  claimOpenShiftSpot,
  listShiftRequests,
  reviewShiftRequest,
  signUpForOpenShift,
} from './shift-requests';
import { deleteShift } from './time';

let db: Database;

const now = new Date('2026-03-16T08:00:00Z');
const sat = (time: string) => `2026-03-21T${time}:00Z`;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.hrDepartments).values([
    { id: 'dep_store', name: 'Store' },
    { id: 'dep_tills', name: 'Tills', parentId: 'dep_store' },
    { id: 'dep_office', name: 'Office' },
  ]);
  await db.insert(schema.hrEmployees).values([
    { id: 'emp_os_ann', firstName: 'Ann', lastName: 'Adams', email: 'ann@example.com', status: 'active', departmentId: 'dep_tills' },
    { id: 'emp_os_ben', firstName: 'Ben', lastName: 'Baker', email: 'ben@example.com', status: 'active', departmentId: 'dep_store' },
    { id: 'emp_os_cas', firstName: 'Cas', lastName: 'Cole', email: 'cas@example.com', status: 'active', departmentId: 'dep_tills' },
    { id: 'emp_os_dex', firstName: 'Dex', lastName: 'Dean', email: 'dex@example.com', status: 'active', departmentId: 'dep_office' },
  ]);
}, 60_000);

describe('posting an open shift', () => {
  it('checks the window and the break, and needs it to end ahead', async () => {
    await expect(createOpenShift(db, { startsAt: sat('17:00'), endsAt: sat('09:00') }, 'user_hr', now)).rejects.toThrow(
      'must end after it starts',
    );
    await expect(
      createOpenShift(db, { startsAt: '2026-03-15T09:00:00Z', endsAt: '2026-03-15T17:00:00Z' }, 'user_hr', now),
    ).rejects.toThrow('end in the future');
    await expect(
      createOpenShift(db, { startsAt: sat('09:00'), endsAt: sat('17:00'), breakStartsAt: sat('12:00') }, 'user_hr', now),
    ).rejects.toThrow('both a start and an end');
  });
});

describe('signing up and approving', () => {
  let openShiftId: string;

  beforeAll(async () => {
    const row = await createOpenShift(
      db,
      {
        startsAt: sat('09:00'),
        endsAt: sat('17:00'),
        breakStartsAt: sat('12:00'),
        breakEndsAt: sat('12:30'),
        workType: ' Cashier ',
        departmentId: 'dep_store',
        spots: 2,
      },
      'user_hr',
      now,
    );
    openShiftId = row.id;
  });

  it('is offered to the department and the ones under it, not to others', async () => {
    expect((await openShiftsForEmployee(db, 'emp_os_ann', now)).map((s) => s.id)).toEqual([openShiftId]);
    expect((await openShiftsForEmployee(db, 'emp_os_ben', now)).map((s) => s.id)).toEqual([openShiftId]);
    expect(await openShiftsForEmployee(db, 'emp_os_dex', now)).toEqual([]);
    await expect(signUpForOpenShift(db, 'emp_os_dex', openShiftId, {}, 'user_dex', now)).rejects.toThrow('not found');
  });

  it('turns a sign-up into a waiting request with the shift’s times, once per person', async () => {
    const request = await signUpForOpenShift(db, 'emp_os_ann', openShiftId, { note: 'Happy to' }, 'user_ann', now);
    expect(request).toMatchObject({ status: 'pending', openShiftId, workType: 'Cashier', note: 'Happy to' });
    expect(request.startsAt).toEqual(new Date(sat('09:00')));
    await expect(signUpForOpenShift(db, 'emp_os_ann', openShiftId, {}, 'user_ann', now)).rejects.toThrow('already signed up');

    const [mine] = await openShiftsForEmployee(db, 'emp_os_ann', now);
    expect(mine?.myRequest).toMatchObject({ id: request.id, status: 'pending' });
    const [listed] = await listOpenShifts(db, { id: openShiftId });
    expect(listed).toMatchObject({ spots: 2, filled: 0, pending: 1, spotsLeft: 2 });
  });

  it('puts an approved sign-up on the rooster with the open shift’s break', async () => {
    const [request] = await listShiftRequests(db, { employeeId: 'emp_os_ann', status: 'pending' });
    const approved = await reviewShiftRequest(db, request!.id, { decision: 'approved' }, 'user_manager');
    const [shift] = await db.select().from(schema.hrShifts).where(eq(schema.hrShifts.id, approved.shiftId!));
    expect(shift).toMatchObject({ employeeId: 'emp_os_ann', workType: 'Cashier' });
    expect(shift?.breakStartsAt).toEqual(new Date(sat('12:00')));
    expect(await settleOpenShift(db, openShiftId, 'user_manager')).toEqual([]);
    await expect(signUpForOpenShift(db, 'emp_os_ann', openShiftId, {}, 'user_ann', now)).rejects.toThrow('already on this shift');
  });

  it('fixes the times once someone is on it, and keeps the spots at least what is taken', async () => {
    await expect(updateOpenShift(db, openShiftId, { startsAt: sat('10:00') })).rejects.toThrow('Someone is already on this shift');
    await expect(updateOpenShift(db, openShiftId, { spots: 0 })).rejects.toThrow();
    expect((await updateOpenShift(db, openShiftId, { notes: 'Bring your badge' })).notes).toBe('Bring your badge');
  });

  it('turns down whoever is still waiting when the last spot is taken', async () => {
    const ben = await signUpForOpenShift(db, 'emp_os_ben', openShiftId, {}, 'user_ben', now);
    const cas = await signUpForOpenShift(db, 'emp_os_cas', openShiftId, {}, 'user_cas', now);
    await reviewShiftRequest(db, ben.id, { decision: 'approved' }, 'user_manager');
    const closed = await settleOpenShift(db, openShiftId, 'user_manager');
    expect(closed).toEqual([{ id: cas.id, employeeId: 'emp_os_cas', status: 'rejected' }]);
    const [casNow] = await listShiftRequests(db, { id: cas.id });
    expect(casNow?.reviewNote).toBe(OPEN_SHIFT_FULL_NOTE);

    // Full: no longer offered to someone who did not sign up.
    expect((await listOpenShifts(db, { id: openShiftId }))[0]).toMatchObject({ filled: 2, spotsLeft: 0 });
    await expect(signUpForOpenShift(db, 'emp_os_cas', openShiftId, {}, 'user_cas', now)).rejects.toThrow('All spots');
  });

  it('frees the spot again when the shift is taken off the rooster', async () => {
    const [ben] = await listShiftRequests(db, { employeeId: 'emp_os_ben', status: 'approved' });
    await deleteShift(db, ben!.shiftId!);
    expect((await listOpenShifts(db, { id: openShiftId }))[0]).toMatchObject({ filled: 1, spotsLeft: 1 });
    expect((await openShiftsForEmployee(db, 'emp_os_cas', now)).map((s) => s.id)).toContain(openShiftId);
  });

  it('refuses to approve a sign-up past the spots', async () => {
    const cas = await signUpForOpenShift(db, 'emp_os_cas', openShiftId, {}, 'user_cas', now);
    await updateOpenShift(db, openShiftId, { spots: 1 });
    await expect(reviewShiftRequest(db, cas.id, { decision: 'approved' }, 'user_manager')).rejects.toThrow('All spots');
    const [still] = await listShiftRequests(db, { id: cas.id });
    expect(still?.status).toBe('pending');
    await cancelShiftRequest(db, cas.id, 'emp_os_cas');
  });
});

describe('two managers approving the last spot at once', () => {
  it('keeps the spot for the approval that got there first, and leaves no shift behind for the other', async () => {
    const open = await createOpenShift(db, { startsAt: '2026-03-22T09:00:00Z', endsAt: '2026-03-22T13:00:00Z', spots: 1 }, 'user_hr', now);
    const ann = await signUpForOpenShift(db, 'emp_os_ann', open.id, {}, 'user_ann', now);
    const ben = await signUpForOpenShift(db, 'emp_os_ben', open.id, {}, 'user_ben', now);
    // Both managers read the open shift while its spot was still free.
    const seenByBoth = (await db.select().from(schema.hrOpenShifts).where(eq(schema.hrOpenShifts.id, open.id)))[0]!;
    const shiftsBefore = (await db.select().from(schema.hrShifts)).length;

    expect((await claimOpenShiftSpot(db, ann, seenByBoth, null, 'user_manager_1')).status).toBe('approved');
    await expect(claimOpenShiftSpot(db, ben, seenByBoth, null, 'user_manager_2')).rejects.toThrow('All spots');

    const [benNow] = await listShiftRequests(db, { id: ben.id });
    expect(benNow).toMatchObject({ status: 'pending', shiftId: null });
    expect(await db.select().from(schema.hrShifts)).toHaveLength(shiftsBefore + 1);
    expect((await listOpenShifts(db, { id: open.id }))[0]).toMatchObject({ filled: 1, spotsLeft: 0 });
  });

  it('says so when the same sign-up was answered in the meantime', async () => {
    const open = await createOpenShift(db, { startsAt: '2026-03-22T14:00:00Z', endsAt: '2026-03-22T18:00:00Z', spots: 2 }, 'user_hr', now);
    const cas = await signUpForOpenShift(db, 'emp_os_cas', open.id, {}, 'user_cas', now);
    const openRow = (await db.select().from(schema.hrOpenShifts).where(eq(schema.hrOpenShifts.id, open.id)))[0]!;
    await reviewShiftRequest(db, cas.id, { decision: 'rejected' }, 'user_manager_1');
    const shiftsBefore = (await db.select().from(schema.hrShifts)).length;
    await expect(claimOpenShiftSpot(db, cas, openRow, null, 'user_manager_2')).rejects.toThrow('answered in the meantime');
    expect(await db.select().from(schema.hrShifts)).toHaveLength(shiftsBefore);
  });
});

describe('withdrawing an open shift', () => {
  it('cancels the sign-ups still waiting and stops new ones', async () => {
    const row = await createOpenShift(db, { startsAt: sat('18:00'), endsAt: sat('22:00') }, 'user_hr', now);
    const dex = await signUpForOpenShift(db, 'emp_os_dex', row.id, {}, 'user_dex', now);
    const { row: withdrawn, closed } = await cancelOpenShift(db, row.id, 'user_hr');
    expect(withdrawn.status).toBe('cancelled');
    expect(closed).toEqual([{ id: dex.id, employeeId: 'emp_os_dex', status: 'cancelled' }]);
    await expect(signUpForOpenShift(db, 'emp_os_ann', row.id, {}, 'user_ann', now)).rejects.toThrow('withdrawn');
    expect((await openShiftsForEmployee(db, 'emp_os_dex', now)).map((s) => s.id)).not.toContain(row.id);
    await expect(cancelOpenShift(db, row.id, 'user_hr')).rejects.toThrow('already withdrawn');
  });
});
