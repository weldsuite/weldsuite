import { describe, expect, it } from 'vitest';
import type { HrAbsence, HrLeaveRequest, HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import {
  buildDayStats,
  dayHourRange,
  hourlyCoverage,
  hoursWithinDay,
  monthGridWeeks,
  timeOffSpans,
  toTimeOff,
  type RosterEmployee,
  type TimeOff,
} from './schedule-model';

/** Monday 16 to Sunday 22 November 2026. */
const WEEK = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];

function timeOff(overrides: Partial<TimeOff>): TimeOff {
  return {
    id: 'to_1',
    employeeId: 'e1',
    kind: 'leave',
    pending: false,
    typeName: 'Holiday',
    color: '#14b8a6',
    startDate: '2026-11-18',
    endDate: '2026-11-20',
    ...overrides,
  };
}

/** A shift on 18 November 2026, local time. */
function shift(employeeId: string, start: [number, number], end: [number, number], id = `${employeeId}-${start[0]}`): HrShift {
  return {
    id,
    employeeId,
    employeeName: employeeId,
    companyId: null,
    companyName: null,
    startsAt: new Date(2026, 10, 18, ...start).toISOString(),
    endsAt: new Date(2026, 10, 18, ...end).toISOString(),
    workType: null,
    breakStartsAt: null,
    breakEndsAt: null,
    notes: null,
  };
}

function employee(id: string): RosterEmployee {
  return { id, name: id, avatarUrl: null, departmentName: null, jobTitle: null, clientIds: [] };
}

describe('toTimeOff', () => {
  it('keeps approved and pending leave plus every sick report, and drops rejected and cancelled leave', () => {
    const leave = (id: string, status: HrLeaveRequest['status']) =>
      ({ id, employeeId: 'e1', leaveTypeName: 'Holiday', leaveTypeColor: null, startDate: '2026-11-18', endDate: '2026-11-18', status }) as HrLeaveRequest;
    const sick = { id: 'a1', employeeId: 'e2', startDate: '2026-11-17', endDate: null } as HrAbsence;

    const items = toTimeOff([leave('l1', 'approved'), leave('l2', 'pending'), leave('l3', 'rejected'), leave('l4', 'cancelled')], [sick]);

    expect(items.map((i) => [i.id, i.kind, i.pending, i.endDate])).toEqual([
      ['l1', 'leave', false, '2026-11-18'],
      ['l2', 'leave', true, '2026-11-18'],
      ['a1', 'sick', false, null],
    ]);
  });
});

describe('timeOffSpans', () => {
  it('clips leave to the visible days and marks what runs past either edge', () => {
    const [span] = timeOffSpans([timeOff({ startDate: '2026-11-12', endDate: '2026-11-17' })], WEEK);
    expect(span).toMatchObject({ startIndex: 0, endIndex: 1, continuesBefore: true, continuesAfter: false, lane: 0 });
  });

  it('runs an open sick report to the end of the period', () => {
    const [span] = timeOffSpans([timeOff({ kind: 'sick', startDate: '2026-11-17', endDate: null })], WEEK);
    expect(span).toMatchObject({ startIndex: 1, endIndex: 6, continuesBefore: false, continuesAfter: true });
  });

  it('puts overlapping items in separate lanes and reuses a lane once it is free', () => {
    const spans = timeOffSpans(
      [
        timeOff({ id: 'a', startDate: '2026-11-16', endDate: '2026-11-18' }),
        timeOff({ id: 'b', startDate: '2026-11-18', endDate: '2026-11-19', pending: true }),
        timeOff({ id: 'c', startDate: '2026-11-20', endDate: '2026-11-20' }),
      ],
      WEEK,
    );
    expect(Object.fromEntries(spans.map((s) => [s.item.id, s.lane]))).toEqual({ a: 0, b: 1, c: 0 });
  });

  it('leaves out what falls outside the period', () => {
    expect(timeOffSpans([timeOff({ startDate: '2026-11-23', endDate: '2026-11-24' })], WEEK)).toEqual([]);
  });
});

describe('buildDayStats', () => {
  it('counts who works and who is away, with pending leave apart and weekends only for people with a shift', () => {
    const shifts = new Map([
      ['e1|2026-11-18', [shift('e1', [9, 0], [17, 0])]],
      ['e3|2026-11-21', [shift('e3', [10, 0], [18, 0])]],
    ]);
    const timeOffByEmployee = new Map([
      ['e2', [timeOff({ employeeId: 'e2', startDate: '2026-11-18', endDate: '2026-11-22' })]],
      ['e3', [timeOff({ employeeId: 'e3', kind: 'sick', startDate: '2026-11-20', endDate: null })]],
      ['e4', [timeOff({ employeeId: 'e4', pending: true, startDate: '2026-11-18', endDate: '2026-11-18' })]],
    ]);

    const stats = buildDayStats(WEEK, ['e1', 'e2', 'e3', 'e4'].map(employee), shifts, timeOffByEmployee);

    const wednesday = stats.get('2026-11-18')!;
    expect(wednesday.working.map((e) => e.id)).toEqual(['e1']);
    expect(wednesday.away.map((a) => a.employee.id)).toEqual(['e2']);
    expect(wednesday.requested.map((a) => a.employee.id)).toEqual(['e4']);
    expect(wednesday.hours).toBe(8);
    // Saturday: e2's leave covers it but e2 had no shift; e3 is sick and was rostered.
    expect(stats.get('2026-11-21')!.away.map((a) => a.employee.id)).toEqual(['e3']);
  });
});

describe('day view hours', () => {
  it('shows 08:00–18:00 at least, widened to whole hours around the shifts', () => {
    expect(dayHourRange([], '2026-11-18')).toEqual({ from: 8, to: 18 });
    expect(dayHourRange([shift('e1', [6, 30], [15, 0]), shift('e2', [14, 0], [22, 15])], '2026-11-18')).toEqual({ from: 6, to: 23 });
  });

  it('splits a night shift over the two days it touches, minus the break inside each', () => {
    const night: HrShift = {
      ...shift('e1', [22, 0], [23, 0]),
      endsAt: new Date(2026, 10, 19, 6, 0).toISOString(),
      breakStartsAt: new Date(2026, 10, 19, 2, 0).toISOString(),
      breakEndsAt: new Date(2026, 10, 19, 2, 30).toISOString(),
    };
    expect(hoursWithinDay(night, '2026-11-18')).toBe(2);
    expect(hoursWithinDay(night, '2026-11-19')).toBe(5.5);
    expect(hoursWithinDay(night, '2026-11-20')).toBe(0);
  });

  it('counts each employee working at half past every hour once', () => {
    const shifts = [shift('e1', [9, 0], [12, 0]), shift('e1', [11, 0], [13, 0], 'e1-again'), shift('e2', [10, 0], [11, 0])];
    expect(hourlyCoverage(shifts, '2026-11-18', 8, 14)).toEqual([0, 1, 2, 1, 1, 0]);
  });
});

describe('monthGridWeeks', () => {
  it('covers the month in Monday-first weeks', () => {
    const weeks = monthGridWeeks('2026-11-18');
    expect(weeks).toHaveLength(6);
    expect(weeks[0]![0]).toBe('2026-10-26');
    expect(weeks.at(-1)!.at(-1)).toBe('2026-12-06');
  });
});
