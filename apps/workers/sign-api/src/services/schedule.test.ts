import { describe, expect, it } from 'vitest';
import { DEFAULT_REMINDER_MAX, nextReminderAt } from './schedule';

const DAY = 86_400_000;
const sent = new Date('2026-11-01T10:00:00Z');
const at = (days: number) => new Date(sent.getTime() + days * DAY);
const settings = { reminderAfterDays: 3, reminderEveryDays: 2, reminderMaxCount: 3, expiresAt: at(30) };
const current = { role: 'signer' as const, status: 'sent' as const, sentAt: sent, lastRemindedAt: null, remindersSent: 0 };

describe('nextReminderAt', () => {
  it('waits the first delay, then the interval after the last reminder', () => {
    expect(nextReminderAt(settings, current)).toEqual(at(3));
    expect(nextReminderAt(settings, { ...current, lastRemindedAt: at(3), remindersSent: 1 })).toEqual(at(5));
  });

  it('pushes the next one a full interval past a reminder sent by hand', () => {
    expect(nextReminderAt(settings, { ...current, lastRemindedAt: at(2.5) })).toEqual(at(4.5));
    // A reminder by hand long before the first one is due does not bring it forward.
    expect(nextReminderAt(settings, { ...current, lastRemindedAt: at(0.1) })).toEqual(at(3));
  });

  it('stops at the maximum, at the expiry, when reminders are off, and for anyone not on their turn', () => {
    expect(nextReminderAt(settings, { ...current, lastRemindedAt: at(7), remindersSent: 3 })).toBeNull();
    expect(nextReminderAt({ ...settings, expiresAt: at(3) }, current)).toBeNull();
    expect(nextReminderAt({ ...settings, reminderAfterDays: null }, current)).toBeNull();
    expect(nextReminderAt({ ...settings, reminderMaxCount: 0 }, current)).toBeNull();
    expect(nextReminderAt(settings, { ...current, status: 'signed' })).toBeNull();
    expect(nextReminderAt(settings, { ...current, status: 'pending', sentAt: null })).toBeNull();
    expect(nextReminderAt(settings, { ...current, role: 'cc' })).toBeNull();
  });

  it('uses the first delay again when there is no interval, and a default maximum', () => {
    const once = { ...settings, reminderEveryDays: null, reminderMaxCount: null };
    expect(nextReminderAt(once, { ...current, lastRemindedAt: at(3), remindersSent: 1 })).toEqual(at(6));
    expect(nextReminderAt(once, { ...current, lastRemindedAt: at(9), remindersSent: DEFAULT_REMINDER_MAX })).toBeNull();
  });
});
