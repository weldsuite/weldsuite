import { describe, expect, it } from 'vitest';
import type { ProjectSchedule, ScheduleTask } from '@weldsuite/app-api-client/domains/project-schedule';
import {
  PX_PER_DAY,
  arrowPath,
  buildTimeline,
  dateOfDay,
  dayOf,
  filterRows,
  layoutBars,
  linksOfTask,
  monthTicks,
  nonWorkingBands,
  rowCenter,
  wouldCycle,
} from './gantt';

function task(id: string, start: string | null, finish: string | null, extra: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id,
    number: null,
    title: id,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    parentTaskId: null,
    deliverableId: null,
    progress: '0',
    startDate: null,
    dueDate: null,
    scheduled: start !== null,
    done: false,
    plannedStart: start,
    plannedFinish: finish,
    durationDays: 1,
    earlyStart: start,
    earlyFinish: finish,
    lateStart: start,
    lateFinish: finish,
    totalFloat: 0,
    critical: false,
    shiftDays: 0,
    linked: false,
    ...extra,
  };
}

const schedule = (tasks: ScheduleTask[], dependencies: ProjectSchedule['dependencies'] = [], goLive: string | null = null) =>
  ({ tasks, dependencies, goLive: { date: goLive, source: goLive ? 'baseline' : null, baselineVersion: null } }) as Pick<
    ProjectSchedule,
    'tasks' | 'dependencies' | 'goLive'
  >;

const link = (id: string, predecessorId: string, successorId: string, type: 'fs' | 'ss' | 'ff' | 'sf' = 'fs') => ({
  id,
  projectId: 'p',
  predecessorId,
  successorId,
  type,
  lagDays: 0,
  createdBy: 'u',
  createdAt: '',
  updatedAt: '',
});

describe('days', () => {
  it('round-trips a date and reads an ISO timestamp by its date', () => {
    expect(dateOfDay(dayOf('2026-11-02'))).toBe('2026-11-02');
    expect(dayOf('2026-11-02T23:59:00.000Z')).toBe(dayOf('2026-11-02'));
    expect(dayOf('2026-11-09') - dayOf('2026-11-02')).toBe(7);
  });
});

describe('buildTimeline and layoutBars', () => {
  const tasks = [task('a', '2026-11-02', '2026-11-06'), task('b', '2026-11-09', '2026-11-10'), task('u', null, null)];

  it('covers the tasks and the go-live date with a margin, at the zoom width', () => {
    const timeline = buildTimeline(schedule(tasks, [], '2026-11-30'), 'week');
    expect(timeline.startDay).toBe(dayOf('2026-11-02') - 7);
    expect(timeline.endDay).toBe(dayOf('2026-11-30') + 14);
    expect(timeline.pxPerDay).toBe(PX_PER_DAY.week);
    expect(timeline.width).toBe((timeline.endDay - timeline.startDay + 1) * PX_PER_DAY.week);
    expect(buildTimeline(schedule(tasks), 'quarter').pxPerDay).toBe(PX_PER_DAY.quarter);
  });

  it('lays a bar on its row from the start of its first day to the end of its last, and none for an unscheduled task', () => {
    const timeline = buildTimeline(schedule(tasks), 'week');
    const bars = layoutBars(tasks, timeline);
    const a = bars.get('a');
    expect(a).toMatchObject({ row: 0 });
    expect((a?.x2 ?? 0) - (a?.x1 ?? 0)).toBe(5 * PX_PER_DAY.week);
    expect(bars.get('b')?.row).toBe(1);
    expect(bars.has('u')).toBe(false);
  });

  it('marks where a pushed task would end', () => {
    const pushed = task('p', '2026-11-02', '2026-11-03', { earlyFinish: '2026-11-05', shiftDays: 2 });
    const timeline = buildTimeline(schedule([pushed]), 'week');
    const bar = layoutBars([pushed], timeline).get('p');
    expect((bar?.pushedX2 ?? 0) - (bar?.x2 ?? 0)).toBe(2 * PX_PER_DAY.week);
  });
});

describe('arrowPath', () => {
  const from = { taskId: 'a', row: 0, x1: 10, x2: 60, pushedX2: 60 };
  const to = { taskId: 'b', row: 2, x1: 100, x2: 150, pushedX2: 150 };

  it('joins the right edges for each link type', () => {
    expect(arrowPath('fs', from, to)).toMatchObject({ ax: 100, ay: rowCenter(2) });
    expect(arrowPath('fs', from, to).d).toBe(`M 60 ${rowCenter(0)} H 68 V ${rowCenter(2)} H 100`);
    expect(arrowPath('ss', from, to)).toMatchObject({ ax: 100 });
    expect(arrowPath('ss', from, to).d.startsWith(`M 10 ${rowCenter(0)}`)).toBe(true);
    expect(arrowPath('ff', from, to)).toMatchObject({ ax: 150 });
    expect(arrowPath('sf', from, to)).toMatchObject({ ax: 150 });
    expect(arrowPath('sf', from, to).d.startsWith(`M 10 ${rowCenter(0)}`)).toBe(true);
  });

  it('routes a finish-to-start link that arrives before it leaves around the successor', () => {
    const early = { ...to, x1: 62 };
    expect(arrowPath('fs', from, early).d).toBe(`M 60 ${rowCenter(0)} H 54 V ${rowCenter(2)} H 62`);
  });
});

describe('month ticks and non-working bands', () => {
  const timeline = { startDay: dayOf('2026-10-20'), endDay: dayOf('2027-01-10'), pxPerDay: 10, width: 0 };

  it('ticks the first of each month inside the range', () => {
    expect(monthTicks(timeline).map((tick) => tick.month)).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(dateOfDay(monthTicks(timeline)[0].day)).toBe('2026-11-01');
  });

  it('shades weekends and holidays, but not on a zoomed-out chart', () => {
    const narrow = { startDay: dayOf('2026-11-02'), endDay: dayOf('2026-11-15'), pxPerDay: 10, width: 0 };
    const bands = nonWorkingBands(narrow, [1, 2, 3, 4, 5], ['2026-11-11']);
    expect(bands.map(([a, b]) => [dateOfDay(a), dateOfDay(b)])).toEqual([
      ['2026-11-07', '2026-11-08'],
      ['2026-11-11', '2026-11-11'],
      ['2026-11-14', '2026-11-15'],
    ]);
    expect(nonWorkingBands({ ...narrow, pxPerDay: 4 }, [1, 2, 3, 4, 5], [])).toEqual([]);
  });
});

describe('filterRows, linksOfTask and wouldCycle', () => {
  const tasks = [task('a', '2026-11-02', '2026-11-03', { critical: true, deliverableId: 'd1' }), task('b', '2026-11-04', '2026-11-05', { deliverableId: 'd2' }), task('c', '2026-11-06', '2026-11-06')];
  const links = [link('l1', 'a', 'b'), link('l2', 'b', 'c')];

  it('keeps the critical tasks, or the tasks of one deliverable', () => {
    expect(filterRows(tasks, 'all')).toHaveLength(3);
    expect(filterRows(tasks, 'critical').map((t) => t.id)).toEqual(['a']);
    expect(filterRows(tasks, 'deliverable:d2').map((t) => t.id)).toEqual(['b']);
  });

  it('splits the links of a task into the ones it waits for and the ones waiting for it', () => {
    const split = linksOfTask({ dependencies: links }, 'b');
    expect(split.predecessors.map((l) => l.id)).toEqual(['l1']);
    expect(split.successors.map((l) => l.id)).toEqual(['l2']);
  });

  it('finds a link that would close a cycle', () => {
    expect(wouldCycle({ dependencies: links }, 'c', 'a')).toBe(true);
    expect(wouldCycle({ dependencies: links }, 'b', 'a')).toBe(true);
    expect(wouldCycle({ dependencies: links }, 'a', 'c')).toBe(false);
  });
});
