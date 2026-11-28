/**
 * What an invoice's e-mail history, dates and payments say (phase 4, Rust
 * only): the "What happened" timeline, how often it was viewed, whether the
 * last e-mail bounced, how many days it is overdue and when the next reminder
 * is due. Pure functions, so the screens and the tests share one reading.
 */

import type {
  EmailHistoryEntry,
  ReminderClaim,
  ReminderSettings,
  ReminderStep,
} from '@/lib/api/domains/weldbooks-sales';

/** The part of an invoice these functions read. */
export interface ActivityInvoice {
  id: string;
  status: string;
  createdAt?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  sentAt?: string | null;
  viewedAt?: string | null;
  quoteId?: string | null;
  reminderLevel?: number | null;
  lastRemindedAt?: string | null;
  remindersPaused?: boolean | null;
  balanceDue?: string | number | null;
  emailHistory?: EmailHistoryEntry[] | null;
  payments?: ReadonlyArray<{ id: string; date: string; amount: string }> | null;
}

/** The statuses in which an invoice still waits for money. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['finalized', 'sent', 'partial', 'overdue']);

export function isOpenForPayment(invoice: Pick<ActivityInvoice, 'status' | 'balanceDue'>): boolean {
  return OPEN_STATUSES.has(invoice.status) && Number(invoice.balanceDue ?? 0) > 0;
}

export function historyOf(invoice: Pick<ActivityInvoice, 'emailHistory'>): EmailHistoryEntry[] {
  return Array.isArray(invoice.emailHistory) ? invoice.emailHistory : [];
}

/** How many times the customer opened the public page: the `viewed` entries, or one when only `viewedAt` is known. */
export function viewCount(invoice: Pick<ActivityInvoice, 'emailHistory' | 'viewedAt'>): number {
  const entries = historyOf(invoice).filter((entry) => entry.type === 'viewed').length;
  if (entries > 0) return entries;
  return invoice.viewedAt ? 1 : 0;
}

/** The moment of the last view, or null. */
export function lastViewedAt(invoice: Pick<ActivityInvoice, 'emailHistory' | 'viewedAt'>): string | null {
  const views = historyOf(invoice).filter((entry) => entry.type === 'viewed');
  return views.at(-1)?.at ?? invoice.viewedAt ?? null;
}

/** Whether the last delivery attempt (a send, a reminder or a bounce) was a bounce. */
export function isUndelivered(invoice: Pick<ActivityInvoice, 'emailHistory'>): boolean {
  const last = historyOf(invoice)
    .filter((entry) => entry.type === 'sent' || entry.type === 'reminder' || entry.type === 'bounced')
    .at(-1);
  return last?.type === 'bounced';
}

/** The error of the last bounce, when it says one. */
export function lastBounce(invoice: Pick<ActivityInvoice, 'emailHistory'>): EmailHistoryEntry | null {
  return historyOf(invoice).filter((entry) => entry.type === 'bounced').at(-1) ?? null;
}

/** Whether a public link was made and not withdrawn since. */
export function hasActiveLink(invoice: Pick<ActivityInvoice, 'emailHistory'>): boolean {
  const last = historyOf(invoice)
    .filter((entry) => entry.type === 'link' || entry.type === 'link_revoked')
    .at(-1);
  return last?.type === 'link';
}

/** When the current public link was made. */
export function linkMadeAt(invoice: Pick<ActivityInvoice, 'emailHistory'>): string | null {
  const last = historyOf(invoice)
    .filter((entry) => entry.type === 'link' || entry.type === 'link_revoked')
    .at(-1);
  return last?.type === 'link' ? last.at : null;
}

/** `2026-11-27` or an ISO timestamp, as a UTC day number. */
function dayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function todayNumber(now: Date): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
}

/** Whole days past the due date of an invoice that waits for money; 0 when it is not late. */
export function daysOverdue(invoice: Pick<ActivityInvoice, 'status' | 'balanceDue' | 'dueDate'>, now = new Date()): number {
  if (!isOpenForPayment(invoice) || !invoice.dueDate) return 0;
  const due = dayNumber(invoice.dueDate);
  if (due === null) return 0;
  return Math.max(0, todayNumber(now) - due);
}

/** `2026-11-27` plus days, as an ISO date. */
export function addDays(isoDate: string, days: number): string | null {
  const day = dayNumber(isoDate);
  if (day === null) return null;
  return new Date((day + days) * 86_400_000).toISOString().slice(0, 10);
}

export interface NextReminder {
  step: ReminderStep;
  /** The day the step is due: the due date plus its days after due. */
  date: string;
  /** Sent by the daily sweep; otherwise it waits in To process. */
  auto: boolean;
}

/**
 * The reminder that comes next: the first step after the invoice's level,
 * counted from the due date. Null when reminders are off or paused, the
 * invoice is not waiting for money, or every step went out.
 */
export function nextReminder(
  invoice: Pick<ActivityInvoice, 'status' | 'balanceDue' | 'dueDate' | 'reminderLevel' | 'remindersPaused'>,
  settings: Pick<ReminderSettings, 'enabled' | 'steps'> | undefined,
): NextReminder | null {
  if (!settings?.enabled || invoice.remindersPaused || !isOpenForPayment(invoice) || !invoice.dueDate) return null;
  const level = invoice.reminderLevel ?? 0;
  const step = [...settings.steps].sort((a, b) => a.level - b.level).find((candidate) => candidate.level > level);
  if (!step) return null;
  const date = addDays(invoice.dueDate, step.daysAfterDue);
  return date ? { step, date, auto: step.auto } : null;
}

/** The amount a final notice claims, as text, or null when it claims none. */
export function claimTotal(claim: ReminderClaim | undefined): string | null {
  if (claim === undefined || claim === null) return null;
  if (typeof claim === 'string' || typeof claim === 'number') return String(claim);
  return claim.total !== undefined ? String(claim.total) : null;
}

/** Whether a claim adds anything to the invoice: costs fall due, or interest is asked. */
export function claimAddsCosts(claim: ReminderClaim | undefined): boolean {
  if (!claim || typeof claim !== 'object') return false;
  return claim.costsDue === true || Number(claim.interest ?? 0) > 0;
}

export function recipients(to: string | readonly string[] | undefined): string {
  if (!to) return '';
  return typeof to === 'string' ? to : to.join(', ');
}

/** One event of the "What happened" timeline: data only, the screen words it. */
export type ActivityEvent =
  | { id: string; kind: 'created'; at: string | null; quoteId: string | null }
  | { id: string; kind: 'marked_sent'; at: string }
  | { id: string; kind: 'emailed'; at: string; to: string }
  | { id: string; kind: 'bounced'; at: string; to: string; error: string | null }
  | { id: string; kind: 'viewed'; at: string; count: number }
  | { id: string; kind: 'reminder'; at: string; level: number; to: string; claim: ReminderClaim | undefined }
  | { id: string; kind: 'link_revoked'; at: string }
  | { id: string; kind: 'payment'; at: string; amount: string; paidInFull: boolean }
  | { id: string; kind: 'online_started'; at: string; amount: string | null }
  | { id: string; kind: 'online_status'; at: string; status: OnlinePaymentStatus; method: string | null }
  | { id: string; kind: 'online_reversed'; at: string; reversal: 'refund' | 'chargeback'; amount: string }
  | { id: string; kind: 'next_reminder'; at: string; level: number; auto: boolean };

/** What the payment provider reported about an online payment. */
export type OnlinePaymentStatus = 'paid' | 'failed' | 'expired' | 'canceled' | 'pending' | 'authorized';

const byTime = (a: { at: string | null }, b: { at: string | null }) => (a.at ?? '').localeCompare(b.at ?? '');

/**
 * The timeline, oldest first and the planned reminder last: created (from a
 * quote), e-mailed or marked as sent, bounced, viewed (one entry with the
 * count), reminders, a withdrawn link, online payment events (started, paid or
 * failed, refunded or charged back), payments, and the next reminder when
 * the workflow sends it by itself.
 */
export function buildActivity(invoice: ActivityInvoice, settings?: Pick<ReminderSettings, 'enabled' | 'steps'>): ActivityEvent[] {
  const history = historyOf(invoice);
  const events: ActivityEvent[] = [];
  const created = invoice.createdAt ?? invoice.issueDate ?? null;
  events.push({ id: 'created', kind: 'created', at: created, quoteId: invoice.quoteId ?? null });

  history.forEach((entry, index) => {
    const id = `h${index}`;
    switch (entry.type) {
      case 'sent':
        events.push({ id, kind: 'emailed', at: entry.at, to: recipients(entry.to) });
        break;
      case 'bounced':
        events.push({ id, kind: 'bounced', at: entry.at, to: recipients(entry.to), error: entry.error ?? null });
        break;
      case 'reminder':
        events.push({
          id,
          kind: 'reminder',
          at: entry.at,
          level: entry.level ?? 1,
          to: recipients(entry.to),
          claim: entry.claim,
        });
        break;
      case 'link_revoked':
        events.push({ id, kind: 'link_revoked', at: entry.at });
        break;
      case 'payment_started':
        events.push({ id, kind: 'online_started', at: entry.at, amount: entry.amount === undefined ? null : String(entry.amount) });
        break;
      case 'payment_status':
        if (entry.status) events.push({ id, kind: 'online_status', at: entry.at, status: entry.status, method: entry.method ?? null });
        break;
      case 'payment_reversed':
        events.push({
          id,
          kind: 'online_reversed',
          at: entry.at,
          reversal: entry.kind === 'chargeback' ? 'chargeback' : 'refund',
          amount: String(entry.amount ?? '0'),
        });
        break;
      default:
        // `viewed` is folded into one entry below, `link` is not an event the owner cares about.
        break;
    }
  });

  // Marked as sent without an e-mail (Global's behaviour, or an invoice sent by hand).
  const emailed = history.some((entry) => entry.type === 'sent');
  if (invoice.sentAt && !emailed) events.push({ id: 'marked_sent', kind: 'marked_sent', at: invoice.sentAt });

  const views = viewCount(invoice);
  const lastView = lastViewedAt(invoice);
  if (views > 0 && lastView) events.push({ id: 'viewed', kind: 'viewed', at: lastView, count: views });

  const payments = [...(invoice.payments ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  payments.forEach((payment, index) => {
    events.push({
      id: `p-${payment.id}`,
      kind: 'payment',
      at: payment.date,
      amount: payment.amount,
      paidInFull: invoice.status === 'paid' && index === payments.length - 1,
    });
  });

  events.sort(byTime);

  const next = nextReminder(invoice, settings);
  if (next?.auto) events.push({ id: 'next_reminder', kind: 'next_reminder', at: next.date, level: next.step.level, auto: true });
  return events;
}
