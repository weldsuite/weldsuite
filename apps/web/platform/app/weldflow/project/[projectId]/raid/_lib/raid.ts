/**
 * Register helpers shared by the four RAID kinds: filtering, ordering, the
 * summary tiles of assumptions, issues and dependencies, status tones and the
 * links of an item's detail.
 */

import { differenceInCalendarDays } from 'date-fns';
import type { ActiveFilter } from '@weldsuite/ui/components/filter-pills';
import { RAID_STATUSES } from '@weldsuite/app-api-client/schemas/project-control';
import type {
  LinkedObject,
  RaidItem,
  RaidItemDetail,
  RaidKind,
} from '@weldsuite/app-api-client/domains/project-control';
import { isOpenItem } from './risk';

export const RAID_KINDS: readonly RaidKind[] = ['risk', 'assumption', 'issue', 'dependency'];

/** The URL segment of each kind's sub-tab under `/weldflow/project/:id/raid`. */
export const RAID_KIND_PATHS: Readonly<Record<RaidKind, string>> = {
  risk: '',
  assumption: '/assumptions',
  issue: '/issues',
  dependency: '/dependencies',
};

/** Statuses a kind can be in, in lifecycle order. */
export function statusesOf(kind: RaidKind): readonly string[] {
  return RAID_STATUSES[kind];
}

export type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

const STATUS_TONES: Readonly<Record<RaidKind, Readonly<Record<string, Tone>>>> = {
  risk: { identified: 'neutral', assessing: 'blue', mitigating: 'orange', monitoring: 'green', occurred: 'red', closed: 'neutral' },
  assumption: { open: 'neutral', validated: 'green', invalid: 'red' },
  issue: { open: 'neutral', in_progress: 'blue', resolved: 'green', closed: 'neutral' },
  dependency: { open: 'neutral', at_risk: 'orange', delivered: 'green', closed: 'neutral' },
};

export function statusTone(kind: RaidKind, status: string): Tone {
  return STATUS_TONES[kind][status] ?? 'neutral';
}

export const ISSUE_SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 4, high: 3, medium: 2, low: 1 };

// ── Filtering ───────────────────────────────────────────────────────────────

/** Assumptions stay in the list once validated or proved wrong; the other kinds hide closed items on request. */
export const SHOWS_CLOSED_ALWAYS: Readonly<Record<RaidKind, boolean>> = {
  risk: false,
  assumption: true,
  issue: false,
  dependency: false,
};

/** The owner filter value for items with no owner. */
export const NO_OWNER = '__none__';

/** The fields the toolbar's Filter button offers. */
export const FILTER_FIELDS = { status: 'status', owner: 'owner', category: 'category' } as const;

/** The toolbar state of one register: the search text and the Filter button's filters. */
export interface RegisterFilters {
  search: string;
  filters: ActiveFilter[];
}

export const EMPTY_FILTERS: RegisterFilters = { search: '', filters: [] };

/** A filter the Filter button is still building (no operator or value yet) narrows nothing. */
function isComplete(filter: ActiveFilter): boolean {
  return filter.operator !== '' && filter.value !== '';
}

export function hasActiveFilters(filters: RegisterFilters): boolean {
  return filters.search.trim() !== '' || filters.filters.some(isComplete);
}

/** The value of an item a filter field compares: owner-less items match `NO_OWNER`, categories ignore case. */
function filterValue(item: RaidItem, field: string): string | null {
  if (field === FILTER_FIELDS.status) return item.status;
  if (field === FILTER_FIELDS.owner) return item.ownerId ?? NO_OWNER;
  if (field === FILTER_FIELDS.category) return (item.category ?? '').toLowerCase();
  return null;
}

/** Each filter narrows the list in turn, as in My tasks: `is` keeps the matches, `is not` drops them. */
function matchesFilter(item: RaidItem, filter: ActiveFilter): boolean {
  const value = filterValue(item, filter.field);
  if (value === null) return true;
  const target = filter.field === FILTER_FIELDS.category ? filter.value.toLowerCase() : filter.value;
  return filter.operator === 'is not' ? value !== target : value === target;
}

function searchText(item: RaidItem): string {
  return [item.code, item.title, item.description, item.category, item.ifWrong, item.trigger, item.partyName]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
}

/** The items that pass the toolbar filters. */
export function applyRegisterFilters<T extends RaidItem>(items: readonly T[], filters: RegisterFilters): T[] {
  const query = filters.search.trim().toLowerCase();
  const active = filters.filters.filter(isComplete);
  return items.filter((item) => {
    if (query && !searchText(item).includes(query)) return false;
    return active.every((filter) => matchesFilter(item, filter));
  });
}

/** The categories in use, lower-cased and unique, for the category filter. */
export function categoriesIn(items: readonly RaidItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const category = item.category?.trim().toLowerCase();
    if (category) seen.add(category);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** The user ids that own at least one of the items, in order of first appearance. */
export function ownerIdsOf(items: readonly Pick<RaidItem, 'ownerId'>[]): string[] {
  return [...new Set(items.map((item) => item.ownerId).filter((id): id is string => !!id))];
}

/** Items of one kind. */
export function itemsOfKind(items: readonly RaidItem[] | undefined, kind: RaidKind): RaidItem[] {
  return (items ?? []).filter((item) => item.kind === kind);
}

// ── Ordering ────────────────────────────────────────────────────────────────

function byDueThenNumber(a: RaidItem, b: RaidItem): number {
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    const byDue = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    if (byDue !== 0) return byDue;
  }
  return a.number - b.number;
}

/**
 * The register order of assumptions, issues and dependencies: open items
 * first, then the closed ones. Open assumptions and dependencies by date,
 * open issues by severity; closed items newest first.
 */
export function sortRegister(kind: Exclude<RaidKind, 'risk'>, items: readonly RaidItem[]): RaidItem[] {
  return [...items].sort((a, b) => {
    const aOpen = isOpenItem(a);
    if (aOpen !== isOpenItem(b)) return aOpen ? -1 : 1;
    if (!aOpen) return b.number - a.number;
    if (kind === 'issue') {
      const bySeverity = (ISSUE_SEVERITY_RANK[b.severity ?? ''] ?? 0) - (ISSUE_SEVERITY_RANK[a.severity ?? ''] ?? 0);
      if (bySeverity !== 0) return bySeverity;
    }
    return byDueThenNumber(a, b);
  });
}

/** Days an item has been open, for the issues table. */
export function ageInDays(createdAt: string, now: Date): number {
  return Math.max(0, differenceInCalendarDays(now, new Date(createdAt)));
}

// ── Progress ────────────────────────────────────────────────────────────────

export function progressPercent(progress: { done: number; total: number }): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}

// ── Links of an item ────────────────────────────────────────────────────────

/** The tasks that mitigate (risk) or resolve (issue) the item. */
export function linkedTasks(detail: Pick<RaidItemDetail, 'links'> | undefined): LinkedObject[] {
  return (detail?.links ?? []).filter(
    (link) =>
      link.direction === 'incoming' &&
      link.fromType === 'task' &&
      (link.relation === 'mitigates' || link.relation === 'resolves'),
  );
}

/** The milestones a risk threatens (or an item affects). */
export function linkedMilestones(detail: Pick<RaidItemDetail, 'links'> | undefined): LinkedObject[] {
  return (detail?.links ?? []).filter((link) => link.direction === 'outgoing' && link.target.type === 'milestone');
}

/** Links to other register items: what this item was raised from, and what was raised from it. */
export function linkedRaidItems(detail: Pick<RaidItemDetail, 'links'> | undefined): LinkedObject[] {
  return (detail?.links ?? []).filter((link) => link.target.type === 'raid_item');
}

// ── Display ─────────────────────────────────────────────────────────────────

/** Up to two initials of a name, for an avatar. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/** A date as "27 Oct" (this year) or "27 Oct 2026". */
export function formatShortDate(iso: string | null, intlLocale: string, now: Date = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(intlLocale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

/** An ISO timestamp as the `YYYY-MM-DD` a date input holds (local date), or ''. */
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A date input value as an ISO timestamp (noon local time, so it never slips a day across zones), or null. */
export function fromDateInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
