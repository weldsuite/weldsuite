/**
 * Small pure helpers of the contact page: amounts per currency, and how a
 * timeline item reads and where it leads.
 */
import type { CurrencySum, TimelineItem } from '@/lib/api/domains/weldbooks-contact-page';
import type { ActivityTone } from '@weldsuite/ui/components/activity-timeline';

export type MoneyFormatter = (value: number | string | null | undefined, currency?: string | null) => string;

/** The sums with something in them: a currency at zero is not worth a line. */
export function nonZero(sums: readonly CurrencySum[] | undefined): CurrencySum[] {
  return (sums ?? []).filter((sum) => Number(sum.amount) !== 0);
}

/** How many documents the sums stand for. */
export function countOf(sums: readonly CurrencySum[] | undefined): number {
  return (sums ?? []).reduce((total, sum) => total + (sum.count ?? 0), 0);
}

/**
 * An amount per currency as a tile shows it: the first currency in full and
 * the others after it, so a contact owing in two currencies reads as
 * "€1,815.00" and "+ $200.00", not as a wrong total. `fallback` is shown for none.
 */
export function describeSums(
  sums: readonly CurrencySum[] | undefined,
  formatMoney: MoneyFormatter,
  fallbackCurrency?: string | null,
): { primary: string; others: string[]; isEmpty: boolean } {
  const filled = nonZero(sums);
  if (filled.length === 0) return { primary: formatMoney(0, fallbackCurrency ?? undefined), others: [], isEmpty: true };
  const [first, ...rest] = filled;
  return {
    primary: formatMoney(first!.amount, first!.currency),
    others: rest.map((sum) => formatMoney(sum.amount, sum.currency)),
    isEmpty: false,
  };
}

/** The marker colour of a timeline item: what needs attention is loud, the rest calm. */
export function timelineTone(item: Pick<TimelineItem, 'type' | 'hint' | 'status'>): ActivityTone {
  if (item.type === 'email_bounced' || item.hint === 'overdue' || item.hint === 'expired') return 'danger';
  if (item.type === 'reminder') return 'warning';
  if (item.hint === 'paid' || item.hint === 'received' || item.status === 'paid' || item.status === 'accepted') {
    return 'success';
  }
  if (item.type === 'email_viewed' || item.type === 'email_sent') return 'info';
  return 'neutral';
}

/** The `level:N` hint of a reminder as the number, or null. */
export function reminderLevel(hint: string | null | undefined): number | null {
  const match = /^level:(\d+)$/.exec(hint ?? '');
  return match ? Number(match[1]) : null;
}
