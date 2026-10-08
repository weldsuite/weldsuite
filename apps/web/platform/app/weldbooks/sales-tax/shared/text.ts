/**
 * Small text helpers shared by the Sales Tax Center screens: `{name}`
 * placeholders in translations and the wording of a due date countdown.
 */

/** Replaces each `{name}` in a translation with its value. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

export interface DueTexts {
  inDays: string;
  tomorrow: string;
  today: string;
  overdueOne: string;
  overdueMany: string;
}

/** "Due in 5 days", "Due today", "3 days overdue" for the days until a due date (negative once past). */
export function dueCountdown(texts: DueTexts, daysUntilDue: number): string {
  if (daysUntilDue > 1) return fill(texts.inDays, { count: daysUntilDue });
  if (daysUntilDue === 1) return texts.tomorrow;
  if (daysUntilDue === 0) return texts.today;
  if (daysUntilDue === -1) return texts.overdueOne;
  return fill(texts.overdueMany, { count: Math.abs(daysUntilDue) });
}

export type DueTone = 'overdue' | 'soon' | 'later';

/** How urgent a due date is: past, within two weeks, or further out. */
export function dueTone(daysUntilDue: number): DueTone {
  if (daysUntilDue < 0) return 'overdue';
  return daysUntilDue <= 14 ? 'soon' : 'later';
}

/** Whole cents of a dollar amount: money is compared in cents so 0.1 + 0.2 equals 0.3. */
export function toCents(value: number): number {
  return Math.round(value * 100);
}

export function sameAmount(a: number, b: number): boolean {
  return toCents(a) === toCents(b);
}

/** Whole days from today to a `YYYY-MM-DD` date (negative once past), counted by calendar day. */
export function daysUntil(day: string, now: Date = new Date()): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(year, month - 1, date);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}
