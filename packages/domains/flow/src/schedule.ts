/**
 * Schedule rules: the forward and backward pass over a project's tasks, their
 * typed dependencies and its working calendar (design:
 * weldflow-delivery-and-portfolio.md, "Schedule and critical path"; ADR
 * FLOW-015).
 *
 * Pure functions, no database and no clock. flow-api's `/api/project-schedule`
 * routes use them and the Rust flow-domain (`schedule.rs`) mirrors them one to
 * one: both run the same fixtures (`testing/schedule-fixtures.json`), so a
 * change here is a change there.
 *
 * The model, in working days of the project calendar:
 *
 * - A task spans its planned start to its planned due date. Its duration is the
 *   number of working days in that span (at least 1); a task with only one of
 *   the two dates lasts one day. A task with neither date, and a cancelled
 *   task, is outside the network.
 * - A link `predecessor -> successor` has a type and a lag (negative = lead):
 *     fs  successor starts after the predecessor finishes (lag 0: the next working day)
 *     ss  successor starts when the predecessor starts, plus the lag
 *     ff  successor finishes when the predecessor finishes, plus the lag
 *     sf  successor finishes when the predecessor starts, plus the lag
 * - Forward pass: a task's early start is its planned start, pushed later by
 *   whatever its predecessors require. A planned start is therefore a "start
 *   no earlier than": a task planned for next month is not pulled forward, and
 *   rescheduling only ever pushes. Done tasks, and pinned tasks (the one being
 *   moved), keep their dates.
 * - Backward pass: from the project finish (the latest early finish) back
 *   through the links, giving late dates. Total float = late start - early
 *   start. The critical path is the linked, unfinished tasks with no float.
 * - Conflicts are checked against planned dates, link by link: a successor
 *   planned to start before its predecessor allows.
 * - Go-live is a date (the baseline's, else the project's end date). The
 *   schedule reports how many working days the project finish lies before it.
 */

import { compareText } from './compare';

export type DependencyKind = 'fs' | 'ss' | 'ff' | 'sf';

export interface ScheduleCalendar {
  /** ISO weekdays that are working days: 1 = Monday ... 7 = Sunday. */
  workingDays: number[];
  /** Non-working dates, `YYYY-MM-DD`. */
  holidays: string[];
}

export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

export interface ScheduleTaskInput {
  id: string;
  /** `cancelled` takes the task out of the network, `done` fixes its dates. */
  status: string;
  /** `YYYY-MM-DD`. */
  startDate: string | null;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
}

export interface ScheduleLinkInput {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyKind;
  /** Working days; negative is lead time. */
  lagDays: number;
}

export interface ScheduleInput {
  tasks: ScheduleTaskInput[];
  links: ScheduleLinkInput[];
  calendar: ScheduleCalendar;
  /** The date the project has to be live (`YYYY-MM-DD`), when it has one. */
  goLive?: string | null;
  /** Tasks that keep their planned dates whatever their predecessors say (the task being moved). */
  pinnedTaskIds?: string[];
}

export interface ScheduledTask {
  id: string;
  /** In the network: has dates and is not cancelled. */
  scheduled: boolean;
  done: boolean;
  /** Planned dates as the calendar reads them (a weekend start is the next working day). */
  plannedStart: string | null;
  plannedFinish: string | null;
  /** Working days the task lasts. */
  durationDays: number | null;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  /** Working days the task can slip without moving the project finish; null for done and unscheduled tasks. */
  totalFloat: number | null;
  critical: boolean;
  /** Working days the early start lies after the planned start (0 when the task is not pushed). */
  shiftDays: number;
  /** Has at least one link to another task of the network. */
  linked: boolean;
}

export interface ScheduleConflict {
  linkId: string;
  predecessorId: string;
  successorId: string;
  type: DependencyKind;
  lagDays: number;
  /** The earliest start the link allows the successor (`YYYY-MM-DD`). */
  requiredStart: string;
  plannedStart: string;
  /** Working days the successor starts too early. */
  shortByDays: number;
}

export interface ScheduleResult {
  /** In the order of the input tasks. */
  tasks: ScheduledTask[];
  conflicts: ScheduleConflict[];
  /** Task ids on the critical path, in start order. */
  criticalPath: string[];
  /** The latest early finish of the network. */
  finish: string | null;
  goLive: string | null;
  /** Working days from the finish to go-live: positive is float, negative is late; null without both dates. */
  goLiveSlackDays: number | null;
  /** Tasks caught in a dependency cycle (they keep their planned dates). */
  cyclicTaskIds: string[];
}

// ── Dates and calendar ──────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
/** A search for the next working day gives up after this many days (a calendar with nothing to work on). */
const MAX_SEARCH_DAYS = 3_700;

/** Days since 1970-01-01 of a `YYYY-MM-DD` date, or null when it is not a real calendar date. */
export function dayNumber(date: string | null | undefined): number | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return Math.round(ms / MS_PER_DAY);
}

/** `YYYY-MM-DD` of a day number. */
export function isoDate(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** ISO weekday of a day number: 1 = Monday ... 7 = Sunday (1970-01-01 was a Thursday). */
export function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/**
 * The calendar as stored (`projects.settings.schedule`), with the defaults for
 * what is missing or unusable: working days outside 1-7 are dropped, none left
 * means Monday to Friday, and holidays that are not real dates are dropped.
 */
export function normalizeCalendar(settings: { workingDays?: unknown; holidays?: unknown } | null | undefined): ScheduleCalendar {
  const days = Array.isArray(settings?.workingDays)
    ? (settings?.workingDays as unknown[]).filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 7)
    : [];
  const workingDays = days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : [...DEFAULT_WORKING_DAYS];
  const holidays = Array.isArray(settings?.holidays)
    ? [...new Set((settings?.holidays as unknown[]).filter((h): h is string => typeof h === 'string' && dayNumber(h) !== null))].sort()
    : [];
  return { workingDays, holidays };
}

class WorkingCalendar {
  private readonly weekdays: boolean[] = new Array(8).fill(false);
  private readonly holidays = new Set<number>();

  constructor(calendar: ScheduleCalendar) {
    const normal = normalizeCalendar(calendar);
    for (const weekday of normal.workingDays) this.weekdays[weekday] = true;
    for (const holiday of normal.holidays) {
      const day = dayNumber(holiday);
      if (day !== null) this.holidays.add(day);
    }
  }

  isWorking(day: number): boolean {
    return this.weekdays[isoWeekday(day)] === true && !this.holidays.has(day);
  }

  /** The day itself when it is a working day, else the next one. */
  nextWorking(day: number): number {
    let current = day;
    for (let guard = 0; guard < MAX_SEARCH_DAYS && !this.isWorking(current); guard++) current += 1;
    return current;
  }

  /** The day itself when it is a working day, else the one before. */
  previousWorking(day: number): number {
    let current = day;
    for (let guard = 0; guard < MAX_SEARCH_DAYS && !this.isWorking(current); guard++) current -= 1;
    return current;
  }

  /** `n` working days later (earlier when negative); zero returns the day as it is. */
  add(day: number, n: number): number {
    let current = day;
    const step = n > 0 ? 1 : -1;
    for (let left = Math.abs(n); left > 0; left--) {
      current += step;
      for (let guard = 0; guard < MAX_SEARCH_DAYS && !this.isWorking(current); guard++) current += step;
    }
    return current;
  }

  /** Signed working days from `a` to `b`: the working days after `a` up to `b`, negative when `b` is earlier. */
  diff(a: number, b: number): number {
    if (a === b) return 0;
    const [low, high, sign] = b > a ? [a, b, 1] : [b, a, -1];
    let count = 0;
    for (let day = low + 1; day <= high; day++) if (this.isWorking(day)) count++;
    return sign * count;
  }

  /** Working days from `start` to `end`, both included. */
  countInclusive(start: number, end: number): number {
    let count = 0;
    for (let day = start; day <= end; day++) if (this.isWorking(day)) count++;
    return count;
  }
}

// ── The earliest start a link allows ────────────────────────────────────────

/**
 * The earliest start of a successor lasting `successorDays` working days,
 * given the predecessor's start and finish and the link.
 */
function requiredStart(
  cal: WorkingCalendar,
  link: Pick<ScheduleLinkInput, 'type' | 'lagDays'>,
  predecessorStart: number,
  predecessorFinish: number,
  successorDays: number,
): number {
  const lag = link.lagDays;
  let start: number;
  switch (link.type) {
    case 'fs':
      start = cal.add(predecessorFinish, lag + 1);
      break;
    case 'ss':
      start = cal.add(predecessorStart, lag);
      break;
    case 'ff':
      start = cal.add(cal.add(predecessorFinish, lag), -(successorDays - 1));
      break;
    case 'sf':
      start = cal.add(cal.add(predecessorStart, lag), -(successorDays - 1));
      break;
  }
  return cal.nextWorking(start);
}

/**
 * The latest finish of a predecessor lasting `predecessorDays` working days,
 * given the successor's late start and late finish and the link.
 */
function latestFinish(
  cal: WorkingCalendar,
  link: Pick<ScheduleLinkInput, 'type' | 'lagDays'>,
  successorLateStart: number,
  successorLateFinish: number,
  predecessorDays: number,
): number {
  const lag = link.lagDays;
  switch (link.type) {
    case 'fs':
      return cal.add(successorLateStart, -(lag + 1));
    case 'ss':
      return cal.add(cal.add(successorLateStart, -lag), predecessorDays - 1);
    case 'ff':
      return cal.add(successorLateFinish, -lag);
    case 'sf':
      return cal.add(cal.add(successorLateFinish, -lag), predecessorDays - 1);
  }
}

// ── computeSchedule ─────────────────────────────────────────────────────────

interface Node {
  index: number;
  id: string;
  scheduled: boolean;
  done: boolean;
  pinned: boolean;
  plannedStart: number;
  plannedFinish: number;
  duration: number;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  cyclic: boolean;
  linked: boolean;
}

interface Edge {
  link: ScheduleLinkInput;
  from: number;
  to: number;
}

function planNode(cal: WorkingCalendar, task: ScheduleTaskInput, index: number, pinned: ReadonlySet<string>): Node {
  const startDay = dayNumber(task.startDate);
  const dueDay = dayNumber(task.dueDate);
  const inNetwork = task.status !== 'cancelled' && (startDay !== null || dueDay !== null);
  const done = task.status === 'done';
  if (!inNetwork) {
    return {
      index, id: task.id, scheduled: false, done, pinned: false,
      plannedStart: 0, plannedFinish: 0, duration: 0, earlyStart: 0, earlyFinish: 0, lateStart: 0, lateFinish: 0,
      cyclic: false, linked: false,
    };
  }
  const first = (startDay ?? dueDay) as number;
  const last = Math.max(first, (dueDay ?? startDay) as number);
  const plannedStart = cal.nextWorking(first);
  const duration = Math.max(1, cal.countInclusive(first, last));
  const plannedFinish = cal.add(plannedStart, duration - 1);
  return {
    index, id: task.id, scheduled: true, done, pinned: pinned.has(task.id),
    plannedStart, plannedFinish, duration,
    earlyStart: plannedStart, earlyFinish: plannedFinish, lateStart: plannedStart, lateFinish: plannedFinish,
    cyclic: false, linked: false,
  };
}

/** The topological order of the network (Kahn, lowest index first), and the nodes left in a cycle. */
function orderNodes(nodes: Node[], edges: Edge[]): { order: number[]; cyclic: number[] } {
  const incoming = new Map<number, number>();
  const outgoing = new Map<number, Edge[]>();
  for (const node of nodes) {
    if (node.scheduled) incoming.set(node.index, 0);
  }
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([index]) => index).sort((a, b) => a - b);
  const order: number[] = [];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    order.push(current);
    for (const edge of outgoing.get(current) ?? []) {
      const left = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, left);
      if (left === 0) queue.push(edge.to);
    }
  }
  const placed = new Set(order);
  const cyclic = [...incoming.keys()].filter((index) => !placed.has(index)).sort((a, b) => a - b);
  return { order, cyclic };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Links between two scheduled tasks of the network; the rest are ignored. */
function networkEdges(byId: ReadonlyMap<string, Node>, links: readonly ScheduleLinkInput[]): Edge[] {
  const edges: Edge[] = [];
  for (const link of links) {
    const from = byId.get(link.predecessorId);
    const to = byId.get(link.successorId);
    if (!from || !to || from === to || !from.scheduled || !to.scheduled) continue;
    edges.push({ link, from: from.index, to: to.index });
    from.linked = true;
    to.linked = true;
  }
  return edges;
}

/**
 * Forward pass. A task in a cycle is placed after the rest, from the
 * predecessors that are already placed.
 */
function forwardPass(
  cal: WorkingCalendar,
  nodes: Node[],
  incomingOf: ReadonlyMap<number, Edge[]>,
  sequence: readonly number[],
): void {
  const placed = new Set<number>();
  for (const index of sequence) {
    const node = nodes[index];
    if (!node.done && !node.pinned) {
      let start = node.plannedStart;
      for (const edge of incomingOf.get(node.index) ?? []) {
        if (!placed.has(edge.from)) continue;
        const from = nodes[edge.from];
        start = Math.max(start, requiredStart(cal, edge.link, from.earlyStart, from.earlyFinish, node.duration));
      }
      node.earlyStart = cal.nextWorking(start);
      node.earlyFinish = cal.add(node.earlyStart, node.duration - 1);
    }
    placed.add(node.index);
  }
}

/** Backward pass over the acyclic part, from the project finish. */
function backwardPass(
  cal: WorkingCalendar,
  nodes: Node[],
  outgoingOf: ReadonlyMap<number, Edge[]>,
  order: readonly number[],
  finish: number,
): void {
  for (const index of [...order].reverse()) {
    const node = nodes[index];
    if (node.done) {
      node.lateStart = node.earlyStart;
      node.lateFinish = node.earlyFinish;
      continue;
    }
    let lateFinish = finish;
    for (const edge of outgoingOf.get(index) ?? []) {
      const to = nodes[edge.to];
      if (to.cyclic) continue;
      lateFinish = Math.min(lateFinish, latestFinish(cal, edge.link, to.lateStart, to.lateFinish, node.duration));
    }
    node.lateFinish = lateFinish;
    node.lateStart = cal.add(lateFinish, -(node.duration - 1));
  }
}

function scheduledTaskOf(cal: WorkingCalendar, node: Node): ScheduledTask {
  if (!node.scheduled) {
    return {
      id: node.id, scheduled: false, done: node.done, plannedStart: null, plannedFinish: null, durationDays: null,
      earlyStart: null, earlyFinish: null, lateStart: null, lateFinish: null, totalFloat: null, critical: false,
      shiftDays: 0, linked: false,
    };
  }
  const hasFloat = !node.done && !node.cyclic;
  const totalFloat = hasFloat ? cal.diff(node.earlyStart, node.lateStart) : null;
  return {
    id: node.id,
    scheduled: true,
    done: node.done,
    plannedStart: isoDate(node.plannedStart),
    plannedFinish: isoDate(node.plannedFinish),
    durationDays: node.duration,
    earlyStart: isoDate(node.earlyStart),
    earlyFinish: isoDate(node.earlyFinish),
    lateStart: node.cyclic ? null : isoDate(node.lateStart),
    lateFinish: node.cyclic ? null : isoDate(node.lateFinish),
    totalFloat,
    critical: hasFloat && totalFloat === 0 && node.linked,
    shiftDays: node.done ? 0 : cal.diff(node.plannedStart, node.earlyStart),
    linked: node.linked,
  };
}

function criticalPathOf(tasks: readonly ScheduledTask[]): string[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.critical)
    .sort((a, b) => {
      const byStart = compareText(a.task.earlyStart as string, b.task.earlyStart as string);
      if (byStart !== 0) return byStart;
      const byFinish = compareText(a.task.earlyFinish as string, b.task.earlyFinish as string);
      return byFinish !== 0 ? byFinish : a.index - b.index;
    })
    .map(({ task }) => task.id);
}

/** Conflicts against the planned dates, link by link. */
function plannedConflicts(cal: WorkingCalendar, nodes: readonly Node[], edges: readonly Edge[]): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  for (const edge of edges) {
    const from = nodes[edge.from];
    const to = nodes[edge.to];
    if (to.done) continue;
    const required = requiredStart(cal, edge.link, from.plannedStart, from.plannedFinish, to.duration);
    if (to.plannedStart < required) {
      conflicts.push({
        linkId: edge.link.id,
        predecessorId: from.id,
        successorId: to.id,
        type: edge.link.type,
        lagDays: edge.link.lagDays,
        requiredStart: isoDate(required),
        plannedStart: isoDate(to.plannedStart),
        shortByDays: cal.diff(to.plannedStart, required),
      });
    }
  }
  return conflicts;
}

export function computeSchedule(input: ScheduleInput): ScheduleResult {
  const cal = new WorkingCalendar(input.calendar);
  const pinned = new Set(input.pinnedTaskIds ?? []);
  const nodes = input.tasks.map((task, index) => planNode(cal, task, index, pinned));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edges = networkEdges(byId, input.links);
  const incomingOf = new Map<number, Edge[]>();
  const outgoingOf = new Map<number, Edge[]>();
  for (const edge of edges) {
    pushTo(incomingOf, edge.to, edge);
    pushTo(outgoingOf, edge.from, edge);
  }

  const { order, cyclic } = orderNodes(nodes, edges);
  for (const index of cyclic) nodes[index].cyclic = true;

  forwardPass(cal, nodes, incomingOf, [...order, ...cyclic]);

  const scheduledNodes = nodes.filter((node) => node.scheduled);
  const finish = scheduledNodes.length > 0 ? Math.max(...scheduledNodes.map((node) => node.earlyFinish)) : null;
  if (finish !== null) backwardPass(cal, nodes, outgoingOf, order, finish);

  const tasks = nodes.map((node) => scheduledTaskOf(cal, node));
  const goLiveDay = dayNumber(input.goLive ?? null);
  return {
    tasks,
    conflicts: plannedConflicts(cal, nodes, edges),
    criticalPath: criticalPathOf(tasks),
    finish: finish === null ? null : isoDate(finish),
    goLive: goLiveDay === null ? null : isoDate(goLiveDay),
    goLiveSlackDays: goLiveDay !== null && finish !== null ? cal.diff(finish, goLiveDay) : null,
    cyclicTaskIds: cyclic.map((index) => nodes[index].id),
  };
}

export { compareText };

// ── Moving a task ───────────────────────────────────────────────────────────

export interface MoveRequest {
  taskId: string;
  /** `YYYY-MM-DD`. */
  startDate?: string | null;
  /** `YYYY-MM-DD`. */
  dueDate?: string | null;
}

/** One task's planned dates and the dates it would have after the move. */
export interface MovedTask {
  taskId: string;
  fromStart: string | null;
  fromFinish: string | null;
  toStart: string;
  toFinish: string;
  /** Working days later (negative for the task itself moved earlier). */
  shiftDays: number;
}

export type MoveFailureCode = 'task_not_found' | 'task_closed' | 'dates_missing' | 'dates_reversed' | 'dates_invalid';

export interface MoveFailure {
  ok: false;
  code: MoveFailureCode;
  message: string;
}

export interface MovePreview {
  ok: true;
  taskId: string;
  /** The dates the moved task gets (as given, or derived from its duration). */
  task: { startDate: string; dueDate: string };
  /** The moved task first, then the dependents it pushes, by new start. */
  moved: MovedTask[];
  /** Conflicts the move creates when nothing but the task itself moves. */
  newConflicts: ScheduleConflict[];
  before: { finish: string | null; goLiveSlackDays: number | null };
  after: { finish: string | null; goLiveSlackDays: number | null };
  /** The schedule once the move and its pushes are made: its early dates are what a save writes. */
  schedule: ScheduleResult;
}

export const MOVE_MESSAGES = {
  taskNotFound: 'Task not found in this schedule',
  taskClosed: 'A done or cancelled task cannot be moved',
  datesMissing: 'Give a start date, a due date, or both',
  datesReversed: 'The due date cannot be before the start date',
  datesInvalid: 'Dates must be real dates in the form YYYY-MM-DD',
} as const;

function moveFailure(code: MoveFailureCode, message: string): MoveFailure {
  return { ok: false, code, message };
}

/** The first refusal for a move of `target`, or the day numbers asked for (null for a date not given). */
function checkMove(target: ScheduleTaskInput | undefined, move: MoveRequest): MoveFailure | { startDay: number | null; dueDay: number | null } {
  if (!target) return moveFailure('task_not_found', MOVE_MESSAGES.taskNotFound);
  if (target.status === 'done' || target.status === 'cancelled') return moveFailure('task_closed', MOVE_MESSAGES.taskClosed);
  const startGiven = move.startDate ?? null;
  const dueGiven = move.dueDate ?? null;
  if (startGiven === null && dueGiven === null) return moveFailure('dates_missing', MOVE_MESSAGES.datesMissing);
  const startDay = startGiven === null ? null : dayNumber(startGiven);
  const dueDay = dueGiven === null ? null : dayNumber(dueGiven);
  if ((startGiven !== null && startDay === null) || (dueGiven !== null && dueDay === null)) {
    return moveFailure('dates_invalid', MOVE_MESSAGES.datesInvalid);
  }
  if (startDay !== null && dueDay !== null && dueDay < startDay) return moveFailure('dates_reversed', MOVE_MESSAGES.datesReversed);
  return { startDay, dueDay };
}

/** The new start and due day: with one date given the other follows, keeping `duration`. */
function movedDays(cal: WorkingCalendar, startDay: number | null, dueDay: number | null, duration: number): { newStart: number; newDue: number } {
  if (startDay !== null && dueDay !== null) return { newStart: startDay, newDue: dueDay };
  if (startDay !== null) return { newStart: startDay, newDue: cal.add(cal.nextWorking(startDay), duration - 1) };
  // Count back from the last working day on or before the due date: rolling a
  // weekend due date forward would put the start after the due date.
  const newDue = dueDay as number;
  return { newStart: cal.add(cal.previousWorking(newDue), -(duration - 1)), newDue };
}

/**
 * What moving one task does: its new dates, which dependents get pushed and by
 * how much, the conflicts that appear when only the task moves, and the effect
 * on the project finish. With one date given the other follows, keeping the
 * task's duration (one day when the task had no dates).
 */
export function previewMove(input: ScheduleInput, move: MoveRequest): MovePreview | MoveFailure {
  const cal = new WorkingCalendar(input.calendar);
  const targetIndex = input.tasks.findIndex((task) => task.id === move.taskId);
  const checked = checkMove(input.tasks[targetIndex], move);
  if ('ok' in checked) return checked;
  const { startDay, dueDay } = checked;

  const before = computeSchedule(input);
  const current = before.tasks[targetIndex];
  const { newStart, newDue } = movedDays(cal, startDay, dueDay, current.durationDays ?? 1);
  const task = { startDate: isoDate(newStart), dueDate: isoDate(newDue) };

  // Only the moved task changes dates; it keeps them even when its own
  // predecessors would push it (that shows as a conflict).
  const movedInput: ScheduleInput = {
    ...input,
    tasks: input.tasks.map((t) => (t.id === move.taskId ? { ...t, startDate: task.startDate, dueDate: task.dueDate } : t)),
    pinnedTaskIds: [...(input.pinnedTaskIds ?? []), move.taskId],
  };
  const after = computeSchedule(movedInput);

  const downstream = reachableFrom(move.taskId, input.links);
  const self = after.tasks[targetIndex];
  const moved: MovedTask[] = [
    {
      taskId: move.taskId,
      fromStart: current.plannedStart,
      fromFinish: current.plannedFinish,
      toStart: self.plannedStart as string,
      toFinish: self.plannedFinish as string,
      shiftDays:
        current.plannedStart !== null && self.plannedStart !== null
          ? cal.diff(dayNumber(current.plannedStart) as number, dayNumber(self.plannedStart) as number)
          : 0,
    },
  ];
  const pushed = after.tasks
    .filter((t) => t.id !== move.taskId && t.scheduled && !t.done && t.shiftDays > 0 && downstream.has(t.id))
    .map((t) => ({
      taskId: t.id,
      fromStart: t.plannedStart,
      fromFinish: t.plannedFinish,
      toStart: t.earlyStart as string,
      toFinish: t.earlyFinish as string,
      shiftDays: t.shiftDays,
    }))
    .sort((a, b) => compareText(a.toStart, b.toStart) || compareText(a.toFinish, b.toFinish) || compareText(a.taskId, b.taskId));
  moved.push(...pushed);

  const known = new Set(before.conflicts.map((conflict) => conflict.linkId));
  return {
    ok: true,
    taskId: move.taskId,
    task,
    moved,
    newConflicts: after.conflicts.filter((conflict) => !known.has(conflict.linkId)),
    before: { finish: before.finish, goLiveSlackDays: before.goLiveSlackDays },
    after: { finish: after.finish, goLiveSlackDays: after.goLiveSlackDays },
    schedule: after,
  };
}

/** The tasks that wait, directly or through other tasks, for `taskId`. */
function reachableFrom(taskId: string, links: readonly ScheduleLinkInput[]): Set<string> {
  const successors = new Map<string, string[]>();
  for (const link of links) pushTo(successors, link.predecessorId, link.successorId);
  const seen = new Set<string>();
  const stack = [...(successors.get(taskId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current) || current === taskId) continue;
    seen.add(current);
    stack.push(...(successors.get(current) ?? []));
  }
  return seen;
}

// ── Deliverables ────────────────────────────────────────────────────────────

export interface DeliverableTaskRef {
  deliverableId: string;
  taskId: string;
}

export interface DeliverableProjection {
  deliverableId: string;
  /** The latest early finish of its scheduled tasks; null when it has none. */
  projectedEnd: string | null;
}

/** Where each deliverable ends, by the early finish of its latest task. */
export function projectDeliverables(
  deliverableIds: readonly string[],
  taskRefs: readonly DeliverableTaskRef[],
  schedule: ScheduleResult,
): DeliverableProjection[] {
  const finishes = new Map(schedule.tasks.map((task) => [task.id, task.earlyFinish]));
  return deliverableIds.map((deliverableId) => {
    let latest: string | null = null;
    for (const ref of taskRefs) {
      if (ref.deliverableId !== deliverableId) continue;
      const finish = finishes.get(ref.taskId) ?? null;
      if (finish !== null && (latest === null || finish > latest)) latest = finish;
    }
    return { deliverableId, projectedEnd: latest };
  });
}

/** Working days between two `YYYY-MM-DD` dates on a calendar (signed, `to` later is positive). */
export function workingDaysBetween(calendar: ScheduleCalendar, from: string, to: string): number | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) return null;
  return new WorkingCalendar(calendar).diff(a, b);
}

/** A task's date a save writes: the new day with the time of day the stored date had (UTC midnight when it had none). */
export function withTimeOfDay(day: string, original: Date | null | undefined): Date {
  const base = (dayNumber(day) as number) * MS_PER_DAY;
  const timeOfDay = original ? ((original.getTime() % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY : 0;
  return new Date(base + timeOfDay);
}

/** The `YYYY-MM-DD` of a stored timestamp (its UTC date), or null. */
export function dateOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
