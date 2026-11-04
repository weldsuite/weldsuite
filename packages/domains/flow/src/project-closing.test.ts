import { describe, expect, it } from 'vitest';
import type { schema } from '@weldsuite/worker-kit/db';
import {
  canRequestClose,
  closeChecks,
  closeFinance,
  closeProgress,
  compareLessons,
  lessonBlocks,
  lessonEventData,
  lessonsPageTitle,
  mayChangeLesson,
  presentLesson,
  signOffState,
  type CloseCounts,
} from './project-closing';

type LessonRow = typeof schema.projectLessons.$inferSelect;

function lesson(overrides: Partial<LessonRow> & { id: string }): LessonRow {
  return {
    projectId: 'prj_1',
    category: 'went_well',
    text: 'The rehearsal caught two data problems',
    authorId: 'user_a',
    votes: [],
    knowPageId: null,
    createdBy: 'user_a',
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-01T10:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

const ready: CloseCounts = {
  closed: false,
  deliverables: { total: 3, accepted: 3 },
  changes: { total: 2, open: 0 },
  raid: { open: 2, handedOver: 2 },
  benefits: { total: 4, ready: 4 },
  time: { total: 10, open: 0 },
  lessons: { total: 5, published: 5 },
  signOff: 'none',
};

describe('close checklist', () => {
  it('lists the seven checks in order, the first five blocking', () => {
    const checks = closeChecks(ready);
    expect(checks.map((check) => check.key)).toEqual(['deliverables', 'changes', 'raid', 'benefits', 'time', 'lessons', 'signoff']);
    expect(checks.map((check) => check.blocking)).toEqual([true, true, true, true, true, false, false]);
  });

  it('is done when everything is in order, except the sign-off nobody asked for yet', () => {
    const checks = closeChecks(ready);
    expect(checks.filter((check) => check.done).map((check) => check.key)).toEqual([
      'deliverables',
      'changes',
      'raid',
      'benefits',
      'time',
      'lessons',
    ]);
    expect(closeProgress(checks)).toEqual({ done: 6, total: 7 });
    expect(canRequestClose(checks, false, 'none')).toBe(true);
  });

  it('counts what is in order for each check', () => {
    const checks = closeChecks({
      ...ready,
      deliverables: { total: 7, accepted: 5 },
      changes: { total: 9, open: 2 },
      raid: { open: 4, handedOver: 1 },
      benefits: { total: 5, ready: 3 },
      time: { total: 120, open: 20 },
    });
    expect(checks.map((check) => [check.key, check.done, check.total, check.satisfied])).toEqual([
      ['deliverables', false, 7, 5],
      ['changes', false, 9, 7],
      ['raid', false, 4, 1],
      ['benefits', false, 5, 3],
      ['time', false, 120, 100],
      ['lessons', true, 5, 5],
      ['signoff', false, 0, 0],
    ]);
  });

  it('treats a project with nothing to check as done, except lessons, which need at least one', () => {
    const checks = closeChecks({
      ...ready,
      deliverables: { total: 0, accepted: 0 },
      changes: { total: 0, open: 0 },
      raid: { open: 0, handedOver: 0 },
      benefits: { total: 0, ready: 0 },
      time: { total: 0, open: 0 },
      lessons: { total: 0, published: 0 },
    });
    expect(checks.filter((check) => check.blocking).every((check) => check.done)).toBe(true);
    expect(checks.find((check) => check.key === 'lessons')?.done).toBe(false);
  });

  it('does not let an open blocking check through, but ignores the advisory ones', () => {
    const open = closeChecks({ ...ready, raid: { open: 2, handedOver: 1 } });
    expect(canRequestClose(open, false, 'none')).toBe(false);
    const unpublished = closeChecks({ ...ready, lessons: { total: 5, published: 0 } });
    expect(canRequestClose(unpublished, false, 'none')).toBe(true);
  });

  it('cannot be requested twice, or once the project is closed', () => {
    const checks = closeChecks(ready);
    expect(canRequestClose(checks, false, 'pending')).toBe(false);
    expect(canRequestClose(checks, true, 'none')).toBe(false);
    expect(canRequestClose(checks, false, 'rejected')).toBe(true);
  });

  it('shows the sign-off as waiting while it is pending and done once approved or closed', () => {
    expect(closeChecks({ ...ready, signOff: 'pending' }).find((check) => check.key === 'signoff')?.state).toBe('waiting');
    expect(closeChecks({ ...ready, signOff: 'approved' }).find((check) => check.key === 'signoff')?.done).toBe(true);
    expect(closeChecks({ ...ready, closed: true }).find((check) => check.key === 'signoff')?.state).toBe('done');
    expect(closeChecks({ ...ready, signOff: 'rejected' }).find((check) => check.key === 'signoff')?.state).toBe('open');
  });
});

describe('signOffState', () => {
  it('adds the approval rows up', () => {
    expect(signOffState([])).toBe('none');
    expect(signOffState(['pending'])).toBe('pending');
    expect(signOffState(['info_requested'])).toBe('pending');
    expect(signOffState(['approved'])).toBe('approved');
    expect(signOffState(['approved_with_conditions'])).toBe('approved');
    expect(signOffState(['rejected'])).toBe('rejected');
    expect(signOffState(['approved', 'rejected'])).toBe('rejected');
    expect(signOffState(['approved', 'pending'])).toBe('pending');
  });
});

describe('closeFinance', () => {
  const base = {
    currency: 'EUR',
    amountsVisible: true,
    budget: '193900.00',
    timeCost: '120000.00',
    snapshot: null,
    baseline: { version: 5, goLive: new Date('2027-01-15T00:00:00.000Z') },
  };

  it('uses the approved time cost when there is no snapshot', () => {
    const finance = closeFinance(base);
    expect(finance).toMatchObject({
      budget: '193900.00',
      timeCost: '120000.00',
      actual: '120000.00',
      variance: '-73900.00',
      variancePercent: -38.1,
      overBudget: false,
      baseline: { version: 5, goLive: '2027-01-15T00:00:00.000Z' },
    });
  });

  it("uses the latest snapshot's actual cost, which counts every source", () => {
    const finance = closeFinance({
      ...base,
      snapshot: { week: '2027-W08', actualCost: '195200.00', committed: '0.00', forecast: '195200.00' },
    });
    expect(finance.actual).toBe('195200.00');
    expect(finance.variance).toBe('1300.00');
    expect(finance.variancePercent).toBe(0.7);
    expect(finance.overBudget).toBe(true);
    expect(finance.snapshot?.week).toBe('2027-W08');
    expect(finance.timeCost).toBe('120000.00');
  });

  it('leaves the amounts out for someone without finance access, and keeps the percentage and the verdict', () => {
    const finance = closeFinance({
      ...base,
      amountsVisible: false,
      snapshot: { week: '2027-W08', actualCost: '195200.00', committed: '0.00', forecast: null },
    });
    expect(finance).toMatchObject({
      amountsVisible: false,
      budget: null,
      timeCost: null,
      snapshot: null,
      actual: null,
      variance: null,
      variancePercent: 0.7,
      overBudget: true,
    });
  });

  it('has no percentage without a budget', () => {
    const finance = closeFinance({ ...base, budget: null, baseline: null });
    expect(finance).toMatchObject({ budget: null, variance: null, variancePercent: null, overBudget: false, baseline: null });
    expect(finance.actual).toBe('120000.00');
  });

  it('rounds the percentage half away from zero', () => {
    // 1.25% of 1000 is exactly representable: 12.50 over budget -> 1.3 (not 1.2).
    expect(closeFinance({ ...base, budget: '1000.00', timeCost: '1012.50' }).variancePercent).toBe(1.3);
    expect(closeFinance({ ...base, budget: '1000.00', timeCost: '987.50' }).variancePercent).toBe(-1.3);
  });
});

describe('lessons', () => {
  it('shows the votes as a count, and whether the caller voted', () => {
    const row = lesson({ id: 'les_1', votes: ['user_a', 'user_b'] });
    expect(presentLesson(row, 'user_b')).toMatchObject({ voteCount: 2, votedByMe: true, category: 'went_well' });
    expect(presentLesson(row, 'user_c').votedByMe).toBe(false);
    expect(presentLesson(row, null).votedByMe).toBe(false);
    expect(presentLesson(row, 'user_b')).not.toHaveProperty('votes');
  });

  it('keeps the text out of the event payload', () => {
    expect(lessonEventData(lesson({ id: 'les_1', votes: ['user_a'] }))).toEqual({
      id: 'les_1',
      projectId: 'prj_1',
      category: 'went_well',
      authorId: 'user_a',
      voteCount: 1,
      knowPageId: null,
    });
  });

  it('lets the author or a manager change a lesson', () => {
    const row = lesson({ id: 'les_1' });
    expect(mayChangeLesson(row, 'user_a', false)).toBe(true);
    expect(mayChangeLesson(row, 'user_b', false)).toBe(false);
    expect(mayChangeLesson(row, 'user_b', true)).toBe(true);
    expect(mayChangeLesson(row, null, false)).toBe(false);
  });

  it('orders by votes, then oldest, then id', () => {
    const rows = [
      lesson({ id: 'les_c', votes: [], createdAt: new Date('2026-11-01T10:00:00.000Z') }),
      lesson({ id: 'les_b', votes: ['x'], createdAt: new Date('2026-11-01T12:00:00.000Z') }),
      lesson({ id: 'les_a', votes: ['x'], createdAt: new Date('2026-11-01T11:00:00.000Z') }),
      lesson({ id: 'les_d', votes: [], createdAt: new Date('2026-11-01T10:00:00.000Z') }),
    ];
    expect(rows.sort(compareLessons).map((row) => row.id)).toEqual(['les_a', 'les_b', 'les_c', 'les_d']);
  });

  it('builds a heading per category with lessons and a bullet per lesson, most votes first', () => {
    const blocks = lessonBlocks(
      [
        lesson({ id: 'les_1', category: 'do_differently', text: 'Trial migration in month one', votes: ['a', 'b'] }),
        lesson({ id: 'les_2', category: 'went_well', text: 'Portal sign-off' }),
        lesson({ id: 'les_3', category: 'went_well', text: 'Weekly reports', votes: ['a'] }),
      ],
      'en',
    );
    const lines = blocks.map((block) => {
      const content = block.content as Array<{ text: string }>;
      return `${block.type}:${content[0]?.text}`;
    });
    expect(lines).toEqual([
      'heading:Went well',
      'bulletListItem:Weekly reports (1 vote)',
      'bulletListItem:Portal sign-off',
      'heading:Do differently',
      'bulletListItem:Trial migration in month one (2 votes)',
    ]);
    expect(blocks[0]).toMatchObject({ props: { level: 2 }, children: [] });
  });

  it('writes the page in Dutch', () => {
    const blocks = lessonBlocks([lesson({ id: 'les_1', category: 'went_badly', text: 'Te laat gestart', votes: ['a', 'b'] })], 'nl');
    const texts = blocks.map((block) => (block.content as Array<{ text: string }>)[0]?.text);
    expect(texts).toEqual(['Ging niet goed', 'Te laat gestart (2 stemmen)']);
  });

  it('has no blocks without lessons', () => {
    expect(lessonBlocks([], 'en')).toEqual([]);
  });

  it('names the page, with a default per language and a limit of 500 characters', () => {
    expect(lessonsPageTitle('Portal', 'en')).toBe('Lessons learned: Portal');
    expect(lessonsPageTitle('Portal', 'nl')).toBe('Geleerde lessen: Portal');
    expect(lessonsPageTitle('Portal', 'en', 'Retro')).toBe('Retro');
    expect(lessonsPageTitle('x'.repeat(600), 'en')).toHaveLength(500);
  });
});
