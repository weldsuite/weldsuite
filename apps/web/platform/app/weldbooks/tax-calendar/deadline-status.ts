/**
 * What a tax calendar deadline looks like to the user: done, overdue, due
 * soon or upcoming, how the year groups into months, and where a deadline
 * leads. All dates are `YYYY-MM-DD` calendar dates; "today" is the entity's
 * today as the calendar reports it, never the browser's.
 */
import type { TaxDeadline } from '@/lib/api/domains/weldbooks-assets';

/** A deadline this many days away (or fewer) is "due soon". */
export const DUE_SOON_DAYS = 14;

export type DeadlineStatus = 'done' | 'overdue' | 'dueSoon' | 'upcoming' | 'informational';

export type DeadlineLike = Pick<TaxDeadline, 'completed' | 'dueDate'> & { informational?: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

/**
 * Done once marked or filed. Otherwise a deadline in the past is overdue, one
 * within {@link DUE_SOON_DAYS} days is due soon, and the rest are upcoming.
 * Items the entity does not file itself (payroll deposits) are for
 * information: they never go overdue.
 */
export function deadlineStatus(deadline: DeadlineLike, today: string): DeadlineStatus {
  if (deadline.completed) return 'done';
  if (deadline.informational) return 'informational';
  const days = daysBetween(today, deadline.dueDate);
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'dueSoon';
  return 'upcoming';
}

export interface MonthGroup<T> {
  /** `YYYY-MM`. */
  month: string;
  items: T[];
}

/** The deadlines of a year grouped by the month they fall due in, earliest first (a deadline keeps its place within the month by date, then title). */
export function groupByMonth<T extends Pick<TaxDeadline, 'dueDate' | 'title'>>(items: readonly T[]): MonthGroup<T>[] {
  const sorted = [...items].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  const groups: MonthGroup<T>[] = [];
  for (const item of sorted) {
    const month = item.dueDate.slice(0, 7);
    const last = groups.at(-1);
    if (last?.month === month) last.items.push(item);
    else groups.push({ month, items: [item] });
  }
  return groups;
}

export interface StatusCounts {
  overdue: number;
  dueSoon: number;
  upcoming: number;
  done: number;
}

/** How many deadlines are in each state (informational ones are left out of the counts). */
export function countStatuses(items: readonly DeadlineLike[], today: string): StatusCounts {
  const counts: StatusCounts = { overdue: 0, dueSoon: 0, upcoming: 0, done: 0 };
  for (const item of items) {
    const status = deadlineStatus(item, today);
    if (status !== 'informational') counts[status] += 1;
  }
  return counts;
}

/** The screen a deadline is worked on, when WeldBooks has one: sales tax returns and 1099s. */
export function deadlineHref(deadline: Pick<TaxDeadline, 'kind' | 'form'>): string | null {
  if (deadline.kind === 'sales_tax') return '/weldbooks/sales-tax/returns';
  if (deadline.kind === 'information_return' && deadline.form.startsWith('1099')) return '/weldbooks/form-1099';
  return null;
}
