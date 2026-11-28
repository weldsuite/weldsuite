import { describe, expect, it } from 'vitest';
import type { EmailHistoryEntry, ReminderSettings } from '@/lib/api/domains/weldbooks-sales';
import {
  addDays,
  buildActivity,
  claimAddsCosts,
  claimTotal,
  daysOverdue,
  hasActiveLink,
  isUndelivered,
  lastViewedAt,
  nextReminder,
  viewCount,
} from './invoice-activity';

const at = (hour: number) => `2026-11-0${hour}T10:00:00.000Z`;
const entry = (type: EmailHistoryEntry['type'], hour: number, extra: Partial<EmailHistoryEntry> = {}): EmailHistoryEntry => ({
  type,
  at: at(hour),
  ...extra,
});

const settings: Pick<ReminderSettings, 'enabled' | 'steps'> = {
  enabled: true,
  steps: [
    { level: 1, daysAfterDue: 7, auto: true, template: 'reminder1', final: false },
    { level: 2, daysAfterDue: 21, auto: false, template: 'reminder2', final: false },
    { level: 3, daysAfterDue: 35, auto: false, template: 'reminder3', final: true },
  ],
};

const open = { status: 'sent', balanceDue: '100.00', dueDate: '2026-11-10', reminderLevel: 0, remindersPaused: false };

describe('views, bounces and the link', () => {
  it('counts the viewed entries, or one when only viewedAt is known', () => {
    expect(viewCount({ emailHistory: [entry('viewed', 2), entry('sent', 1), entry('viewed', 3)], viewedAt: null })).toBe(2);
    expect(viewCount({ emailHistory: [], viewedAt: at(2) })).toBe(1);
    expect(viewCount({ emailHistory: undefined, viewedAt: null })).toBe(0);
    expect(lastViewedAt({ emailHistory: [entry('viewed', 2), entry('viewed', 4)], viewedAt: at(2) })).toBe(at(4));
  });

  it('is undelivered while the last send, reminder or bounce is a bounce', () => {
    expect(isUndelivered({ emailHistory: [entry('sent', 1), entry('bounced', 2)] })).toBe(true);
    // Being opened does not undo it; a later send that went through does.
    expect(isUndelivered({ emailHistory: [entry('sent', 1), entry('bounced', 2), entry('viewed', 3)] })).toBe(true);
    expect(isUndelivered({ emailHistory: [entry('bounced', 1), entry('reminder', 2)] })).toBe(false);
    expect(isUndelivered({ emailHistory: [] })).toBe(false);
  });

  it('has an active link until the last link entry is a revocation', () => {
    expect(hasActiveLink({ emailHistory: [entry('link', 1)] })).toBe(true);
    expect(hasActiveLink({ emailHistory: [entry('link', 1), entry('link_revoked', 2)] })).toBe(false);
    expect(hasActiveLink({ emailHistory: [entry('link', 1), entry('link_revoked', 2), entry('link', 3)] })).toBe(true);
    expect(hasActiveLink({ emailHistory: null })).toBe(false);
  });
});

describe('days overdue', () => {
  const now = new Date(2026, 10, 22, 12, 0, 0); // 22 November 2026, local

  it('counts whole days past the due date of an invoice that waits for money', () => {
    expect(daysOverdue({ status: 'overdue', balanceDue: '50', dueDate: '2026-11-10' }, now)).toBe(12);
    expect(daysOverdue({ status: 'partial', balanceDue: '50', dueDate: '2026-11-21T00:00:00Z' }, now)).toBe(1);
  });

  it('is zero when it is not late, paid, a draft or without a due date', () => {
    expect(daysOverdue({ status: 'sent', balanceDue: '50', dueDate: '2026-12-01' }, now)).toBe(0);
    expect(daysOverdue({ status: 'paid', balanceDue: '0', dueDate: '2026-11-01' }, now)).toBe(0);
    expect(daysOverdue({ status: 'draft', balanceDue: '50', dueDate: '2026-11-01' }, now)).toBe(0);
    expect(daysOverdue({ status: 'overdue', balanceDue: '50', dueDate: null }, now)).toBe(0);
  });

  it('adds days to an ISO date', () => {
    expect(addDays('2026-11-30', 7)).toBe('2026-12-07');
    expect(addDays('nonsense', 7)).toBeNull();
  });
});

describe('the next reminder', () => {
  it('is the first step after the invoice level, counted from the due date', () => {
    expect(nextReminder(open, settings)).toMatchObject({ date: '2026-11-17', auto: true, step: { level: 1 } });
    expect(nextReminder({ ...open, reminderLevel: 1 }, settings)).toMatchObject({ date: '2026-12-01', auto: false, step: { level: 2 } });
  });

  it('is none when reminders are off or paused, the invoice is settled, or every step went out', () => {
    expect(nextReminder(open, { ...settings, enabled: false })).toBeNull();
    expect(nextReminder(open, undefined)).toBeNull();
    expect(nextReminder({ ...open, remindersPaused: true }, settings)).toBeNull();
    expect(nextReminder({ ...open, status: 'paid', balanceDue: '0' }, settings)).toBeNull();
    expect(nextReminder({ ...open, reminderLevel: 3 }, settings)).toBeNull();
  });
});

describe('what a final notice claims', () => {
  it('reads the total of the claim and whether it adds anything', () => {
    expect(claimTotal({ total: '1161.40', costsDue: true })).toBe('1161.40');
    expect(claimTotal(undefined)).toBeNull();
    expect(claimTotal('12.00')).toBe('12.00');
    expect(claimAddsCosts({ costsDue: true })).toBe(true);
    expect(claimAddsCosts({ interest: '3.20' })).toBe(true);
    // The 14-day notice only announces the costs.
    expect(claimAddsCosts({ isNotice: true, costsDue: false, interest: '0.00' })).toBe(false);
    expect(claimAddsCosts(undefined)).toBe(false);
  });
});

describe('the timeline', () => {
  it('lists created, e-mailed, viewed once with the count, a reminder and the payment, oldest first', () => {
    const events = buildActivity(
      {
        id: 'inv_1',
        status: 'paid',
        createdAt: at(1),
        quoteId: 'q_1',
        balanceDue: '0',
        dueDate: '2026-11-10',
        emailHistory: [entry('link', 2), entry('sent', 2, { to: ['a@b.test'] }), entry('viewed', 3), entry('viewed', 4), entry('reminder', 5, { level: 1, to: ['a@b.test'] })],
        payments: [{ id: 'pay_1', date: '2026-11-06', amount: '100.00' }],
      },
      settings,
    );
    expect(events.map((event) => event.kind)).toEqual(['created', 'emailed', 'viewed', 'reminder', 'payment']);
    expect(events[0]).toMatchObject({ quoteId: 'q_1' });
    expect(events[1]).toMatchObject({ to: 'a@b.test' });
    expect(events[2]).toMatchObject({ count: 2, at: at(4) });
    expect(events[4]).toMatchObject({ paidInFull: true });
  });

  it('shows a send marked by hand when no e-mail was recorded, and a bounce', () => {
    const marked = buildActivity({ id: 'i', status: 'sent', createdAt: at(1), sentAt: at(2), balanceDue: '10', dueDate: null }, undefined);
    expect(marked.map((event) => event.kind)).toEqual(['created', 'marked_sent']);

    const bounced = buildActivity(
      { id: 'i', status: 'sent', createdAt: at(1), sentAt: at(2), balanceDue: '10', dueDate: null, emailHistory: [entry('sent', 2, { to: 'a@b.test' }), entry('bounced', 2, { to: 'a@b.test', error: 'mailbox full' })] },
      undefined,
    );
    expect(bounced.map((event) => event.kind)).toEqual(['created', 'emailed', 'bounced']);
    expect(bounced[2]).toMatchObject({ error: 'mailbox full' });
  });

  it('ends with the next reminder when the workflow sends it by itself, and not when it is manual', () => {
    const base = { id: 'i', status: 'sent', createdAt: at(1), balanceDue: '10', dueDate: '2026-11-10', reminderLevel: 0 };
    expect(buildActivity(base, settings).at(-1)).toMatchObject({ kind: 'next_reminder', level: 1, at: '2026-11-17' });
    expect(buildActivity({ ...base, reminderLevel: 1 }, settings).map((event) => event.kind)).toEqual(['created']);
  });
});

describe('the timeline of online payments', () => {
  const base = { id: 'i', status: 'sent', createdAt: at(1), balanceDue: '10', dueDate: '2026-11-10', reminderLevel: 0 };

  it('tells a payment from the start to a refund, in order', () => {
    const events = buildActivity({
      ...base,
      emailHistory: [
        entry('payment_started', 2, { amount: '100.00', molliePaymentId: 'tr_1' }),
        entry('payment_status', 3, { status: 'paid', method: 'ideal' }),
        entry('payment_reversed', 4, { kind: 'refund', amount: '25.00' }),
      ],
    });
    expect(events.map((event) => event.kind)).toEqual(['created', 'online_started', 'online_status', 'online_reversed']);
    expect(events[1]).toMatchObject({ amount: '100.00' });
    expect(events[2]).toMatchObject({ status: 'paid', method: 'ideal' });
    expect(events[3]).toMatchObject({ reversal: 'refund', amount: '25.00' });
  });

  it('keeps a failed, expired and cancelled payment, and tells a chargeback from a refund', () => {
    const events = buildActivity({
      ...base,
      emailHistory: [
        entry('payment_status', 2, { status: 'failed' }),
        entry('payment_status', 3, { status: 'expired' }),
        entry('payment_status', 4, { status: 'canceled' }),
        entry('payment_reversed', 5, { kind: 'chargeback', amount: 12 }),
      ],
    });
    expect(events.slice(1).map((event) => (event.kind === 'online_status' ? event.status : event.kind))).toEqual([
      'failed',
      'expired',
      'canceled',
      'online_reversed',
    ]);
    expect(events.at(-1)).toMatchObject({ reversal: 'chargeback', amount: '12' });
  });

  it('skips a status entry without a status', () => {
    expect(buildActivity({ ...base, emailHistory: [entry('payment_status', 2)] }).map((event) => event.kind)).toEqual(['created']);
  });
});
