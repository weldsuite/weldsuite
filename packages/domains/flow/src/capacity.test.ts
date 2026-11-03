import { describe, expect, it } from 'vitest';
import {
  CAPACITY_MESSAGES,
  bookingTargetError,
  capacityBand,
  capacityRange,
  collectMembers,
  computeCapacity,
  fitRange,
  formatDate,
  isoWeekLabel,
  loadPercent,
  mondayOf,
  normalizeSkills,
  parseDate,
  periodError,
  roadmapRange,
  rollupLoad,
  round2,
  skillFit,
  suggestMembers,
  taskAssignees,
  weekdayOf,
  weeksCovering,
  workingDaysBetween,
  type CapacityBooking,
  type CapacityMember,
  type CapacityTask,
} from './capacity';

const day = (text: string) => parseDate(text) as number;

describe('dates', () => {
  it('reads real calendar dates only', () => {
    expect(formatDate(day('2026-11-02'))).toBe('2026-11-02');
    expect(day('1970-01-01')).toBe(0);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '26-01-01', '2026-1-01', '1969-12-31', '2201-01-01', 'abc']) {
      expect(parseDate(bad), bad).toBeNull();
    }
    expect(day('2028-02-29')).toBe(day('2028-02-28') + 1);
  });

  it('finds the Monday and the ISO week of a day', () => {
    expect(weekdayOf(day('2026-11-02'))).toBe(0);
    expect(weekdayOf(day('2026-11-08'))).toBe(6);
    expect(formatDate(mondayOf(day('2026-11-08')))).toBe('2026-11-02');
    expect(formatDate(mondayOf(day('2026-11-02')))).toBe('2026-11-02');
    expect(isoWeekLabel(day('2026-11-02'))).toBe('2026-W45');
    // 2026 starts on a Thursday, so it has 53 weeks.
    expect(isoWeekLabel(day('2026-12-28'))).toBe('2026-W53');
    expect(isoWeekLabel(day('2027-01-04'))).toBe('2027-W01');
    // The Monday of 2025-W01 is in December 2024.
    expect(isoWeekLabel(day('2024-12-30'))).toBe('2025-W01');
    expect(isoWeekLabel(day('2026-01-05'))).toBe('2026-W02');
  });

  it('counts working days from Monday to Friday', () => {
    expect(workingDaysBetween(day('2026-11-02'), day('2026-11-06'))).toBe(5);
    expect(workingDaysBetween(day('2026-11-02'), day('2026-11-08'))).toBe(5);
    expect(workingDaysBetween(day('2026-11-07'), day('2026-11-08'))).toBe(0);
    expect(workingDaysBetween(day('2026-11-04'), day('2026-11-10'))).toBe(5);
    expect(workingDaysBetween(day('2026-11-02'), day('2026-11-02'))).toBe(1);
    expect(workingDaysBetween(day('2026-11-03'), day('2026-11-02'))).toBe(0);
    expect(workingDaysBetween(day('2026-11-02'), day('2026-12-31'))).toBe(44);
  });

  it('rounds to two decimals like Math.round', () => {
    expect(round2(1.005)).toBe(1);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.125)).toBe(0.13);
    expect(round2(12)).toBe(12);
  });

  it('checks a period and a booking target', () => {
    expect(periodError('2026-11-02', '2026-11-02')).toBeNull();
    expect(periodError('2026-11-03', '2026-11-02')).toBe(CAPACITY_MESSAGES.periodOrder);
    expect(periodError('2026-02-30', '2026-03-02')).toBe(CAPACITY_MESSAGES.invalidDate);
    expect(bookingTargetError({ projectId: 'p' })).toBeNull();
    expect(bookingTargetError({ requestId: 'r' })).toBeNull();
    expect(bookingTargetError({ projectId: 'p', requestId: 'r' })).toBe(CAPACITY_MESSAGES.bookingTarget);
    expect(bookingTargetError({})).toBe(CAPACITY_MESSAGES.bookingTarget);
    expect(bookingTargetError({ projectId: null, requestId: null })).toBe(CAPACITY_MESSAGES.bookingTarget);
  });
});

describe('ranges', () => {
  it('starts on the Monday of today and spans 14 weeks by default', () => {
    expect(capacityRange(undefined, undefined, '2026-11-04')).toEqual({ from: '2026-11-02', to: '2027-02-07', weeks: 14 });
  });

  it('widens to whole weeks', () => {
    expect(capacityRange('2026-11-04', '2026-11-18', '2026-11-04')).toEqual({ from: '2026-11-02', to: '2026-11-22', weeks: 3 });
    expect(capacityRange('2026-11-02', '2026-11-02', '2026-11-04')).toEqual({ from: '2026-11-02', to: '2026-11-08', weeks: 1 });
  });

  it('refuses bad, reversed and too long ranges', () => {
    expect(capacityRange('2026-02-30', undefined, '2026-11-04')).toEqual({ error: CAPACITY_MESSAGES.invalidDate });
    expect(capacityRange(undefined, '2026-13-01', '2026-11-04')).toEqual({ error: CAPACITY_MESSAGES.invalidDate });
    expect(capacityRange('2026-11-10', '2026-11-09', '2026-11-04')).toEqual({ error: CAPACITY_MESSAGES.periodOrder });
    expect(capacityRange('2026-11-02', '2027-05-03', '2026-11-04')).toEqual({ error: CAPACITY_MESSAGES.rangeTooLong });
    // 26 weeks exactly is fine.
    expect(capacityRange('2026-11-02', '2027-05-02', '2026-11-04')).toEqual({ from: '2026-11-02', to: '2027-05-02', weeks: 26 });
  });

  it('shows four quarters on the roadmap by default and refuses more than eight', () => {
    expect(roadmapRange(undefined, undefined, '2026-11-03')).toEqual({ from: '2026-10-01', to: '2027-09-30', quarters: 4 });
    expect(roadmapRange('2026-05-20', '2026-06-01', '2026-11-03')).toEqual({ from: '2026-04-01', to: '2026-06-30', quarters: 1 });
    expect(roadmapRange('2026-01-01', '2027-12-31', '2026-11-03')).toEqual({ from: '2026-01-01', to: '2027-12-31', quarters: 8 });
    expect(roadmapRange('2026-01-01', '2028-01-01', '2026-11-03')).toEqual({ error: CAPACITY_MESSAGES.roadmapTooLong });
    expect(roadmapRange('2026-02-30', undefined, '2026-11-03')).toEqual({ error: CAPACITY_MESSAGES.invalidDate });
    expect(roadmapRange('2026-05-02', '2026-05-01', '2026-11-03')).toEqual({ error: CAPACITY_MESSAGES.periodOrder });
  });
});

describe('fit window', () => {
  it('runs from the desired start to the desired end, cut off at 26 weeks', () => {
    expect(fitRange('2027-01-11', '2027-03-31', '2026-11-03')).toEqual({ from: '2027-01-11', to: '2027-04-04', weeks: 12 });
    expect(fitRange('2027-01-13', '2027-01-14', '2026-11-03')).toEqual({ from: '2027-01-11', to: '2027-01-17', weeks: 1 });
    expect(fitRange('2027-01-11', '2028-12-31', '2026-11-03')).toEqual({ from: '2027-01-11', to: '2027-07-11', weeks: 26 });
  });

  it('falls back to this week and 14 weeks', () => {
    expect(fitRange(null, null, '2026-11-04')).toEqual({ from: '2026-11-02', to: '2027-02-07', weeks: 14 });
    expect(fitRange('2027-01-11', null, '2026-11-04')).toEqual({ from: '2027-01-11', to: '2027-04-18', weeks: 14 });
    expect(fitRange('2027-01-11', '2026-12-01', '2026-11-04')).toEqual({ from: '2027-01-11', to: '2027-04-18', weeks: 14 });
    expect(fitRange(null, '2026-12-01', '2026-11-04')).toEqual({ from: '2026-11-02', to: '2026-12-06', weeks: 5 });
  });

  it('covers a roadmap range with whole weeks', () => {
    expect(weeksCovering('2026-10-01', '2027-09-30')).toEqual({ from: '2026-09-28', to: '2027-10-03', weeks: 53 });
  });
});

const member = (memberId: string, weeklyHours = 40, skills: string[] = []): CapacityMember => ({
  memberId,
  weeklyHours,
  skills,
  hasProfile: true,
});
const booking = (extra: Partial<CapacityBooking> = {}): CapacityBooking => ({
  memberId: 'anna',
  projectId: 'p1',
  requestId: null,
  startsOn: '2026-11-02',
  endsOn: '2026-11-13',
  hoursPerWeek: 20,
  tentative: false,
  ...extra,
});
const task = (extra: Partial<CapacityTask> = {}): CapacityTask => ({
  projectId: 'p1',
  assigneeId: 'anna',
  assigneeIds: null,
  startsOn: '2026-11-02',
  dueOn: '2026-11-06',
  estimatedHours: 10,
  ...extra,
});
const base = { from: '2026-11-02', weeks: 3, members: [member('anna')], bookings: [], tasks: [], includeTentative: false };
const hours = (load: ReturnType<typeof computeCapacity>, memberId = 'anna') =>
  load.members.find((m) => m.memberId === memberId)?.cells.map((c) => c.hours);

describe('collectMembers', () => {
  it('lists profiles, bookings, task assignees and people once each, by id, with defaults for the rest', () => {
    const members = collectMembers({
      profiles: [{ memberId: 'zoe', weeklyHours: 32, skills: ['QA'] }],
      bookings: [{ memberId: 'bob' }],
      tasks: [{ assigneeId: 'cleo', assigneeIds: null }, { assigneeId: null, assigneeIds: ['dan', 'bob'] }],
      people: ['zoe', 'eve', ''],
    });
    expect(members.map((m) => m.memberId)).toEqual(['bob', 'cleo', 'dan', 'eve', 'zoe']);
    expect(members.find((m) => m.memberId === 'zoe')).toEqual({ memberId: 'zoe', weeklyHours: 32, skills: ['QA'], hasProfile: true });
    expect(members.find((m) => m.memberId === 'eve')).toEqual({ memberId: 'eve', weeklyHours: 40, skills: [], hasProfile: false });
  });

  it('reads a task assignee list before the single assignee', () => {
    expect(taskAssignees({ assigneeId: 'a', assigneeIds: ['b', 'c', 'b'] })).toEqual(['b', 'c']);
    expect(taskAssignees({ assigneeId: 'a', assigneeIds: [] })).toEqual(['a']);
    expect(taskAssignees({ assigneeId: null, assigneeIds: null })).toEqual([]);
  });

  it('keeps each skill once, case aside, in the order given', () => {
    expect(normalizeSkills([' Backend ', 'backend', 'QA', '', 'qa '])).toEqual(['Backend', 'QA']);
  });
});

describe('bookings', () => {
  it('adds the hours per week for every week the booking covers', () => {
    const load = computeCapacity({ ...base, bookings: [booking()] });
    expect(hours(load)).toEqual([20, 20, 0]);
    expect(load.weeks.map((w) => w.week)).toEqual(['2026-W45', '2026-W46', '2026-W47']);
    expect(load.weeks[0]).toEqual({ week: '2026-W45', startsOn: '2026-11-02', endsOn: '2026-11-08' });
  });

  it('scales a partial week by its working days', () => {
    const load = computeCapacity({ ...base, bookings: [booking({ startsOn: '2026-11-04', endsOn: '2026-11-10', hoursPerWeek: 30 })] });
    // Wed to Fri is 3 of 5 days; Mon and Tue of the next week are 2 of 5.
    expect(hours(load)).toEqual([18, 12, 0]);
  });

  it('ignores a booking that covers only a weekend', () => {
    const load = computeCapacity({ ...base, bookings: [booking({ startsOn: '2026-11-07', endsOn: '2026-11-08' })] });
    expect(hours(load)).toEqual([0, 0, 0]);
    expect(load.members[0].projects).toEqual([]);
  });

  it('counts tentative bookings only when asked, and says how much of a week is tentative', () => {
    const tentative = booking({ tentative: true, projectId: null, requestId: 'prq_1', hoursPerWeek: 10 });
    const without = computeCapacity({ ...base, bookings: [booking(), tentative] });
    expect(hours(without)).toEqual([20, 20, 0]);
    const withTentative = computeCapacity({ ...base, bookings: [booking(), tentative], includeTentative: true });
    expect(hours(withTentative)).toEqual([30, 30, 0]);
    expect(withTentative.members[0].cells.map((c) => c.tentativeHours)).toEqual([10, 10, 0]);
    expect(withTentative.members[0].projects).toEqual([
      { projectId: 'p1', requestId: null, hours: [20, 20, 0], tentativeHours: [0, 0, 0] },
      { projectId: null, requestId: 'prq_1', hours: [10, 10, 0], tentativeHours: [10, 10, 0] },
    ]);
  });

  it('sums bookings on several projects into one cell and one row each', () => {
    const load = computeCapacity({
      ...base,
      bookings: [booking({ hoursPerWeek: 24 }), booking({ projectId: 'p2', hoursPerWeek: 16 })],
    });
    expect(hours(load)).toEqual([40, 40, 0]);
    expect(load.members[0].projects.map((p) => [p.projectId, p.hours])).toEqual([
      ['p1', [24, 24, 0]],
      ['p2', [16, 16, 0]],
    ]);
  });
});

describe('open task estimates', () => {
  it('spreads an estimate evenly over the working days of the task', () => {
    const load = computeCapacity({ ...base, tasks: [task({ startsOn: '2026-11-02', dueOn: '2026-11-13', estimatedHours: 20 })] });
    expect(hours(load)).toEqual([10, 10, 0]);
    expect(load.members[0].projects).toEqual([{ projectId: 'p1', requestId: null, hours: [10, 10, 0], tentativeHours: [0, 0, 0] }]);
  });

  it('weighs a week by the working days the task has in it', () => {
    // Thursday to the next Tuesday: 4 working days (Thu, Fri, Mon, Tue), 2 + 2 of a 12 hour task is 6 and 6.
    const load = computeCapacity({ ...base, tasks: [task({ startsOn: '2026-11-05', dueOn: '2026-11-10', estimatedHours: 12 })] });
    expect(hours(load)).toEqual([6, 6, 0]);
    const uneven = computeCapacity({ ...base, tasks: [task({ startsOn: '2026-11-04', dueOn: '2026-11-10', estimatedHours: 10 })] });
    // Wed, Thu, Fri, Mon, Tue: 3 of 5 days in the first week.
    expect(hours(uneven)).toEqual([6, 4, 0]);
  });

  it('places a task with one date on that day, and ignores one with none', () => {
    expect(hours(computeCapacity({ ...base, tasks: [task({ startsOn: null, dueOn: '2026-11-11', estimatedHours: 8 })] }))).toEqual([0, 8, 0]);
    expect(hours(computeCapacity({ ...base, tasks: [task({ startsOn: '2026-11-12', dueOn: null, estimatedHours: 8 })] }))).toEqual([0, 8, 0]);
    expect(hours(computeCapacity({ ...base, tasks: [task({ startsOn: null, dueOn: null })] }))).toEqual([0, 0, 0]);
  });

  it('puts a task that sits on a weekend whole in that week', () => {
    expect(hours(computeCapacity({ ...base, tasks: [task({ startsOn: '2026-11-07', dueOn: '2026-11-08', estimatedHours: 5 })] }))).toEqual([5, 0, 0]);
  });

  it('reads reversed dates as the same window', () => {
    expect(hours(computeCapacity({ ...base, tasks: [task({ startsOn: '2026-11-06', dueOn: '2026-11-02', estimatedHours: 10 })] }))).toEqual([10, 0, 0]);
  });

  it('splits an estimate over the assignees', () => {
    const shared = task({ assigneeId: 'anna', assigneeIds: ['anna', 'bob'], estimatedHours: 10 });
    const load = computeCapacity({ ...base, members: [member('anna'), member('bob')], tasks: [shared] });
    expect(hours(load, 'anna')).toEqual([5, 0, 0]);
    expect(hours(load, 'bob')).toEqual([5, 0, 0]);
  });

  it('leaves out weeks where the member has a booking on the same project', () => {
    const load = computeCapacity({
      ...base,
      bookings: [booking({ startsOn: '2026-11-02', endsOn: '2026-11-08', hoursPerWeek: 20 })],
      tasks: [task({ startsOn: '2026-11-02', dueOn: '2026-11-13', estimatedHours: 20 })],
    });
    // The first week is the booking's; the second has no booking, so the task's half counts.
    expect(hours(load)).toEqual([20, 10, 0]);
    // A tentative booking covers nothing when tentative load is off, and everything when it is on.
    const tentativeBooking = booking({ startsOn: '2026-11-02', endsOn: '2026-11-08', hoursPerWeek: 20, tentative: true });
    const tasks = [task({ startsOn: '2026-11-02', dueOn: '2026-11-13', estimatedHours: 20 })];
    expect(hours(computeCapacity({ ...base, bookings: [tentativeBooking], tasks }))).toEqual([10, 10, 0]);
    expect(hours(computeCapacity({ ...base, bookings: [tentativeBooking], tasks, includeTentative: true }))).toEqual([20, 10, 0]);
  });

  it('does not let a booking on another project cover the task', () => {
    const load = computeCapacity({
      ...base,
      bookings: [booking({ projectId: 'p2', hoursPerWeek: 20, startsOn: '2026-11-02', endsOn: '2026-11-08' })],
      tasks: [task({ estimatedHours: 10 })],
    });
    expect(hours(load)).toEqual([30, 0, 0]);
  });
});

describe('percent, band and summary', () => {
  it('bands the percentage of contract hours', () => {
    expect(capacityBand(0, 0)).toBe('none');
    expect(capacityBand(10, 25)).toBe('under');
    expect(capacityBand(20, 50)).toBe('ok');
    expect(capacityBand(31.9, 79.75)).toBe('ok');
    expect(capacityBand(32, 80)).toBe('full');
    expect(capacityBand(40, 100)).toBe('full');
    expect(capacityBand(40.4, 101)).toBe('over');
    expect(capacityBand(48, 120)).toBe('over');
    expect(capacityBand(48.4, 121)).toBe('critical');
    expect(capacityBand(5, null)).toBe('critical');
    expect(loadPercent(30, 40)).toBe(75);
    expect(loadPercent(10, 0)).toBeNull();
    expect(loadPercent(13.333, 40)).toBe(33.33);
  });

  it('compares with the contract hours of each member', () => {
    const load = computeCapacity({
      ...base,
      members: [member('anna', 40), member('bob', 20), member('cleo', 0)],
      bookings: [booking({ hoursPerWeek: 30 }), booking({ memberId: 'bob', hoursPerWeek: 30 }), booking({ memberId: 'cleo', hoursPerWeek: 4 })],
    });
    expect(load.members.map((m) => m.cells[0])).toEqual([
      { hours: 30, tentativeHours: 0, percent: 75, band: 'ok' },
      { hours: 30, tentativeHours: 0, percent: 150, band: 'critical' },
      { hours: 4, tentativeHours: 0, percent: null, band: 'critical' },
    ]);
    expect(load.members.map((m) => m.cells[2].band)).toEqual(['none', 'none', 'none']);
    // Week 1 and 2: 64 booked hours of 60 contract hours; bob (150%) and cleo (no contract hours) are over every week they are booked.
    expect(load.totals).toEqual([
      { bookedHours: 64, capacityHours: 60 },
      { bookedHours: 64, capacityHours: 60 },
      { bookedHours: 0, capacityHours: 60 },
    ]);
    expect(load.summary).toEqual({ memberCount: 3, bookedHours: 128, capacityHours: 180, percent: 71.11, overbookedPersonWeeks: 4 });
  });

  it('filters by skill, case aside, and leaves the totals to the members shown', () => {
    const members = [member('anna', 40, ['Backend']), member('bob', 40, ['frontend']), member('cleo', 40, [])];
    const load = computeCapacity({ ...base, members, skill: 'BACKEND' });
    expect(load.members.map((m) => m.memberId)).toEqual(['anna']);
    expect(load.summary.memberCount).toBe(1);
    expect(load.summary.capacityHours).toBe(120);
  });

  it('is deterministic in the order of its inputs', () => {
    const inputs = [booking({ hoursPerWeek: 7.3 }), booking({ projectId: 'p2', hoursPerWeek: 11.1 }), booking({ projectId: 'p3', hoursPerWeek: 3.7 })];
    const a = computeCapacity({ ...base, bookings: inputs, tasks: [task({ estimatedHours: 3.3 })] });
    const b = computeCapacity({ ...base, bookings: inputs, tasks: [task({ estimatedHours: 3.3 })] });
    expect(a).toEqual(b);
    expect(hours(a)).toEqual([22.1, 22.1, 0]);
  });
});

describe('suggestions and fit', () => {
  const members = [
    member('anna', 40, ['Frontend']),
    member('bob', 40, ['frontend', 'Design']),
    member('cleo', 40, ['Backend']),
    member('dan', 32, ['Frontend']),
  ];
  const bookings = [
    booking({ memberId: 'anna', hoursPerWeek: 30, startsOn: '2026-11-02', endsOn: '2026-11-22' }),
    booking({ memberId: 'bob', hoursPerWeek: 10, startsOn: '2026-11-09', endsOn: '2026-11-15' }),
    booking({ memberId: 'dan', hoursPerWeek: 8, startsOn: '2026-11-02', endsOn: '2026-11-08', tentative: true }),
  ];
  const load = computeCapacity({ ...base, members, bookings, includeTentative: true });

  it('lists the people with the skill by what they can take on every week', () => {
    const need = { skill: 'frontend', hoursPerWeek: 20, startsOn: '2026-11-04', endsOn: '2026-11-18' };
    expect(suggestMembers(load, need)).toEqual([
      { memberId: 'bob', skills: ['frontend', 'Design'], weeklyHours: 40, freeHoursPerWeek: 30, averageFreeHoursPerWeek: 36.67, coversRequest: true },
      { memberId: 'dan', skills: ['Frontend'], weeklyHours: 32, freeHoursPerWeek: 24, averageFreeHoursPerWeek: 29.33, coversRequest: true },
      { memberId: 'anna', skills: ['Frontend'], weeklyHours: 40, freeHoursPerWeek: 10, averageFreeHoursPerWeek: 10, coversRequest: false },
    ]);
  });

  it('puts people who cover the request first and finds nobody for a skill nobody has', () => {
    const need = { skill: 'frontend', hoursPerWeek: 28, startsOn: '2026-11-02', endsOn: '2026-11-08' };
    expect(suggestMembers(load, need).map((s) => [s.memberId, s.coversRequest])).toEqual([
      ['bob', true],
      ['dan', false],
      ['anna', false],
    ]);
    expect(suggestMembers(load, { ...need, skill: 'Security' })).toEqual([]);
    expect(suggestMembers(load, { ...need, startsOn: '2027-01-04', endsOn: '2027-01-08' })).toEqual([]);
  });

  it('sums what the team has free per skill and flags the weeks that fall short', () => {
    expect(skillFit(load, [{ skill: 'Frontend', hoursPerWeek: 60 }, { skill: 'Backend' }, { skill: 'Security', hoursPerWeek: 4 }])).toEqual([
      { skill: 'Frontend', needHoursPerWeek: 60, freeHoursPerWeek: 72, shortWeeks: 0, weeks: 3, short: false },
      { skill: 'Backend', needHoursPerWeek: null, freeHoursPerWeek: 40, shortWeeks: 0, weeks: 3, short: false },
      { skill: 'Security', needHoursPerWeek: 4, freeHoursPerWeek: 0, shortWeeks: 3, weeks: 3, short: true },
    ]);
    const tight = skillFit(load, [{ skill: 'Frontend', hoursPerWeek: 75 }]);
    expect(tight[0]).toEqual({ skill: 'Frontend', needHoursPerWeek: 75, freeHoursPerWeek: 72, shortWeeks: 2, weeks: 3, short: true });
  });
});

describe('roll-up', () => {
  it('rolls weekly totals up to the month and quarter that hold the Thursday of each week', () => {
    const load = computeCapacity({
      from: '2026-09-28',
      weeks: 14,
      members: [member('anna', 40)],
      bookings: [booking({ startsOn: '2026-09-28', endsOn: '2027-01-03', hoursPerWeek: 20 })],
      tasks: [],
      includeTentative: false,
    });
    const quarters = rollupLoad(load, '2026-10-01', '2026-12-31', true);
    expect(quarters).toEqual([
      { key: '2026-Q4', startsOn: '2026-10-01', endsOn: '2026-12-31', bookedHours: 280, capacityHours: 560, percent: 50 },
    ]);
    const months = rollupLoad(load, '2026-10-01', '2026-12-31', false);
    expect(months.map((m) => [m.key, m.startsOn, m.endsOn])).toEqual([
      ['2026-10', '2026-10-01', '2026-10-31'],
      ['2026-11', '2026-11-01', '2026-11-30'],
      ['2026-12', '2026-12-01', '2026-12-31'],
    ]);
    // October holds the Thursdays of 5 weeks (1, 8, 15, 22, 29 Oct), November 4, December 5.
    expect(months.map((m) => m.capacityHours)).toEqual([200, 160, 200]);
    expect(months.map((m) => m.percent)).toEqual([50, 50, 50]);
  });

  it('lists a month with no week in the load as empty', () => {
    const load = computeCapacity({ ...base, weeks: 1 });
    const months = rollupLoad(load, '2026-11-01', '2026-12-31', false);
    expect(months).toEqual([
      { key: '2026-11', startsOn: '2026-11-01', endsOn: '2026-11-30', bookedHours: 0, capacityHours: 40, percent: 0 },
      { key: '2026-12', startsOn: '2026-12-01', endsOn: '2026-12-31', bookedHours: 0, capacityHours: 0, percent: null },
    ]);
  });
});
