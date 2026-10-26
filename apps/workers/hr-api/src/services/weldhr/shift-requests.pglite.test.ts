/**
 * Shift requests: an employee asks to work a shift, withdraws it while it is
 * waiting, and a manager approves (which puts the shift on the rooster) or
 * rejects it. The employee's week shows the ones still waiting or turned down.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { employeeAttendance } from './self-service';
import { cancelShiftRequest, listShiftRequests, requestShift, reviewShiftRequest } from './shift-requests';

let db: Database;

// "Now" in these tests: Monday 16 March 2026, 08:00 UTC.
const now = new Date('2026-03-16T08:00:00Z');
const at = (iso: string) => `2026-03-${iso}:00Z`;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.hrEmployees).values([
    { id: 'emp_sr_bo', firstName: 'Bo', lastName: 'Berg', email: 'bo@example.com', status: 'active' },
  ]);
  await db.insert(schema.hrShifts).values([
    { id: 'sh_sr_tue', employeeId: 'emp_sr_bo', startsAt: new Date(at('17T09:00')), endsAt: new Date(at('17T17:00')) },
  ]);
}, 60_000);

describe('requestShift', () => {
  it('asks for a shift ahead, waiting for a manager', async () => {
    const row = await requestShift(
      db,
      'emp_sr_bo',
      { startsAt: at('18T13:00'), endsAt: at('18T21:00'), workType: ' Cashier ', note: 'I can do the evening' },
      'user_bo',
      now,
    );
    expect(row).toMatchObject({ status: 'pending', workType: 'Cashier', note: 'I can do the evening', shiftId: null });
  });

  it('refuses one that has started, overlaps a shift, or overlaps a request still waiting', async () => {
    await expect(
      requestShift(db, 'emp_sr_bo', { startsAt: at('16T07:00'), endsAt: at('16T12:00') }, 'user_bo', now),
    ).rejects.toThrow('has not started yet');
    await expect(
      requestShift(db, 'emp_sr_bo', { startsAt: at('17T16:00'), endsAt: at('17T20:00') }, 'user_bo', now),
    ).rejects.toThrow('You already have a shift at this time');
    await expect(
      requestShift(db, 'emp_sr_bo', { startsAt: at('18T20:00'), endsAt: at('18T23:00') }, 'user_bo', now),
    ).rejects.toThrow('You already asked for a shift at this time');
  });

  it('may start where a shift ends', async () => {
    const row = await requestShift(db, 'emp_sr_bo', { startsAt: at('17T17:00'), endsAt: at('17T20:00') }, 'user_bo', now);
    expect(row.status).toBe('pending');
    await cancelShiftRequest(db, row.id, 'emp_sr_bo');
  });
});

describe('reviewing and withdrawing', () => {
  it('puts the shift on the rooster when approved, and links it', async () => {
    const asked = await requestShift(
      db,
      'emp_sr_bo',
      { startsAt: at('19T09:00'), endsAt: at('19T13:00'), workType: 'Stock' },
      'user_bo',
      now,
    );
    const row = await reviewShiftRequest(db, asked.id, { decision: 'approved' }, 'user_manager');
    expect(row.status).toBe('approved');
    expect(row.shiftId).toBeTruthy();
    const [shift] = await db.select().from(schema.hrShifts).where(eq(schema.hrShifts.id, row.shiftId!));
    expect(shift).toMatchObject({ employeeId: 'emp_sr_bo', workType: 'Stock', createdBy: 'user_manager' });
    expect(shift?.startsAt).toEqual(new Date(at('19T09:00')));
    await expect(reviewShiftRequest(db, asked.id, { decision: 'rejected' }, 'user_manager')).rejects.toThrow('already approved');
  });

  it('rejects with a note and creates nothing', async () => {
    const asked = await requestShift(db, 'emp_sr_bo', { startsAt: at('20T09:00'), endsAt: at('20T13:00') }, 'user_bo', now);
    const before = await db.select().from(schema.hrShifts);
    const row = await reviewShiftRequest(db, asked.id, { decision: 'rejected', note: 'Fully staffed' }, 'user_manager');
    expect(row).toMatchObject({ status: 'rejected', reviewNote: 'Fully staffed', shiftId: null });
    expect(await db.select().from(schema.hrShifts)).toHaveLength(before.length);
  });

  it('refuses to approve onto a shift that was planned in the meantime', async () => {
    const asked = await requestShift(db, 'emp_sr_bo', { startsAt: at('23T09:00'), endsAt: at('23T13:00') }, 'user_bo', now);
    await db.insert(schema.hrShifts).values({
      id: 'sh_sr_mon',
      employeeId: 'emp_sr_bo',
      startsAt: new Date(at('23T08:00')),
      endsAt: new Date(at('23T12:00')),
    });
    await expect(reviewShiftRequest(db, asked.id, { decision: 'approved' }, 'user_manager')).rejects.toThrow('overlaps');
    const [still] = await listShiftRequests(db, { id: asked.id });
    expect(still?.status).toBe('pending');
  });

  it('lets only the employee withdraw a request still waiting', async () => {
    const asked = await requestShift(db, 'emp_sr_bo', { startsAt: at('24T09:00'), endsAt: at('24T13:00') }, 'user_bo', now);
    await expect(cancelShiftRequest(db, asked.id, 'emp_someone_else')).rejects.toThrow('not found');
    expect((await cancelShiftRequest(db, asked.id, 'emp_sr_bo')).status).toBe('cancelled');
    await expect(cancelShiftRequest(db, asked.id, 'emp_sr_bo')).rejects.toThrow('already cancelled');
  });
});

describe('the employee week', () => {
  it('shows requests waiting or turned down, not approved or withdrawn ones', async () => {
    const week = await employeeAttendance(db, 'emp_sr_bo', '2026-03-16', '2026-03-22', { withRequests: true });
    const statuses = (week.requests ?? []).map((r) => r.status).sort();
    expect(statuses).toEqual(['pending', 'rejected']);
    expect(week.requests?.find((r) => r.status === 'rejected')).toMatchObject({ reviewNote: 'Fully staffed' });
  });

  it('leaves requests out unless asked (the public portal)', async () => {
    const week = await employeeAttendance(db, 'emp_sr_bo', '2026-03-16', '2026-03-22');
    expect(week).not.toHaveProperty('requests');
  });
});
