import { describe, expect, it } from 'vitest';
import { subtreeOf } from '../settings/components/department-tree';
import { isPhoneNumber } from '../employees/components/employee-field-rules';
import { instantAt, minutesAfter, workingDaysBetween } from './shared';

describe('minutesAfter', () => {
  it('measures a day shift', () => {
    expect(minutesAfter('09:00', '17:30')).toBe(510);
  });

  it('reads an end at or before the start as the next day (a night shift)', () => {
    expect(minutesAfter('22:00', '06:00')).toBe(480);
    expect(minutesAfter('09:00', '09:00')).toBe(24 * 60);
  });
});

describe('instantAt', () => {
  it('moves the time later by the given minutes, across midnight', () => {
    const start = new Date(instantAt('2026-11-03', '22:00'));
    const end = new Date(instantAt('2026-11-03', '22:00', 480));
    expect(end.getTime() - start.getTime()).toBe(480 * 60_000);
    expect(end.getDate()).toBe(4);
    expect(end.getHours()).toBe(6);
  });
});

describe('workingDaysBetween', () => {
  it('counts Monday to Friday, inclusive', () => {
    expect(workingDaysBetween('2026-10-12', '2026-10-16')).toBe(5);
    expect(workingDaysBetween('2026-11-02', '2026-12-31')).toBe(44);
  });

  it('is zero for a weekend or a reversed range', () => {
    expect(workingDaysBetween('2026-10-17', '2026-10-18')).toBe(0);
    expect(workingDaysBetween('2026-10-16', '2026-10-12')).toBe(0);
  });
});

describe('subtreeOf', () => {
  const departments = [
    { id: 'eng', parentId: null },
    { id: 'backend', parentId: 'eng' },
    { id: 'db', parentId: 'backend' },
    { id: 'sales', parentId: null },
  ];

  it('holds the department and everything below it', () => {
    expect([...subtreeOf(departments, 'eng')].sort()).toEqual(['backend', 'db', 'eng']);
    expect([...subtreeOf(departments, 'sales')]).toEqual(['sales']);
  });

  it('stops on a loop already in the data', () => {
    const looped = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect([...subtreeOf(looped, 'a')].sort()).toEqual(['a', 'b']);
  });
});

describe('isPhoneNumber', () => {
  it('accepts numbers with the usual separators', () => {
    expect(isPhoneNumber('+31 20 123 4567')).toBe(true);
    expect(isPhoneNumber('(020) 123-45.67')).toBe(true);
  });

  it('refuses letters and too few digits', () => {
    expect(isPhoneNumber('abc')).toBe(false);
    expect(isPhoneNumber('12-34')).toBe(false);
  });
});
