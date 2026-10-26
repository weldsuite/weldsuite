/**
 * My hours with pay: the hourly rate each clocked record earned at (and each
 * shift will), taken from the compensation in force on its day, and only when
 * the caller asks for it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { employeeAttendance, hourlyRateOf } from './portal-self-service';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  await db.insert(schema.hrEmployees).values([
    { id: 'emp_ann', firstName: 'Ann', lastName: 'Adams', email: 'ann@example.com', status: 'active' },
  ]);
  await db.insert(schema.hrCompensations).values([
    { id: 'comp_old', employeeId: 'emp_ann', effectiveFrom: '2026-01-01', effectiveTo: '2026-03-15', payType: 'hourly', amount: '15', period: 'hour', currency: 'EUR' },
    { id: 'comp_new', employeeId: 'emp_ann', effectiveFrom: '2026-03-16', payType: 'hourly', amount: '18.5', period: 'hour', currency: 'EUR' },
  ]);
  await db.insert(schema.hrAttendanceRecords).values([
    { id: 'att_before', employeeId: 'emp_ann', date: '2026-03-13', clockIn: new Date('2026-03-13T09:00:00Z'), clockOut: new Date('2026-03-13T17:00:00Z'), workedMinutes: 480 },
    { id: 'att_after', employeeId: 'emp_ann', date: '2026-03-17', clockIn: new Date('2026-03-17T09:00:00Z'), clockOut: new Date('2026-03-17T13:00:00Z'), workedMinutes: 240, shiftId: 'sh_after' },
  ]);
  await db.insert(schema.hrShifts).values([
    {
      id: 'sh_after',
      employeeId: 'emp_ann',
      startsAt: new Date('2026-03-17T09:00:00Z'),
      endsAt: new Date('2026-03-17T17:00:00Z'),
      workType: 'Cashier',
      breakStartsAt: new Date('2026-03-17T12:00:00Z'),
      breakEndsAt: new Date('2026-03-17T12:30:00Z'),
    },
  ]);
}, 60_000);

describe('hourlyRateOf', () => {
  it('takes an hourly wage as it is', () => {
    expect(hourlyRateOf({ payType: 'hourly', amount: '18.50', period: 'hour', hoursPerWeek: null })).toBe(18.5);
  });

  it('spreads a salary over its contract hours, 40 a week without them', () => {
    // 3,900 a month over 36 hours: 46,800 a year / 1,872 hours.
    expect(hourlyRateOf({ payType: 'salary', amount: '3900', period: 'month', hoursPerWeek: 36 })).toBeCloseTo(25, 6);
    expect(hourlyRateOf({ payType: 'salary', amount: '52000', period: 'year', hoursPerWeek: null })).toBeCloseTo(25, 6);
    expect(hourlyRateOf({ payType: 'salary', amount: '1000', period: 'week', hoursPerWeek: 40 })).toBeCloseTo(25, 6);
  });
});

describe('employeeAttendance', () => {
  it('gives each record the rate in force on its day when asked', async () => {
    const { records } = await employeeAttendance(db, 'emp_ann', '2026-03-01', '2026-03-31', { withPay: true });
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    expect(byId.att_before).toMatchObject({ hourlyRate: 15, currency: 'EUR' });
    expect(byId.att_after).toMatchObject({ hourlyRate: 18.5, currency: 'EUR' });
  });

  it('gives each shift its break, its work and the rate on its day, and each record its shift', async () => {
    const { records, shifts } = await employeeAttendance(db, 'emp_ann', '2026-03-01', '2026-03-31', { withPay: true });
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({ id: 'sh_after', workType: 'Cashier', hourlyRate: 18.5, currency: 'EUR' });
    expect(shifts[0]?.breakStartsAt).toEqual(new Date('2026-03-17T12:00:00Z'));
    expect(shifts[0]?.breakEndsAt).toEqual(new Date('2026-03-17T12:30:00Z'));
    expect(records.find((r) => r.id === 'att_after')?.shiftId).toBe('sh_after');
  });

  it('leaves pay out unless asked (the public portal)', async () => {
    const { records, shifts } = await employeeAttendance(db, 'emp_ann', '2026-03-01', '2026-03-31');
    expect(records.every((r) => r.hourlyRate === null && r.currency === null)).toBe(true);
    expect(shifts.every((s) => s.hourlyRate === null && s.currency === null)).toBe(true);
  });
});
