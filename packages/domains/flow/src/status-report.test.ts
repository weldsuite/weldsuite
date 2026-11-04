import { describe, expect, it } from 'vitest';
import {
  benefitExpected,
  benefitProgress,
  benefitsArea,
  budgetArea,
  budgetFigures,
  defaultPeriod,
  healthForColour,
  isoWeek,
  isSlotDay,
  lastSlotOnOrBefore,
  mergeAreas,
  mergeItems,
  mergeOverall,
  monthPeriod,
  nextSlotAfter,
  overallColour,
  periodForSlot,
  recipientTargets,
  riskArea,
  scheduleArea,
  scopeArea,
  weekPeriod,
  windowDays,
  type ComputedAreas,
  type RecipientCandidate,
  type ScheduleItem,
} from './status-report';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('ISO weeks and periods', () => {
  it('numbers weeks the ISO way, across the year boundary', () => {
    expect(weekPeriod(d('2026-11-02'))).toBe('2026-W45');
    expect(weekPeriod(d('2026-11-08'))).toBe('2026-W45');
    expect(weekPeriod(d('2026-11-09'))).toBe('2026-W46');
    expect(weekPeriod(d('2026-01-01'))).toBe('2026-W01');
    expect(weekPeriod(d('2025-12-29'))).toBe('2026-W01');
    expect(weekPeriod(d('2027-01-03'))).toBe('2026-W53');
    expect(weekPeriod(d('2021-01-03'))).toBe('2020-W53');
    expect(isoWeek(d('2024-12-30'))).toEqual({ year: 2025, week: 1 });
  });

  it('names a month', () => {
    expect(monthPeriod(d('2026-11-30'))).toBe('2026-11');
    expect(monthPeriod(d('2026-01-01'))).toBe('2026-01');
  });

  it('looks back a week, a fortnight or a month', () => {
    expect(windowDays('2026-W45', 'weekly')).toBe(7);
    expect(windowDays('2026-W45', 'biweekly')).toBe(14);
    expect(windowDays('2026-W45', null)).toBe(7);
    expect(windowDays('2026-10', 'monthly')).toBe(31);
  });
});

describe('slots', () => {
  const monday = { cadence: 'weekly', weekday: 1 } as const;

  it('finds the latest and next slot day of a weekly cadence', () => {
    const now = new Date('2026-11-04T10:12:00.000Z');
    expect(lastSlotOnOrBefore(monday, now).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(nextSlotAfter(monday, now).toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('counts the slot day itself as the latest slot, from its first minute', () => {
    const now = new Date('2026-11-09T00:00:00.000Z');
    expect(lastSlotOnOrBefore(monday, now).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(nextSlotAfter(monday, now).toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  it('puts a biweekly cadence on the even ISO weeks', () => {
    const settings = { cadence: 'biweekly', weekday: 1 } as const;
    expect(isSlotDay(settings, d('2026-11-02'))).toBe(false); // W45
    expect(isSlotDay(settings, d('2026-11-09'))).toBe(true); // W46
    expect(isSlotDay(settings, d('2026-11-10'))).toBe(false); // not a Monday
    expect(isSlotDay(settings, d('2026-11-16'))).toBe(false); // W47
    expect(isSlotDay(settings, d('2026-11-23'))).toBe(true); // W48
    expect(nextSlotAfter(settings, new Date('2026-11-10T08:00:00.000Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });

  it('puts a monthly cadence on the first working day', () => {
    const settings = { cadence: 'monthly', weekday: 3 } as const;
    expect(isSlotDay(settings, d('2026-12-01'))).toBe(true); // a Tuesday
    expect(isSlotDay(settings, d('2026-08-03'))).toBe(true); // 1 Aug is a Saturday
    expect(isSlotDay(settings, d('2026-02-02'))).toBe(true); // 1 Feb is a Sunday
    expect(isSlotDay(settings, d('2026-08-01'))).toBe(false);
    expect(isSlotDay(settings, d('2026-08-04'))).toBe(false);
    expect(lastSlotOnOrBefore(settings, new Date('2026-08-20T00:00:00.000Z')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(nextSlotAfter(settings, new Date('2026-08-20T00:00:00.000Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('reports on the week before a slot, or the month before it', () => {
    expect(periodForSlot('weekly', d('2026-11-09'))).toBe('2026-W45');
    expect(periodForSlot('weekly', d('2026-11-06'))).toBe('2026-W45'); // a Friday report is about its own week
    expect(periodForSlot('biweekly', d('2026-01-05'))).toBe('2026-W01'); // Sunday 4 Jan is still week 1
    expect(periodForSlot('monthly', d('2026-08-03'))).toBe('2026-07');
    expect(periodForSlot('monthly', d('2026-01-02'))).toBe('2025-12');
  });

  it('writes the report the cadence sends next, or the current week without a schedule', () => {
    const settings = { cadence: 'weekly' as const, weekday: 1, hour: 9, recipients: {} };
    expect(defaultPeriod(settings, new Date('2026-11-04T10:12:00.000Z'))).toBe('2026-W45');
    expect(defaultPeriod(null, new Date('2026-11-04T10:12:00.000Z'))).toBe('2026-W45');
  });
});

describe('overall colour', () => {
  it('is the worst of the areas, and grey only when none has data', () => {
    expect(overallColour([{ colour: 'green' }, { colour: 'amber' }, { colour: 'grey' }])).toBe('amber');
    expect(overallColour([{ colour: 'amber' }, { colour: 'red' }])).toBe('red');
    expect(overallColour([{ colour: 'grey' }, { colour: 'green' }])).toBe('green');
    expect(overallColour([{ colour: 'grey' }, { colour: 'grey' }])).toBe('grey');
    expect(overallColour([])).toBe('grey');
  });

  it('maps onto the health vocabulary of the project list', () => {
    expect([healthForColour('green'), healthForColour('amber'), healthForColour('red'), healthForColour('grey')]).toEqual([
      'on_track',
      'at_risk',
      'off_track',
      null,
    ]);
  });
});

describe('schedule area', () => {
  const asOf = new Date('2026-11-04T10:00:00.000Z');
  const item = (over: Partial<ScheduleItem>): ScheduleItem => ({
    kind: 'milestone',
    id: 'm1',
    name: 'Beta',
    baseline: d('2026-12-01'),
    current: d('2026-12-01'),
    done: false,
    ...over,
  });

  it('is grey without a baseline', () => {
    const { area } = scheduleArea(null, [item({})], asOf);
    expect(area).toEqual({ colour: 'grey', code: 'schedule.no_baseline', params: {} });
  });

  it('is green when nothing moved', () => {
    const { area, rows } = scheduleArea(4, [item({})], asOf);
    expect(area.colour).toBe('green');
    expect(area.code).toBe('schedule.on_track');
    expect(rows[0]).toMatchObject({ varianceDays: 0, baselineDate: '2026-12-01T00:00:00.000Z' });
  });

  it('is amber when items are late but go-live holds', () => {
    const { area } = scheduleArea(
      4,
      [
        item({ id: 'd2', name: 'D2', kind: 'deliverable', baseline: d('2026-11-28'), current: d('2026-12-03') }),
        item({ id: 'd3', name: 'D3', kind: 'deliverable', baseline: d('2026-12-10'), current: d('2026-12-18') }),
        item({ kind: 'go_live', id: null, name: 'Go-live', baseline: d('2027-01-15'), current: d('2027-01-15') }),
      ],
      asOf,
    );
    expect(area).toMatchObject({ colour: 'amber', code: 'schedule.behind' });
    expect(area.params).toEqual({ baselineVersion: 4, worstDays: 8, worstName: 'D3', behindCount: 2, goLiveDays: 0 });
  });

  it('is red when go-live slips more than a week, or an item more than two', () => {
    const goLive = (days: number) =>
      scheduleArea(4, [item({ kind: 'go_live', id: null, name: 'Go-live', baseline: d('2027-01-15'), current: d(`2027-01-${15 + days}`) })], asOf).area.colour;
    expect(goLive(7)).toBe('amber');
    expect(goLive(8)).toBe('red');
    const late = scheduleArea(4, [item({ baseline: d('2026-12-01'), current: d('2026-12-16') })], asOf).area.colour;
    expect(late).toBe('red');
  });

  it('forecasts an open item whose date has passed for today, and ignores finished ones', () => {
    const { area, rows } = scheduleArea(
      1,
      [item({ baseline: d('2026-10-30'), current: d('2026-10-30') }), item({ id: 'm2', baseline: d('2026-10-01'), current: d('2026-10-01'), done: true })],
      asOf,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ forecastDate: '2026-11-04T00:00:00.000Z', varianceDays: 5 });
    expect(area.colour).toBe('amber');
  });

  it('lists earliest baseline first, items added since the baseline last', () => {
    const { rows } = scheduleArea(
      2,
      [
        item({ id: 'new', name: 'New', baseline: null, current: d('2026-12-05') }),
        item({ id: 'b', name: 'B', baseline: d('2026-12-10'), current: d('2026-12-10') }),
        item({ id: 'a', name: 'A', baseline: d('2026-12-01'), current: d('2026-12-01') }),
      ],
      asOf,
    );
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'new']);
    expect(rows[2]).toMatchObject({ baselineDate: null, varianceDays: null });
  });
});

describe('budget area', () => {
  const finance = (over: Partial<Parameters<typeof budgetFigures>[0]> = {}) => ({
    week: '2026-W45',
    budget: '186400.00',
    plannedValue: '110000.00',
    earnedValue: '98500.00',
    actualCost: '104800.00',
    forecast: '196900.00',
    ...over,
  });

  it('is grey without a finance snapshot', () => {
    expect(budgetArea(null, 'EUR')).toEqual({ area: { colour: 'grey', code: 'budget.no_data', params: {} }, figures: null });
  });

  it('computes the indices to two decimals', () => {
    const { cpi, spi } = budgetFigures(finance());
    expect(cpi).toBe(0.94);
    expect(spi).toBe(0.9);
    expect(budgetFigures(finance({ actualCost: '0.00', plannedValue: '0.00' }))).toMatchObject({ cpi: null, spi: null });
  });

  it('is amber below a CPI of 0.95 and red below 0.85', () => {
    expect(budgetArea(finance(), 'EUR').area).toMatchObject({ colour: 'amber', code: 'budget.over' });
    expect(budgetArea(finance({ earnedValue: '104800.00', forecast: '186400.00' }), 'EUR').area).toMatchObject({ colour: 'green', code: 'budget.on_budget' });
    expect(budgetArea(finance({ earnedValue: '80000.00', forecast: null }), 'EUR').area.colour).toBe('red');
  });

  it('reads the forecast against the budget: any overrun is amber, over ten percent red', () => {
    const base = finance({ earnedValue: '104800.00' });
    expect(budgetArea({ ...base, forecast: '190000.00' }, 'EUR').area.colour).toBe('amber');
    expect(budgetArea({ ...base, forecast: '205041.00' }, 'EUR').area.colour).toBe('red');
    expect(budgetArea({ ...base, forecast: '186400.00' }, 'EUR').area.colour).toBe('green');
  });

  it('is green with no spend and no forecast', () => {
    expect(budgetArea(finance({ actualCost: '0.00', earnedValue: '0.00', forecast: null }), null).area.colour).toBe('green');
  });
});

describe('scope area', () => {
  it('counts the pending change requests', () => {
    expect(scopeArea(0)).toEqual({ colour: 'green', code: 'scope.none_pending', params: {} });
    expect(scopeArea(2)).toEqual({ colour: 'amber', code: 'scope.pending', params: { count: 2 } });
    expect(scopeArea(3).colour).toBe('red');
  });
});

describe('risk area', () => {
  const risk = (code: string, score: number) => ({ id: code, code, title: code, score });

  it('is green with no open risks or when the highest is within the appetite', () => {
    expect(riskArea([], 9).code).toBe('risk.no_open_risks');
    expect(riskArea([risk('RSK-1', 9), risk('RSK-2', 4)], 9)).toEqual({
      colour: 'green',
      code: 'risk.within_appetite',
      params: { highest: 9, code: 'RSK-1', appetite: 9 },
    });
  });

  it('is amber above the appetite and red when the top risk is critical', () => {
    expect(riskArea([risk('RSK-2', 16), risk('RSK-3', 4)], 12)).toEqual({
      colour: 'amber',
      code: 'risk.above_appetite',
      params: { highest: 16, code: 'RSK-2', appetite: 12, aboveCount: 1 },
    });
    expect(riskArea([risk('RSK-4', 20), risk('RSK-2', 16)], 12)).toMatchObject({ colour: 'red', params: { aboveCount: 2 } });
    // Critical but inside a very high appetite: green.
    expect(riskArea([risk('RSK-4', 20)], 25).colour).toBe('green');
  });
});

describe('benefits area', () => {
  const asOf = new Date('2026-11-04T00:00:00.000Z');
  const benefit = (over: Record<string, unknown> = {}) => ({
    code: 'B-1',
    status: 'measuring',
    baseline: 100,
    target: 200,
    latest: 150,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    realiseBy: new Date('2026-12-01T00:00:00.000Z'),
    ...over,
  });

  it('is grey with no benefits, or with none measured', () => {
    expect(benefitsArea([], asOf)).toEqual({ colour: 'grey', code: 'benefits.none', params: {} });
    expect(benefitsArea([benefit({ latest: null })], asOf)).toEqual({ colour: 'grey', code: 'benefits.no_measurements', params: { count: 1 } });
  });

  it('measures progress from the baseline to the target', () => {
    expect(benefitProgress({ baseline: 100, target: 200, latest: 150 })).toBe(0.5);
    expect(benefitProgress({ baseline: 100, target: 50, latest: 75 })).toBe(0.5);
    expect(benefitProgress({ baseline: 100, target: 200, latest: 80 })).toBe(0);
    expect(benefitProgress({ baseline: 100, target: 100, latest: 100 })).toBeNull();
    expect(benefitProgress({ baseline: null, target: 100, latest: 100 })).toBeNull();
  });

  it('expects progress by the clock between creation and the realise-by date', () => {
    const { createdAt, realiseBy } = benefit();
    expect(benefitExpected({ createdAt, realiseBy }, asOf)).toBeCloseTo(34 / 61, 6);
    expect(benefitExpected({ createdAt, realiseBy: null }, asOf)).toBe(0);
    expect(benefitExpected({ createdAt, realiseBy }, new Date('2027-01-01T00:00:00.000Z'))).toBe(1);
  });

  it('is green on track, amber and red as the gap to the clock grows', () => {
    expect(benefitsArea([benefit()], asOf)).toEqual({ colour: 'green', code: 'benefits.on_track', params: { count: 1 } });
    expect(benefitsArea([benefit({ latest: 140 })], asOf)).toMatchObject({ colour: 'amber', code: 'benefits.behind' });
    expect(benefitsArea([benefit({ latest: 105 })], asOf)).toMatchObject({ colour: 'red', params: { count: 1, behind: 1, worstCode: 'B-1' } });
  });

  it('counts an at-risk benefit as amber and a realised one as on track', () => {
    expect(benefitsArea([benefit({ status: 'at_risk' })], asOf).colour).toBe('amber');
    expect(benefitsArea([benefit({ status: 'realised', latest: 105 })], asOf).colour).toBe('green');
  });
});

describe('merging a refresh', () => {
  const computed = (colour: 'green' | 'amber' | 'red' | 'grey'): ComputedAreas => ({
    schedule: { colour, code: 'schedule.on_track', params: {} },
    budget: { colour, code: 'budget.on_budget', params: {} },
    scope: { colour, code: 'scope.none_pending', params: {} },
    risk: { colour, code: 'risk.no_open_risks', params: {} },
    benefits: { colour, code: 'benefits.none', params: {} },
  });

  it('keeps an override and takes the new colour everywhere else', () => {
    const merged = mergeAreas(
      [
        { key: 'schedule', colour: 'green', reason: 'Vendor confirmed', auto: false },
        { key: 'budget', colour: 'amber', reason: null, auto: true },
      ],
      computed('red'),
    );
    expect(merged).toEqual([
      { key: 'schedule', colour: 'green', reason: 'Vendor confirmed', auto: false },
      { key: 'budget', colour: 'red', reason: null, auto: true },
      { key: 'scope', colour: 'red', reason: null, auto: true },
      { key: 'risk', colour: 'red', reason: null, auto: true },
      { key: 'benefits', colour: 'red', reason: null, auto: true },
    ]);
    expect(mergeAreas(null, computed('grey')).map((area) => area.key)).toEqual(['schedule', 'budget', 'scope', 'risk', 'benefits']);
  });

  it('keeps an overall colour the project manager set, and follows the suggestion otherwise', () => {
    expect(mergeOverall('red', 'amber', 'green')).toBe('red');
    expect(mergeOverall('amber', 'amber', 'green')).toBe('green');
    expect(mergeOverall(null, null, 'amber')).toBe('amber');
  });

  it('replaces the filled-in lines and keeps the written ones after them', () => {
    const merged = mergeItems(
      [
        { taskId: 't1', text: 'Old', code: 'TASK-1', date: null },
        { taskId: null, text: 'Call the client', code: null, date: null },
      ],
      [{ taskId: 't2', text: 'New', code: 'TASK-2', date: '2026-11-03T00:00:00.000Z' }],
    );
    expect(merged.map((item) => item.text)).toEqual(['New', 'Call the client']);
  });
});

describe('recipients', () => {
  const person = (id: string, over: Partial<RecipientCandidate> = {}): RecipientCandidate => ({
    stakeholderId: id,
    userId: id.startsWith('m') ? `user_${id}` : null,
    name: id,
    email: `${id}@example.com`,
    kind: id.startsWith('m') ? 'member' : 'contact',
    portalAccess: false,
    ...over,
  });
  const register = [person('m1'), person('c1', { portalAccess: true }), person('c2')];
  const sponsor: RecipientCandidate = { stakeholderId: null, userId: 'user_sponsor', name: 'Sponsor', email: 's@example.com', kind: 'member', portalAccess: false };

  it('uses the report’s own list, in its order', () => {
    expect(recipientTargets({ stakeholderIds: ['c2', 'm1', 'gone'] }, null, register, sponsor).map((r) => r.stakeholderId)).toEqual(['c2', 'm1']);
    expect(recipientTargets({ stakeholderIds: [] }, { recipients: { rule: 'all_stakeholders' } }, register, sponsor)).toEqual([]);
  });

  it('falls back to the schedule: a list, or a rule', () => {
    expect(recipientTargets(null, { recipients: { stakeholderIds: ['m1'] } }, register, sponsor).map((r) => r.stakeholderId)).toEqual(['m1']);
    expect(recipientTargets(null, { recipients: { rule: 'all_stakeholders' } }, register, sponsor)).toHaveLength(3);
    expect(recipientTargets({}, { recipients: { rule: 'portal_contacts' } }, register, sponsor).map((r) => r.stakeholderId)).toEqual(['c1']);
    expect(recipientTargets(null, { recipients: { rule: 'sponsor' } }, register, sponsor)).toEqual([sponsor]);
  });

  it('goes to the sponsor when nothing says otherwise, and to nobody without one', () => {
    expect(recipientTargets(null, null, register, sponsor)).toEqual([sponsor]);
    expect(recipientTargets(null, null, register, null)).toEqual([]);
  });
});
