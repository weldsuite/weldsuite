/**
 * The Backlog's data model: a project's top-level tasks as backlog items, the
 * sections they sit in (one per planned or active sprint, plus the backlog),
 * the plan figures of a sprint, and where a dragged item lands. Pure, so the
 * grouping and ordering rules are tested without a screen.
 */

import type { ItemType, TaskAgileInput } from '@weldsuite/app-api-client/schemas/flow-agile';
import type { ApiTask } from './api-client';
import { isContainerType, itemTypeOf } from './item-types';

/** The id of the section of items that sit in no sprint. */
export const BACKLOG_SECTION = 'backlog';

/** The `epicId` filter value of "Items without an epic". */
export const NO_EPIC = 'none';

/** One task as a backlog row needs it. */
export interface BacklogItem {
  id: string;
  number: number | null;
  title: string;
  type: ItemType;
  status: string;
  priority: string;
  sprintId: string | null;
  epicId: string | null;
  storyPoints: number | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeAvatar: string | null;
  position: number;
  createdAt: string;
  completedDate: string | null;
}

export function toBacklogItem(task: ApiTask, featureLevel: boolean): BacklogItem {
  const assignee = task.assignee ?? task.assignees?.[0] ?? null;
  return {
    id: task.id,
    number: task.number ?? null,
    title: task.title,
    type: itemTypeOf(task.type, { hasParent: !!task.parentTaskId, featureLevel }),
    status: task.status,
    priority: task.priority,
    sprintId: task.sprintId ?? null,
    epicId: task.epicId ?? null,
    storyPoints: task.storyPoints ?? null,
    assigneeId: task.assigneeId ?? assignee?.id ?? null,
    assigneeName: assignee?.name ?? null,
    assigneeAvatar: assignee?.avatar ?? null,
    position: task.position ?? 0,
    createdAt: task.createdAt,
    completedDate: task.completedDate ?? null,
  };
}

/** Done and cancelled items leave the backlog. */
export function isOpenStatus(status: string): boolean {
  return status !== 'done' && status !== 'cancelled' && status !== 'completed';
}

export interface BacklogFilter {
  /** An epic's id, `NO_EPIC` for items without one, null for all. */
  epicId: string | null;
  search: string;
  /** Only items of this type. */
  type?: ItemType | null;
}

export const EMPTY_FILTER: BacklogFilter = { epicId: null, search: '', type: null };

export function isFiltering(filter: BacklogFilter): boolean {
  return filter.epicId !== null || filter.search.trim() !== '' || !!filter.type;
}

function matches(item: BacklogItem, filter: BacklogFilter): boolean {
  if (filter.epicId === NO_EPIC && item.epicId) return false;
  if (filter.epicId && filter.epicId !== NO_EPIC && item.epicId !== filter.epicId) return false;
  if (filter.type && item.type !== filter.type) return false;
  const query = filter.search.trim().toLowerCase();
  if (query) {
    const haystack = `${item.number ?? ''} ${item.title}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function byPosition(a: BacklogItem, b: BacklogItem): number {
  return a.position - b.position || (a.number ?? 0) - (b.number ?? 0);
}

/**
 * The items of each section, ordered by position. Epics and features hold items
 * and are never planned, so they are not rows; done and cancelled items leave
 * the backlog (a sprint keeps what it holds). An item in a sprint that is not
 * among `sprintIds` (a completed one) shows nowhere.
 */
export function buildSections(
  items: readonly BacklogItem[],
  sprintIds: readonly string[],
  filter: BacklogFilter = EMPTY_FILTER,
): Record<string, BacklogItem[]> {
  const sections: Record<string, BacklogItem[]> = { [BACKLOG_SECTION]: [] };
  for (const id of sprintIds) sections[id] = [];
  for (const item of items) {
    if (isContainerType(item.type) || !matches(item, filter)) continue;
    if (item.sprintId === null) {
      if (isOpenStatus(item.status)) sections[BACKLOG_SECTION]?.push(item);
      continue;
    }
    sections[item.sprintId]?.push(item);
  }
  for (const list of Object.values(sections)) list.sort(byPosition);
  return sections;
}

export function sumPoints(items: readonly Pick<BacklogItem, 'storyPoints'>[]): number {
  return items.reduce((sum, item) => sum + (item.storyPoints ?? 0), 0);
}

export function countUnestimated(items: readonly BacklogItem[]): number {
  return items.filter((item) => item.storyPoints === null && item.type !== 'spike').length;
}

export interface SprintPlan {
  points: number;
  /** The average velocity, null until a sprint was completed. */
  forecast: number | null;
  /** More planned than the forecast; null without one. */
  over: boolean | null;
  /** How far the bar runs: planned points against the larger of the two. */
  plannedShare: number;
}

export function sprintPlan(items: readonly BacklogItem[], forecast: number | null): SprintPlan {
  const points = sumPoints(items);
  if (forecast === null) return { points, forecast, over: null, plannedShare: 1 };
  const scale = Math.max(points, forecast, 1);
  return { points, forecast, over: points > forecast, plannedShare: Math.min(points, forecast) / scale };
}

// ── Types ───────────────────────────────────────────────────────────────────

/** The types an item can be changed to: a subtask is made under a parent, not picked. */
export function pickableTypes(enabled: readonly ItemType[]): ItemType[] {
  return enabled.filter((type) => type !== 'subtask');
}

/**
 * The agile fields a type change sends. An epic is never planned in a sprint
 * and is not in an epic itself, so it leaves both.
 */
export function typeChangeInput(type: ItemType): TaskAgileInput {
  return type === 'epic' ? { type, sprintId: null, epicId: null } : { type };
}

// ── New sprint ──────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-11-25` for a date, in UTC. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface SprintDraft {
  name: string;
  /** ISO timestamps at midnight UTC. */
  startDate: string;
  endDate: string;
}

/** The number a name ends with ("Sprint 14" → 14), or null. */
export function trailingNumber(name: string): number | null {
  const text = name.trimEnd();
  let start = text.length;
  const isDigit = (index: number) => {
    const code = text.charCodeAt(index);
    return code >= 48 && code <= 57;
  };
  while (start > 0 && isDigit(start - 1)) start -= 1;
  return start < text.length ? Number(text.slice(start)) : null;
}

/**
 * The next sprint: "Sprint N" after the highest number in use, starting the
 * day after the last planned or active sprint ends (today when there is none,
 * or it ended already) and running `lengthDays` days.
 */
export function nextSprintDraft(
  sprints: ReadonlyArray<{ name: string; status: string; endDate: string | null }>,
  lengthDays: number,
  today: Date,
  prefix: string,
): SprintDraft {
  let highest = 0;
  for (const sprint of sprints) {
    const number = trailingNumber(sprint.name);
    if (number !== null) highest = Math.max(highest, number);
  }
  const number = highest > 0 ? highest + 1 : sprints.length + 1;

  const todayMs = Date.parse(`${isoDay(today)}T00:00:00.000Z`);
  let startMs = todayMs;
  for (const sprint of sprints) {
    if (sprint.status !== 'planned' && sprint.status !== 'active') continue;
    const end = sprint.endDate ? Date.parse(sprint.endDate) : Number.NaN;
    if (Number.isFinite(end)) startMs = Math.max(startMs, Date.parse(`${isoDay(new Date(end))}T00:00:00.000Z`) + DAY_MS);
  }
  const days = Math.max(1, Math.round(lengthDays));
  const endMs = startMs + (days - 1) * DAY_MS;
  return {
    name: `${prefix} ${number}`,
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
  };
}

/** Whole days from `today` to the end date, counting the end day; 0 once it has passed. */
export function daysLeft(endDate: string | null, today: Date): number | null {
  if (!endDate) return null;
  const end = Date.parse(endDate);
  if (!Number.isFinite(end)) return null;
  const endDay = Date.parse(`${isoDay(new Date(end))}T00:00:00.000Z`);
  const todayDay = Date.parse(`${isoDay(today)}T00:00:00.000Z`);
  return Math.max(0, Math.round((endDay - todayDay) / DAY_MS) + 1);
}

// ── Moving items ────────────────────────────────────────────────────────────

export interface DropResult {
  /** The section the item lands in and its new order. */
  targetId: string;
  targetOrder: string[];
  /** Set when the item changed section: the section it left and what is left there. */
  sourceId?: string;
  sourceOrder?: string[];
}

/** Where `overId` (an item or a section) sits: its section and index. */
function locate(sections: Record<string, readonly BacklogItem[]>, overId: string): { sectionId: string; index: number } | null {
  if (overId in sections) return { sectionId: overId, index: sections[overId]?.length ?? 0 };
  for (const [sectionId, list] of Object.entries(sections)) {
    const index = list.findIndex((item) => item.id === overId);
    if (index >= 0) return { sectionId, index };
  }
  return null;
}

/**
 * Dropping `activeId` on `overId` (another item, or a section when dropped on
 * its empty area). Within a section the item takes the place of the one it
 * lands on; into another section it goes before it (or last on the section).
 * Null when nothing moves.
 */
export function dropItem(
  sections: Record<string, readonly BacklogItem[]>,
  activeId: string,
  overId: string,
): DropResult | null {
  const from = locate(sections, activeId);
  const to = locate(sections, overId);
  if (!from || !to || activeId === overId) return null;
  const source = (sections[from.sectionId] ?? []).map((item) => item.id);

  if (from.sectionId === to.sectionId) {
    const order = source.filter((id) => id !== activeId);
    // Dropped on the section itself: last. On a row: before it, or after it when moving down.
    const after = to.index > from.index ? 1 : 0;
    const target = overId in sections ? order.length : order.indexOf(overId) + after;
    order.splice(target, 0, activeId);
    if (order.every((id, i) => id === source[i])) return null;
    return { targetId: from.sectionId, targetOrder: order };
  }

  const targetOrder = (sections[to.sectionId] ?? []).map((item) => item.id);
  targetOrder.splice(to.index, 0, activeId);
  return {
    targetId: to.sectionId,
    targetOrder,
    sourceId: from.sectionId,
    sourceOrder: source.filter((id) => id !== activeId),
  };
}

/** The sprint a section stands for: the backlog is no sprint. */
export function sectionSprintId(sectionId: string): string | null {
  return sectionId === BACKLOG_SECTION ? null : sectionId;
}

// ── Epic burnup ─────────────────────────────────────────────────────────────

export interface BurnupPoint {
  /** Epoch ms. */
  t: number;
  /** Points of the items that existed by then. */
  scope: number;
  /** Points of the items completed by then; null for days after now. */
  done: number | null;
}

function ms(date: string | null | undefined): number | null {
  const value = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * Completed points against the scope over time, from the items' creation and
 * completion dates: the scope at a date is the points of the items created by
 * then. At most `maxPoints` samples, a whole number of days apart, ending now.
 */
export function burnupSeries(
  items: ReadonlyArray<Pick<BacklogItem, 'storyPoints' | 'createdAt' | 'completedDate' | 'status'>>,
  now: number,
  maxPoints = 12,
): BurnupPoint[] {
  const created = items.map((item) => ms(item.createdAt) ?? now);
  if (items.length === 0) return [];
  const start = Math.min(...created);
  const span = Math.max(now - start, DAY_MS);
  const step = Math.max(DAY_MS, Math.ceil(span / (maxPoints - 1) / DAY_MS) * DAY_MS);

  const at = (t: number): BurnupPoint => {
    let scope = 0;
    let done = 0;
    items.forEach((item, i) => {
      const points = item.storyPoints ?? 0;
      if ((created[i] ?? now) <= t) scope += points;
      const completed = item.status === 'done' ? (ms(item.completedDate) ?? now) : null;
      if (completed !== null && completed <= t) done += points;
    });
    return { t, scope, done };
  };

  const points: BurnupPoint[] = [];
  for (let t = start; t < now; t += step) points.push(at(t));
  points.push(at(now));
  return points;
}

// ── Epic page ───────────────────────────────────────────────────────────────

export interface EpicItemGroup {
  /** The sprint's id, `BACKLOG_SECTION` for items in no sprint, `earlier` for a sprint not listed. */
  id: string;
  kind: 'sprint' | 'backlog' | 'earlier';
  name: string | null;
  status: string | null;
  items: BacklogItem[];
}

/**
 * An epic's items grouped by sprint, oldest sprint first, then the backlog.
 * Empty groups are left out.
 */
export function groupEpicItems(
  items: readonly BacklogItem[],
  sprints: ReadonlyArray<{ id: string; name: string; status: string; startDate: string | null }>,
): EpicItemGroup[] {
  const known = new Map(sprints.map((sprint) => [sprint.id, sprint]));
  const bySprint = new Map<string, BacklogItem[]>();
  const backlog: BacklogItem[] = [];
  const earlier: BacklogItem[] = [];
  for (const item of items) {
    if (item.sprintId === null) backlog.push(item);
    else if (known.has(item.sprintId)) bySprint.set(item.sprintId, [...(bySprint.get(item.sprintId) ?? []), item]);
    else earlier.push(item);
  }
  const groups: EpicItemGroup[] = [];
  const ordered = [...bySprint.keys()].sort((a, b) =>
    (known.get(a)?.startDate ?? '').localeCompare(known.get(b)?.startDate ?? '') || (known.get(a)?.name ?? '').localeCompare(known.get(b)?.name ?? ''),
  );
  if (earlier.length > 0) groups.push({ id: 'earlier', kind: 'earlier', name: null, status: null, items: earlier.sort(byPosition) });
  for (const id of ordered) {
    const sprint = known.get(id);
    groups.push({ id, kind: 'sprint', name: sprint?.name ?? id, status: sprint?.status ?? null, items: (bySprint.get(id) ?? []).sort(byPosition) });
  }
  if (backlog.length > 0) groups.push({ id: BACKLOG_SECTION, kind: 'backlog', name: null, status: null, items: backlog.sort(byPosition) });
  return groups;
}
