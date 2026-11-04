import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';
import type { CloseCheck } from '@weldsuite/app-api-client/domains/project-closing';
import {
  benefitNeeds,
  canChangeLesson,
  checkDetail,
  financeVerdict,
  formatMeasure,
  formatMoney,
  formatPeriod,
  lessonsByCategory,
  openBlockingChecks,
  raidCloseBody,
  raidClosedStatus,
  sortLessons,
} from './close';
import { makeChecklist, makeLesson } from './test-fixtures';

const ctx = (language: 'en' | 'nl', overrides: Partial<Parameters<typeof checkDetail>[1]> = {}) => ({
  copy: (language === 'en' ? en : nl).flowClosing.close,
  plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, language),
  format: interpolate,
  signOff: makeChecklist().signOff,
  sponsorName: 'Noor Hendriks',
  ...overrides,
});

const check = (overrides: Partial<CloseCheck>): CloseCheck => ({
  key: 'deliverables',
  blocking: true,
  done: false,
  state: 'open',
  total: 0,
  satisfied: 0,
  ...overrides,
});

describe('checkDetail', () => {
  it('counts with the right plural in English', () => {
    expect(checkDetail(check({ total: 1, satisfied: 1 }), ctx('en'))).toBe('1 of 1 deliverable accepted');
    expect(checkDetail(check({ total: 7, satisfied: 4 }), ctx('en'))).toBe('4 of 7 deliverables accepted');
  });

  it('counts with the right plural in Dutch', () => {
    expect(checkDetail(check({ total: 1, satisfied: 0 }), ctx('nl'))).toBe('0 van 1 oplevering geaccepteerd');
    expect(checkDetail(check({ key: 'raid', total: 2, satisfied: 1 }), ctx('nl'))).toBe('1 van 2 open items overgedragen');
  });

  it('says so when there is nothing to count', () => {
    expect(checkDetail(check({ key: 'changes', done: true, state: 'done' }), ctx('en'))).toBe('There are no change requests.');
  });

  it('names the sponsor on the sign-off, per state', () => {
    const signoff = check({ key: 'signoff', blocking: false });
    const signOff = makeChecklist().signOff;
    expect(checkDetail(signoff, ctx('en'))).toBe('Noor Hendriks signs off once the other checks are done.');
    expect(checkDetail(signoff, ctx('en', { signOff: { ...signOff, state: 'pending' } }))).toBe('Waiting for Noor Hendriks to answer.');
    expect(checkDetail(signoff, ctx('en', { signOff: { ...signOff, state: 'rejected' } }))).toContain('declined');
    expect(checkDetail({ ...signoff, done: true, state: 'done' }, ctx('en', { signOff: { ...signOff, state: 'approved' } }))).toBe('Signed off by Noor Hendriks.');
    expect(checkDetail(signoff, ctx('en', { sponsorName: null }))).toBe('The sponsor signs off once the other checks are done.');
  });
});

describe('openBlockingChecks', () => {
  it('lists the blocking checks that are not done', () => {
    expect(openBlockingChecks(makeChecklist().checks).map((entry) => entry.key)).toEqual(['raid', 'benefits']);
  });
});

describe('closing a register item', () => {
  it('uses validated for an assumption and closed for the rest', () => {
    expect(raidClosedStatus('assumption')).toBe('validated');
    expect(raidClosedStatus('risk')).toBe('closed');
    expect(raidClosedStatus('issue')).toBe('closed');
    expect(raidClosedStatus('dependency')).toBe('closed');
    expect(raidCloseBody('assumption')).toEqual({ status: 'validated' });
  });
});

describe('benefitNeeds', () => {
  it('flags a benefit without an owner or a measurement', () => {
    expect(benefitNeeds({ ownerId: null, latest: null })).toEqual({ owner: true, measurement: true });
    expect(benefitNeeds({ ownerId: 'u', latest: { period: '2027-01', value: '1', measuredAt: 'x' } })).toEqual({ owner: false, measurement: false });
  });
});

describe('lessons', () => {
  const lessons = [
    makeLesson({ id: 'a', voteCount: 2, createdAt: '2026-10-02T00:00:00.000Z' }),
    makeLesson({ id: 'b', voteCount: 5, createdAt: '2026-10-03T00:00:00.000Z' }),
    makeLesson({ id: 'c', voteCount: 2, createdAt: '2026-10-01T00:00:00.000Z' }),
    makeLesson({ id: 'd', category: 'went_badly', voteCount: 1 }),
  ];

  it('sorts by votes, then oldest first', () => {
    expect(sortLessons(lessons).map((lesson) => lesson.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('groups by category', () => {
    const grouped = lessonsByCategory(lessons);
    expect(grouped.went_well.map((lesson) => lesson.id)).toEqual(['b', 'c', 'a']);
    expect(grouped.went_badly.map((lesson) => lesson.id)).toEqual(['d']);
    expect(grouped.do_differently).toEqual([]);
  });

  it('lets the author and a manager change a lesson', () => {
    const lesson = makeLesson({ id: 'x', authorId: 'u_sanne' });
    expect(canChangeLesson(lesson, 'u_sanne', false)).toBe(true);
    expect(canChangeLesson(lesson, 'u_daan', false)).toBe(false);
    expect(canChangeLesson(lesson, 'u_daan', true)).toBe(true);
    expect(canChangeLesson(lesson, null, false)).toBe(false);
  });
});

describe('financeVerdict', () => {
  const finance = makeChecklist().finance;

  it('reports over budget with the size of the difference', () => {
    expect(financeVerdict(finance)).toEqual({ kind: 'over', percent: 0.7, amount: '1300' });
  });

  it('reports under budget without a sign', () => {
    expect(financeVerdict({ ...finance, overBudget: false, variance: '-500.00', variancePercent: -0.3 })).toEqual({ kind: 'under', percent: 0.3, amount: '500' });
  });

  it('keeps the verdict and the percentage when the amounts are hidden', () => {
    const hidden = { ...finance, amountsVisible: false, budget: null, actual: null, variance: null };
    expect(financeVerdict(hidden)).toEqual({ kind: 'over', percent: 0.7, amount: null });
  });

  it('knows when there is no budget', () => {
    expect(financeVerdict({ ...finance, overBudget: false, variance: null, variancePercent: null })).toEqual({ kind: 'none', percent: null, amount: null });
  });
});

describe('formatting', () => {
  it('formats money without decimals for a whole amount', () => {
    expect(formatMoney('193900.00', 'EUR', 'en-US')).toBe('€193,900');
    expect(formatMoney('12.5', 'EUR', 'en-US')).toBe('€12.50');
    expect(formatMoney(null, 'EUR', 'en-US')).toBe('—');
    expect(formatMoney('10', 'NOPE', 'en-US')).toBe('10 NOPE');
  });

  it('trims numeric columns and adds the unit', () => {
    expect(formatMeasure('1150.0000', 'tickets', 'en-US')).toBe('1,150 tickets');
    expect(formatMeasure('0.5', null, 'en-US')).toBe('0.5');
  });

  it('writes a period as month and year', () => {
    expect(formatPeriod('2027-02', 'en-US')).toBe('Feb 2027');
    expect(formatPeriod('nonsense', 'en-US')).toBe('nonsense');
  });
});
