import type { DependencyType, ProjectSchedule, ScheduleTask } from '@weldsuite/app-api-client/domains/project-schedule';

/** How wide a calendar day is on the timeline, per zoom level. */
export type Zoom = 'week' | 'month' | 'quarter';
export const ZOOMS: readonly Zoom[] = ['week', 'month', 'quarter'];
export const PX_PER_DAY: Readonly<Record<Zoom, number>> = { week: 28, month: 10, quarter: 4 };

export const ROW_HEIGHT = 38;
export const HEADER_HEIGHT = 38;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a `YYYY-MM-DD` date (or the date part of an ISO timestamp). */
export function dayOf(date: string): number {
  return Math.floor(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS);
}

/** `YYYY-MM-DD` of a day number. */
export function dateOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export interface Timeline {
  /** First and last day shown (inclusive). */
  startDay: number;
  endDay: number;
  pxPerDay: number;
  width: number;
}

/** The days the chart covers: every scheduled task and the go-live date, with a margin. */
export function buildTimeline(schedule: Pick<ProjectSchedule, 'tasks' | 'goLive'>, zoom: Zoom): Timeline {
  const days: number[] = [];
  for (const task of schedule.tasks) {
    for (const date of [task.plannedStart, task.plannedFinish, task.earlyFinish]) if (date) days.push(dayOf(date));
  }
  if (schedule.goLive.date) days.push(dayOf(schedule.goLive.date));
  const today = Math.floor(Date.now() / DAY_MS);
  const first = days.length > 0 ? Math.min(...days) : today;
  const last = days.length > 0 ? Math.max(...days) : today + 30;
  const startDay = first - 7;
  const endDay = last + 14;
  const pxPerDay = PX_PER_DAY[zoom];
  return { startDay, endDay, pxPerDay, width: (endDay - startDay + 1) * pxPerDay };
}

export function xOf(timeline: Timeline, day: number): number {
  return (day - timeline.startDay) * timeline.pxPerDay;
}

export interface Bar {
  taskId: string;
  row: number;
  /** Left and right edge in pixels; the right edge is the end of the last day. */
  x1: number;
  x2: number;
  /** Where the task would start and end once its predecessors have pushed it (equal to the bar when it is not pushed). */
  pushedX2: number;
}

/** One bar per scheduled task, on its row. Tasks outside the network have no bar. */
export function layoutBars(rows: readonly ScheduleTask[], timeline: Timeline): Map<string, Bar> {
  const bars = new Map<string, Bar>();
  rows.forEach((task, row) => {
    if (!task.scheduled || !task.plannedStart || !task.plannedFinish) return;
    const x1 = xOf(timeline, dayOf(task.plannedStart));
    const x2 = xOf(timeline, dayOf(task.plannedFinish) + 1);
    const pushed = task.earlyFinish ? xOf(timeline, dayOf(task.earlyFinish) + 1) : x2;
    bars.set(task.id, { taskId: task.id, row, x1, x2: Math.max(x2, x1 + 3), pushedX2: Math.max(pushed, x2) });
  });
  return bars;
}

export function rowCenter(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * The elbow of a dependency arrow: it leaves the predecessor at its start or
 * end and arrives at the successor's start or end, by the link type
 * (fs: end to start, ss: start to start, ff: end to end, sf: start to end).
 */
export function arrowPath(type: DependencyType, from: Bar, to: Bar): { d: string; ax: number; ay: number } {
  const x1 = type === 'ss' || type === 'sf' ? from.x1 : from.x2;
  const x2 = type === 'fs' || type === 'ss' ? to.x1 : to.x2;
  const y1 = rowCenter(from.row);
  const y2 = rowCenter(to.row);
  let elbow: number;
  if (type === 'fs') elbow = x2 >= x1 + 16 ? x1 + 8 : x2 - 8;
  else if (type === 'ss') elbow = Math.min(x1, x2) - 8;
  else if (type === 'ff') elbow = Math.max(x1, x2) + 8;
  else elbow = x2 >= x1 + 16 ? x1 - 8 : x2 + 8;
  return { d: `M ${x1} ${y1} H ${elbow} V ${y2} H ${x2}`, ax: x2, ay: y2 };
}

export interface MonthTick {
  day: number;
  /** `YYYY-MM` of the month that starts on `day`. */
  month: string;
}

/** The first day of every month the timeline covers. */
export function monthTicks(timeline: Timeline): MonthTick[] {
  const ticks: MonthTick[] = [];
  const start = new Date(timeline.startDay * DAY_MS);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  for (let guard = 0; guard < 240; guard++) {
    const day = Math.floor(Date.UTC(year, month, 1) / DAY_MS);
    if (day > timeline.endDay) break;
    if (day >= timeline.startDay) ticks.push({ day, month: `${year}-${String(month + 1).padStart(2, '0')}` });
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return ticks;
}

/** The working-days-off bands (weekends of a 5-day week and the holidays) to shade, as `[from, to]` day ranges. */
export function nonWorkingBands(timeline: Timeline, workingDays: readonly number[], holidays: readonly string[]): Array<[number, number]> {
  if (timeline.pxPerDay < 10) return [];
  const off = new Set(holidays.map(dayOf));
  const bands: Array<[number, number]> = [];
  let open: number | null = null;
  for (let day = timeline.startDay; day <= timeline.endDay + 1; day++) {
    const weekday = ((((day + 3) % 7) + 7) % 7) + 1;
    const isOff = day <= timeline.endDay && (!workingDays.includes(weekday) || off.has(day));
    if (isOff && open === null) open = day;
    if (!isOff && open !== null) {
      bands.push([open, day - 1]);
      open = null;
    }
  }
  return bands;
}

export type RowFilter = 'all' | 'critical' | `deliverable:${string}`;

/** The tasks a filter keeps; the order is the schedule's. */
export function filterRows(tasks: readonly ScheduleTask[], filter: RowFilter): ScheduleTask[] {
  if (filter === 'all') return [...tasks];
  if (filter === 'critical') return tasks.filter((task) => task.critical);
  const deliverableId = filter.slice('deliverable:'.length);
  return tasks.filter((task) => task.deliverableId === deliverableId);
}

/** The links of a task, split by direction. */
export function linksOfTask(schedule: Pick<ProjectSchedule, 'dependencies'>, taskId: string) {
  return {
    predecessors: schedule.dependencies.filter((link) => link.successorId === taskId),
    successors: schedule.dependencies.filter((link) => link.predecessorId === taskId),
  };
}

/** Tasks the new link may not use: the task itself and anything that would close a cycle. */
export function wouldCycle(schedule: Pick<ProjectSchedule, 'dependencies'>, predecessorId: string, successorId: string): boolean {
  const waitsFor = new Map<string, string[]>();
  for (const link of schedule.dependencies) {
    waitsFor.set(link.successorId, [...(waitsFor.get(link.successorId) ?? []), link.predecessorId]);
  }
  const seen = new Set<string>();
  const stack = [predecessorId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === successorId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(waitsFor.get(current) ?? []));
  }
  return false;
}
