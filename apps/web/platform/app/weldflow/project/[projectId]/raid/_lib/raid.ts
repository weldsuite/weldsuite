/**
 * Register helpers shared by the four RAID kinds: filtering, ordering, the
 * summary tiles of assumptions, issues and dependencies, status tones and the
 * links of an item's detail.
 */

import { differenceInCalendarDays } from 'date-fns';
import { RAID_STATUSES } from '@weldsuite/app-api-client/schemas/project-control';
import type {
  LinkedObject,
  RaidItem,
  RaidItemDetail,
  RaidKind,
} from '@weldsuite/app-api-client/domains/project-control';
import { isOpenItem, isOverdue } from './risk';

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

/** The owner filter value for items with no owner. */
export const NO_OWNER = '__none__';
export const ALL = 'all';

export interface RegisterFilters {
  search: string;
  status: string;
  ownerId: string;
  category: string;
}

export const EMPTY_FILTERS: RegisterFilters = { search: '', status: ALL, ownerId: ALL, category: ALL };

export function hasActiveFilters(filters: RegisterFilters): boolean {
  return filters.search.trim() !== '' || filters.status !== ALL || filters.ownerId !== ALL || filters.category !== ALL;
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
  return items.filter((item) => {
    if (query && !searchText(item).includes(query)) return false;
    if (filters.status !== ALL && item.status !== filters.status) return false;
    if (filters.ownerId === NO_OWNER && item.ownerId) return false;
    if (filters.ownerId !== ALL && filters.ownerId !== NO_OWNER && item.ownerId !== filters.ownerId) return false;
    if (filters.category !== ALL && (item.category ?? '').toLowerCase() !== filters.category.toLowerCase()) return false;
    return true;
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

// ── Summary tiles ───────────────────────────────────────────────────────────

/** How many days ahead "due soon" looks. */
export const DUE_SOON_DAYS = 7;

export interface AssumptionStats {
  total: number;
  toValidate: number;
  /** Open assumptions due within a week, overdue ones included. */
  dueSoon: number;
  provedWrong: number;
}

export function assumptionStats(assumptions: readonly RaidItem[], now: Date): AssumptionStats {
  const open = assumptions.filter(isOpenItem);
  return {
    total: assumptions.length,
    toValidate: open.length,
    dueSoon: open.filter((item) => item.dueAt !== null && differenceInCalendarDays(new Date(item.dueAt), now) <= DUE_SOON_DAYS).length,
    provedWrong: assumptions.filter((item) => item.status === 'invalid').length,
  };
}

export interface IssueStats {
  open: number;
  critical: number;
  escalated: number;
  /** Mean age of the open issues in whole days; null when none is open. */
  averageAgeDays: number | null;
}

export function issueStats(issues: readonly RaidItem[], now: Date): IssueStats {
  const open = issues.filter(isOpenItem);
  const ages = open.map((item) => Math.max(0, differenceInCalendarDays(now, new Date(item.createdAt))));
  return {
    open: open.length,
    critical: open.filter((item) => item.severity === 'critical').length,
    escalated: open.filter((item) => item.escalatedAt !== null).length,
    averageAgeDays: ages.length === 0 ? null : Math.round(ages.reduce((sum, age) => sum + age, 0) / ages.length),
  };
}

export interface DependencyStats {
  weNeed: number;
  theyNeed: number;
  late: number;
  atRisk: number;
}

export function dependencyStats(dependencies: readonly RaidItem[], now: Date): DependencyStats {
  const open = dependencies.filter(isOpenItem);
  return {
    weNeed: open.filter((item) => item.direction === 'inbound').length,
    theyNeed: open.filter((item) => item.direction === 'outbound').length,
    late: open.filter((item) => isOverdue(item.dueAt, now)).length,
    atRisk: open.filter((item) => item.status === 'at_risk').length,
  };
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
