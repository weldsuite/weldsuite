/**
 * Self-service clocking: which shift a clock-in lands on, and switching to
 * another shift while clocked in.
 *
 * "Now" is Wednesday 18 March 2026 throughout. Ann works a morning and an
 * afternoon shift that day.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { clock, openClockRecord, switchShift } from './time';
import { HrConflictError, HrNotFoundError, HrValidationError } from './shared';

const at = (time: string) => new Date(`2026-03-18T${time}:00Z`);

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  await db.insert(schema.hrEmployees).values([
    { id: 'emp_ann', firstName: 'Ann', lastName: 'Adams', email: 'ann@example.com', status: 'active' },
    { id: 'emp_ben', firstName: 'Ben', lastName: 'Baker', email: 'ben@example.com', status: 'active' },
  ]);
  await db.insert(schema.hrShifts).values([
    { id: 'sh_morning', employeeId: 'emp_ann', startsAt: at('08:00'), endsAt: at('12:00') },
    { id: 'sh_afternoon', employeeId: 'emp_ann', startsAt: at('13:00'), endsAt: at('17:00') },
    {
      id: 'sh_tomorrow',
      employeeId: 'emp_ann',
      startsAt: new Date('2026-03-19T08:00:00Z'),
      endsAt: new Date('2026-03-19T12:00:00Z'),
    },
    { id: 'sh_ben', employeeId: 'emp_ben', startsAt: at('13:00'), endsAt: at('17:00') },
  ]);
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.hrAttendanceRecords);
});

describe('clock', () => {
  it('clocks in on the first of today’s shifts that has not ended', async () => {
    const record = await clock(db, 'emp_ann', 'in', at('12:30'));
    expect(record.shiftId).toBe('sh_afternoon');
  });

  it('clocks in on the shift it is given', async () => {
    const record = await clock(db, 'emp_ann', 'in', at('07:55'), 'user_ann', 'sh_afternoon');
    expect(record.shiftId).toBe('sh_afternoon');
  });

  it('keeps that shift when clocking out', async () => {
    await clock(db, 'emp_ann', 'in', at('12:30'));
    const record = await clock(db, 'emp_ann', 'out', at('17:00'));
    expect(record).toMatchObject({ shiftId: 'sh_afternoon', workedMinutes: 270 });
  });

  it('refuses someone else’s shift, one that has ended and one on a later day', async () => {
    await expect(clock(db, 'emp_ann', 'in', at('13:00'), 'user_ann', 'sh_ben')).rejects.toBeInstanceOf(HrNotFoundError);
    await expect(clock(db, 'emp_ann', 'in', at('13:00'), 'user_ann', 'sh_morning')).rejects.toBeInstanceOf(HrValidationError);
    await expect(clock(db, 'emp_ann', 'in', at('13:00'), 'user_ann', 'sh_tomorrow')).rejects.toBeInstanceOf(HrValidationError);
  });
});

describe('switchShift', () => {
  it('clocks out of the open record and straight in on the new shift', async () => {
    await clock(db, 'emp_ann', 'in', at('08:00'));
    const { closed, opened } = await switchShift(db, 'emp_ann', 'sh_afternoon', at('11:30'));

    expect(closed).toMatchObject({ shiftId: 'sh_morning', workedMinutes: 210 });
    expect(closed.clockOut).toEqual(at('11:30'));
    expect(opened).toMatchObject({ shiftId: 'sh_afternoon', clockOut: null });
    expect(opened.clockIn).toEqual(at('11:30'));
    expect((await openClockRecord(db, 'emp_ann'))?.id).toBe(opened.id);
  });

  it('needs an open record, a shift to switch to, and a different shift', async () => {
    await expect(switchShift(db, 'emp_ann', 'sh_afternoon', at('11:30'))).rejects.toBeInstanceOf(HrConflictError);
    await clock(db, 'emp_ann', 'in', at('08:00'));
    await expect(switchShift(db, 'emp_ann', undefined, at('11:30'))).rejects.toBeInstanceOf(HrValidationError);
    await expect(switchShift(db, 'emp_ann', 'sh_morning', at('11:30'))).rejects.toBeInstanceOf(HrConflictError);
  });
});
